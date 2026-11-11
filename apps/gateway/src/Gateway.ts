/**
 * The gateway, composed from a parsed config: every device's pipeline under a
 * supervisor, the health reporter, and MQTT behind the SQLite outbox. `main.ts`
 * runs it on Node's network; the simulation (`test/sim`) runs the same
 * composition on an in-memory network under the test clock.
 */
import { type BacnetClient, covTimingFor, makeBacnetDriverFromClient, makeBacnetNetwork } from "@ot-gateway/bacnet"
import { BufferedPublisher, type BufferedPublisherOptions, openDatabase, type OutboxDatabase } from "@ot-gateway/buffer"
import {
  commandFilter,
  covPointIds,
  cycleTimeoutMs,
  type DriverRegistry,
  makeCommandGuard,
  makeDriverRegistry,
  type Device,
  type Driver,
  type GatewayConfig,
  type HealthRegistry,
  healthTopic,
  type HistorySink,
  makeHealthRegistry,
  type Network,
  onlinePayload,
  type PublishOptions,
  Publisher,
  runDevice,
  runHealthReporter,
  superviseDevice,
  withMetricAttributes,
  bufferRows,
  configApplies
} from "@ot-gateway/core"
import { endpointOf, makeModbusDriverFromClient, makeModbusLinks, type ModbusLink } from "@ot-gateway/modbus"
import { MqttPublisher } from "@ot-gateway/mqtt"
import { makeSimulatorDriver } from "@ot-gateway/simulator"
import { ConfigApplyFailed, type ConfigChange } from "@ot-gateway/api"
import { type History, openHistory } from "@ot-gateway/history"
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  Queue,
  Result,
  Schedule,
  Schema,
  Scope
} from "effect"
import { describeConfigChange } from "./ConfigChange.ts"
import { type ConfigFileSource, makeConfigEditor } from "./ConfigEditor.ts"
import { type CommandRouting, makeCommandRouting } from "./Commands.ts"
import { gatewayEventsLayer, GatewayEvents, type GatewayEventsShape } from "./Events.ts"
import { keepRunning } from "./KeepRunning.ts"
import { makeStaleMetaCleaner, type StaleMetaCleaner } from "./StaleMeta.ts"
import { type HostMonitor, type HostSources, hostHealth, makeHostMonitor } from "./Host.ts"
import { historyHandler, makeStatusState, serveStatus, type StatusState, switchableStatus } from "./Status.ts"
import { traceSampleRatio, tracesExported } from "./Telemetry.ts"

export interface GatewayOptions {
  /** Reach devices and the broker through this network instead of Node's. */
  readonly network?: Network
  /** Options for the outbox (a simulation injects disk faults through them). */
  readonly buffer?: BufferedPublisherOptions
  /** Told about every message the publisher accepted (stored or sent), after it did. */
  readonly onAccepted?: (topic: string, payload: string, options: PublishOptions | undefined) => void
  /** Watch the process and the machine through these (`liveHostSources`); without them, nothing is sampled. */
  readonly host?: HostSources
  /** The gateway's version, for telemetry. */
  readonly version?: string
  /**
   * The file `config` came from: the status page may edit it, and a config saved there runs without a restart.
   * Without it (the demo, a test) the page is read-only.
   */
  readonly configFile?: ConfigFileSource
}

/**
 * Commands on their way to the guard: the drivers of the running devices,
 * and the routing from MQTT to them (none when no point is writable, so the
 * gateway does not even subscribe).
 */
interface Commands {
  readonly drivers: DriverRegistry
  readonly routing: CommandRouting | undefined
}

/** The gateway's BACnet/IP endpoint, once its socket is open; absent without BACnet devices. */
type BacnetNetwork = Deferred.Deferred<BacnetClient> | undefined

/**
 * Open the BACnet/IP endpoint, retrying with backoff up to every 5 minutes:
 * the port may be held by another program for a while, or the bind address
 * not be assigned yet at boot. Until then the BACnet devices report
 * `connection` in the health topic. Each attempt gets its own scope, so a
 * failed one leaves no socket behind.
 */
const openBacnet = Effect.fn("openBacnet")(function* (
  config: GatewayConfig,
  health: HealthRegistry,
  endpoint: Deferred.Deferred<BacnetClient>,
  network: Network | undefined
) {
  const gatewayScope = yield* Effect.scope
  const bacnetDevices = config.devices.filter((device) => device.protocol === "bacnet-ip")
  const attempt = Effect.gen(function* () {
    const scope = yield* Scope.fork(gatewayScope)
    return yield* makeBacnetNetwork(config.bacnet, network).pipe(
      Scope.provide(scope),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)))
    )
  })
  const client = yield* attempt.pipe(
    Effect.tapError((error) =>
      Effect.all([
        Effect.map(Clock.currentTimeMillis, (at) =>
          bacnetDevices.forEach((device) =>
            health.recordFailure(device.id, {
              reason: "connection",
              message: `the gateway's BACnet/IP port ${config.bacnet.port} cannot be opened: ${error.message}`,
              at
            })
          )
        ),
        Effect.logError("could not open the BACnet/IP endpoint, trying again").pipe(
          Effect.annotateLogs({ port: config.bacnet.port, error: error.message })
        )
      ])
    ),
    Effect.retry(Schedule.min([Schedule.exponential("5 seconds"), Schedule.spaced("5 minutes")]))
  )
  yield* Deferred.succeed(endpoint, client)
})

const runOne = (
  config: GatewayConfig,
  device: Device,
  sampleRatio: number,
  health: HealthRegistry,
  bacnet: BacnetNetwork,
  network: Network | undefined,
  drivers: DriverRegistry,
  modbusLinks: ReadonlyMap<string, ModbusLink>,
  reads: HistorySink | undefined
) => {
  /** Poll the device, and take commands for it while doing so. */
  const run = (driver: Driver) => Effect.andThen(drivers.register(driver), runDevice(ctx, driver))
  const ctx = {
    site: config.site,
    building: config.building,
    pollIntervalMs: device.pollIntervalMs,
    cycleTimeoutMs: cycleTimeoutMs(device),
    ...(device.publish === undefined ? {} : { publish: device.publish }),
    traceSampleRatio: sampleRatio,
    health,
    ...(reads === undefined ? {} : { history: reads }),
    covPoints: covPointIds(device)
  }
  switch (device.protocol) {
    case "simulator":
      return runDevice(ctx, makeSimulatorDriver(device))
    case "modbus-tcp": {
      // The connection belongs to the device's endpoint, shared with any other device behind the same gateway.
      const link = modbusLinks.get(endpointOf(device))
      if (link === undefined) return Effect.die(new Error(`no Modbus link for ${device.id}`))
      return run(makeModbusDriverFromClient(device, link.unit(device.unitId)))
    }
    case "bacnet-ip": {
      if (bacnet === undefined) return Effect.void
      // All BACnet devices share the gateway's one UDP socket, once it is open.
      return Deferred.await(bacnet).pipe(
        Effect.flatMap((client) =>
          makeBacnetDriverFromClient(device, client, { cov: covTimingFor(config.bacnet.covLifetimeSeconds) })
        ),
        Effect.flatMap(run),
        Effect.scoped,
        Effect.catchTag("DriverError", (error) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            health.recordFailure(device.id, { reason: error.reason, message: error.message, at })
            yield* Effect.logError("BACnet device not started").pipe(
              Effect.annotateLogs({ device: device.id, error: error.message })
            )
          })
        )
      )
    }
  }
}

interface GatewayHealth {
  readonly topic: string
  readonly registry: HealthRegistry
  readonly online: Effect.Effect<string>
}

const runDevices = Effect.fn("runGateway")(function* (
  config: GatewayConfig,
  health: GatewayHealth,
  network: Network | undefined,
  commands: Commands,
  reads: HistorySink | undefined,
  staleMeta: StaleMetaCleaner
) {
  const sampleRatio = yield* traceSampleRatio
  // The sample ratio only when traces are exported: without an exporter it describes nothing.
  const sampling = (yield* tracesExported) ? { traceSampleRatio: sampleRatio } : {}
  yield* Effect.log(`OT Gateway starting: ${config.site}/${config.building}, ${config.devices.length} device(s)`).pipe(
    Effect.annotateLogs({ ...sampling, health: health.topic })
  )
  let bacnet: BacnetNetwork
  if (config.devices.some((device) => device.protocol === "bacnet-ip")) {
    bacnet = yield* Deferred.make<BacnetClient>()
    yield* openBacnet(config, health.registry, bacnet, network).pipe(Effect.forkScoped)
  }
  // One connection per Modbus endpoint, for as long as the gateway runs; each opens on its first request.
  const modbusLinks = yield* makeModbusLinks(
    config.devices.filter((device) => device.protocol === "modbus-tcp"),
    network === undefined ? {} : { network }
  )
  yield* Effect.all(
    [
      keepRunning(
        "health reporter",
        runHealthReporter({
          topic: health.topic,
          intervalMs: config.healthIntervalMs,
          online: health.online,
          registry: health.registry
        })
      ),
      // A bug in one device's pipeline restarts that device only; suspended, so a restart builds a fresh driver.
      ...config.devices.map((device) =>
        superviseDevice(
          Effect.suspend(() =>
            runOne(config, device, sampleRatio, health.registry, bacnet, network, commands.drivers, modbusLinks, reads)
          ),
          { deviceId: device.id, health: health.registry }
        )
      ),
      keepRunning("stale metadata", staleMeta.run),
      // A command at a time per device, each with its own deadline; devices do not wait for each other.
      ...(commands.routing === undefined ? [] : [keepRunning("command guard", commands.routing.run)])
    ],
    { concurrency: "unbounded", discard: true }
  )
})

/** MQTT, behind a SQLite outbox when `buffer` is configured. */
const northbound = (
  config: GatewayConfig,
  health: GatewayHealth,
  options: GatewayOptions,
  routing: CommandRouting | undefined,
  status: StatusState | undefined,
  staleMeta: StaleMetaCleaner,
  events: GatewayEventsShape,
  start: StartWatch
) => {
  // What waits in the buffer when the broker comes back, for the event.
  const bufferedRows = Effect.map(
    Metric.value(Metric.withAttributes(bufferRows, { site: config.site, building: config.building })),
    (gauge) => Math.max(0, gauge.value)
  )
  // Retain As Published, so a command published retained is seen as such even live, and refused.
  // No Local, so nothing the gateway publishes itself is ever taken for a command.
  const commandSubscriptions =
    routing === undefined
      ? []
      : [
          {
            filter: commandFilter(config.site, config.building),
            qos: 1 as const,
            retainAsPublished: true,
            noLocal: true
          }
        ]
  const mqtt = MqttPublisher(config.mqtt, {
    health: { topic: health.topic, online: health.online },
    // With a buffer, a value that cannot go out now is stored, so waiting for the broker would only stall reads.
    waitForConnection: config.buffer === undefined,
    onConnected: (connection) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        status?.recordBrokerConnection(at, connection)
        events.brokerConnected(config.buffer === undefined ? undefined : yield* bufferedRows)
        yield* Deferred.succeed(start.brokerConnected, undefined)
      }),
    onDisconnected: (failure) =>
      Effect.map(Clock.currentTimeMillis, (at) => {
        status?.recordBrokerFailure(at, failure.error)
        events.brokerDisconnected(failure.error)
        start.brokerError = failure.error
      }),
    ...(options.network === undefined ? {} : { network: options.network }),
    subscriptions: [...commandSubscriptions, ...staleMeta.subscriptions],
    // A `$meta` topic is never a command topic (`.../$set`), so each message has one taker.
    onMessage: (message) =>
      message.topic.endsWith("/$meta")
        ? staleMeta.onMessage(message)
        : routing === undefined
          ? Effect.void
          : routing.onMessage(message)
  })
  const publisher =
    config.buffer === undefined
      ? mqtt
      : BufferedPublisher(config.buffer, {
          ...options.buffer,
          // A config applied from the page must open its buffer; at start the gateway runs unbuffered instead.
          requireOpen: start.requireBuffer,
          onDrained: Effect.sync(() => events.bufferDrained())
        }).pipe(Layer.provide(mqtt))
  const onAccepted = options.onAccepted
  if (onAccepted === undefined && status === undefined) return publisher
  return Layer.effect(
    Publisher,
    Effect.gen(function* () {
      const inner = yield* Publisher
      return Publisher.of({
        publish: (topic, payload, publishOptions) =>
          // The status page sees every value read, delivered or not: it matters most while the broker is down.
          Effect.flatMap(Clock.currentTimeMillis, (at) =>
            Effect.sync(() => status?.recordPublish(topic, payload, { retained: publishOptions?.retain === true, at }))
          ).pipe(
            Effect.andThen(inner.publish(topic, payload, publishOptions)),
            Effect.tap(() => Effect.sync(() => onAccepted?.(topic, payload, publishOptions)))
          )
      })
    })
  ).pipe(Layer.provide(publisher))
}

/** What a start is told, and tells back: whether its buffer must open, and its first broker connect or last error. */
interface StartWatch {
  readonly requireBuffer: boolean
  readonly brokerConnected: Deferred.Deferred<void>
  brokerError: string | undefined
}

/**
 * How long a config applied from the page has to reach its broker when the broker settings changed; well inside
 * the status server's 30 s request deadline, since the page waits for the answer.
 */
const BROKER_START_TIMEOUT = "10 seconds"

/** A config that did not start; `message` says why. */
class StartFailed extends Schema.TaggedError<StartFailed>()("StartFailed", { message: Schema.String }) {}

/** What outlives a config: the events, the history, the host monitor and the status page's server. */
interface Shared {
  readonly options: GatewayOptions
  readonly events: GatewayEventsShape
  readonly startedAt: number
  readonly host: HostMonitor | undefined
  readonly history: History | undefined
  /** Whether the status page is served, so that each config keeps a status state for it. */
  readonly serving: boolean
  /** The gateway's scope: each config runs in a scope of its own inside it. */
  readonly scope: Scope.Scope
  /** Failed by a config's devices fiber when it fails or dies: the gateway stops, as it did before reloads. */
  readonly fatal: Deferred.Deferred<never, DevicesError>
}

/** What the devices of a config can fail with (reading telemetry settings from the environment). */
type DevicesError = Effect.Error<ReturnType<typeof runDevices>>

/** A config, running: its devices, health reporter, MQTT and buffer, all closed with `scope`. */
interface Running {
  readonly config: GatewayConfig
  readonly scope: Scope.Closeable
  readonly status: StatusState | undefined
}

/**
 * Open the outbox at `path` now, and hand it to the buffer when the buffer asks for its first database; later asks
 * (a reopen after the file went bad) open afresh. Closed with `scope` if the buffer never took it.
 */
const openBufferFirst = Effect.fnUntraced(function* (
  path: string,
  bufferOptions: BufferedPublisherOptions | undefined,
  scope: Scope.Scope
) {
  const open = bufferOptions?.openDatabase ?? openDatabase
  let waiting: OutboxDatabase | undefined = yield* open(path)
  yield* Scope.addFinalizer(
    scope,
    Effect.suspend(() => (waiting === undefined ? Effect.void : waiting.close))
  )
  return {
    ...bufferOptions,
    openDatabase: (requested: string) => {
      const database = waiting
      waiting = undefined
      return database === undefined || requested !== path ? open(requested) : Effect.succeed(database)
    }
  } satisfies BufferedPublisherOptions
})

/**
 * Start `config`: health, commands, MQTT and the buffer, then every device. Its resources live in a scope of their
 * own, closed to stop it: the devices first (the BACnet/IP socket closes before the broker connection does), then
 * the buffer, written to disk and closed, then MQTT with a clean goodbye.
 */
const startConfig = Effect.fn("Gateway.startConfig")(function* (
  config: GatewayConfig,
  shared: Shared,
  watch: { readonly requireBuffer: boolean; readonly awaitBroker: boolean }
) {
  const { events, options, startedAt } = shared
  const registry = makeHealthRegistry(config.devices.map((device) => device.id))
  // The registry lives as long as this config runs, so the listener needs no removal.
  registry.onChange(events.deviceChanged)
  const latestHost = () => shared.host?.latest()
  const health: GatewayHealth = {
    topic: healthTopic(config.site, config.building, config.id),
    registry,
    online: Effect.map(Clock.currentTimeMillis, (now) => {
      const snapshot = latestHost()
      return onlinePayload(registry, startedAt, now, snapshot === undefined ? undefined : hostHealth(snapshot))
    })
  }
  const status = shared.serving
    ? makeStatusState(config, registry, startedAt, { latest: latestHost, version: options.version ?? "unknown" })
    : undefined
  const drivers = makeDriverRegistry()
  const clock = yield* Clock.clockWith(Effect.succeed)
  const guard = makeCommandGuard({
    site: config.site,
    building: config.building,
    devices: config.devices,
    drivers,
    ...(status === undefined
      ? {}
      : { onOutcome: (command, outcome) => status.recordCommand(clock.currentTimeMillisUnsafe(), command, outcome) })
  })
  const writable = config.devices.some((device) => device.points.some((point) => point.writable))
  const commands: Commands = {
    drivers,
    routing: writable ? yield* makeCommandRouting(config, guard.handle) : undefined
  }
  const staleMeta = yield* makeStaleMetaCleaner(config)
  // Every read goes to the history and to the status page, whichever are on.
  const sinks = [shared.history?.sink, status?.reads].filter((sink) => sink !== undefined)
  const reads: HistorySink | undefined =
    sinks.length === 0
      ? undefined
      : { record: (device, point, value, ts) => sinks.forEach((sink) => sink.record(device, point, value, ts)) }
  const start: StartWatch = {
    requireBuffer: watch.requireBuffer,
    brokerConnected: yield* Deferred.make<void>(),
    brokerError: undefined
  }
  // The broker connection's metrics carry site and building too.
  const attributes = withMetricAttributes({ site: config.site, building: config.building })
  const scope = yield* Scope.fork(shared.scope)
  // A config from the page opens its outbox before it dials the broker: one whose file cannot open never connects,
  // so it leaves no will message (a retained "offline") behind under a site that never ran.
  const buffer =
    watch.requireBuffer && config.buffer !== undefined
      ? yield* openBufferFirst(config.buffer.path, options.buffer, scope).pipe(
          Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)))
        )
      : options.buffer
  const northboundServices = yield* Layer.buildWithScope(
    Layer.fresh(
      northbound(
        config,
        health,
        buffer === undefined ? options : { ...options, buffer },
        commands.routing,
        status,
        staleMeta,
        events,
        start
      )
    ),
    scope
  ).pipe(
    attributes,
    Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)))
  )
  yield* runDevices(config, health, options.network, commands, reads, staleMeta).pipe(
    Effect.scoped,
    Effect.provideContext(northboundServices),
    attributes,
    // Stopped for a new config, it is interrupted; anything else ends the gateway, as a defect always did.
    Effect.onExit((exit) =>
      Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
        ? Deferred.failCause(shared.fatal, exit.cause)
        : Effect.void
    ),
    Effect.forkIn(scope)
  )
  if (watch.awaitBroker) {
    const connected = yield* Deferred.await(start.brokerConnected).pipe(Effect.timeoutOption(BROKER_START_TIMEOUT))
    if (Option.isNone(connected)) {
      yield* Scope.close(scope, Exit.void)
      return yield* new StartFailed({
        message: `the broker at ${config.mqtt.url} did not accept the connection within ${BROKER_START_TIMEOUT}${
          start.brokerError === undefined ? "" : `: ${start.brokerError}`
        }`
      })
    }
  }
  return { config, scope, status } satisfies Running
})

/**
 * Start a config from the page, or say in a line why it did not: a typed failure (the buffer's file, the broker) or
 * a defect, since either way the previous config has to run again.
 */
const tryStart = (config: GatewayConfig, shared: Shared, watch: Parameters<typeof startConfig>[2]) =>
  startConfig(config, shared, watch).pipe(
    Effect.mapError((error) => error.message),
    Effect.catchDefect((defect) => Effect.fail(defect instanceof Error ? defect.message : String(defect))),
    Effect.result
  )

/** A config to apply, from the page, and where its outcome goes. */
interface ApplyRequest {
  readonly config: GatewayConfig
  readonly done: Deferred.Deferred<ConfigChange, ConfigApplyFailed>
}

/**
 * Run the gateway for `config` until interrupted; its sockets and the outbox close with it. With
 * `options.configFile`, the status page can edit that file, and a saved config is applied without a restart.
 */
export const runGateway = Effect.fn("Gateway")(
  function* (config: GatewayConfig, options: GatewayOptions = {}) {
    const startedAt = yield* Clock.currentTimeMillis
    const events = yield* GatewayEvents
    events.started(options.version ?? "unknown", config.devices.length)
    const host =
      options.host === undefined
        ? undefined
        : yield* makeHostMonitor(options.host, {
            version: options.version ?? "unknown",
            ...(config.buffer === undefined ? {} : { bufferPath: config.buffer.path })
          })
    // Open before the devices start, so their first reads are kept; closed after they stop, writing what waits.
    const history = config.history === undefined ? undefined : yield* openHistory(config.history)
    const shared: Shared = {
      options,
      events,
      startedAt,
      host,
      history,
      serving: config.status !== undefined,
      scope: yield* Effect.scope,
      fatal: yield* Deferred.make<never, DevicesError>()
    }
    let running: Running = yield* startConfig(config, shared, { requireBuffer: false, awaitBroker: false })
    const status = running.status === undefined ? undefined : switchableStatus(running.status)
    if (host !== undefined) yield* keepRunning("host monitor", host.run).pipe(Effect.forkScoped)

    // Configs saved from the page, applied here, one at a time, in the gateway's own fiber and scope.
    const requests = yield* Queue.bounded<ApplyRequest>(1)
    const apply = Effect.fn("Gateway.applyConfig")(function* (next: GatewayConfig) {
      const previous = running
      const change = describeConfigChange(previous.config, next)
      yield* Effect.annotateCurrentSpan({ changes: change.summary })
      if (change.changes.length === 0) return change
      yield* Scope.close(previous.scope, Exit.void)
      // A changed broker must answer before the config counts as applied; an unchanged one may be away for now.
      const awaitBroker = JSON.stringify(previous.config.mqtt) !== JSON.stringify(next.mqtt)
      const started = yield* tryStart(next, shared, { requireBuffer: true, awaitBroker })
      if (Result.isSuccess(started)) {
        running = started.success
        if (running.status !== undefined) status?.switchTo(running.status)
        events.configApplied(change.summary)
        yield* Metric.update(Metric.withAttributes(configApplies, { outcome: "applied" }), 1).pipe(
          withMetricAttributes({ site: next.site, building: next.building })
        )
        yield* Effect.logInfo("config applied from the status page").pipe(
          Effect.annotateLogs({ changes: change.summary })
        )
        return change
      }
      const reason = started.failure
      events.configApplyFailed(reason)
      yield* Metric.update(Metric.withAttributes(configApplies, { outcome: "rolled-back" }), 1).pipe(
        withMetricAttributes({ site: previous.config.site, building: previous.config.building })
      )
      yield* Effect.logError("config from the status page did not start, running the previous one again").pipe(
        Effect.annotateLogs({ error: reason, changes: change.summary })
      )
      const restored = yield* tryStart(previous.config, shared, { requireBuffer: false, awaitBroker: false })
      if (Result.isFailure(restored)) {
        // It ran a moment ago; if it cannot start again, the process ends and its supervisor starts it afresh.
        yield* Deferred.die(shared.fatal, new Error(`the previous config did not start again: ${restored.failure}`))
        return yield* new ConfigApplyFailed({ message: `${reason}; the previous config did not start again either` })
      }
      running = restored.success
      if (running.status !== undefined) status?.switchTo(running.status)
      return yield* new ConfigApplyFailed({ message: `${reason}. The previous config runs again.` })
    })
    const applyLoop = Effect.forever(
      Effect.flatMap(Queue.take(requests), (request) =>
        Effect.flatMap(Effect.exit(apply(request.config)), (exit) => Deferred.done(request.done, exit))
      )
    )

    if (config.status !== undefined && status !== undefined) {
      const editor =
        options.configFile === undefined
          ? undefined
          : yield* makeConfigEditor({
              file: options.configFile,
              bindAddress: config.status.bindAddress,
              running: () => running.config,
              apply: (next) =>
                Effect.gen(function* () {
                  const done = yield* Deferred.make<ConfigChange, ConfigApplyFailed>()
                  yield* Queue.offer(requests, { config: next, done })
                  return yield* Deferred.await(done)
                })
            })
      yield* serveStatus(
        config.status,
        status.state,
        historyHandler(() => running.config, history),
        editor
      ).pipe(Effect.forkScoped)
    }
    return yield* Effect.raceFirst(Deferred.await(shared.fatal), applyLoop)
  },
  Effect.scoped,
  Effect.provide(gatewayEventsLayer())
)
