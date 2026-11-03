/**
 * The gateway, composed from a parsed config: every device's pipeline under a
 * supervisor, the health reporter, and MQTT behind the SQLite outbox. `main.ts`
 * runs it on Node's network; the simulation (`test/sim`) runs the same
 * composition on an in-memory network under the test clock.
 */
import { type BacnetClient, covTimingFor, makeBacnetDriverFromClient, makeBacnetNetwork } from "@plenum/bacnet"
import { BufferedPublisher, type BufferedPublisherOptions } from "@plenum/buffer"
import {
  commandFilter,
  cycleTimeoutMs,
  type DriverRegistry,
  makeCommandGuard,
  makeDriverRegistry,
  type Device,
  type Driver,
  type GatewayConfig,
  type HealthRegistry,
  healthTopic,
  makeHealthRegistry,
  type Network,
  onlinePayload,
  type PublishOptions,
  Publisher,
  runDevice,
  runHealthReporter,
  superviseDevice,
  withMetricAttributes
} from "@plenum/core"
import { makeModbusDriver } from "@plenum/modbus"
import { MqttPublisher } from "@plenum/mqtt"
import { makeSimulatorDriver } from "@plenum/simulator"
import { Clock, Deferred, Effect, Exit, Layer, Schedule, Scope } from "effect"
import { type CommandRouting, makeCommandRouting } from "./Commands.ts"
import { keepRunning } from "./KeepRunning.ts"
import { makeStatusState, serveStatus, type StatusState } from "./Status.ts"
import { traceSampleRatio } from "./Telemetry.ts"

export interface GatewayOptions {
  /** Reach devices and the broker through this network instead of Node's. */
  readonly network?: Network
  /** Options for the outbox (a simulation injects disk faults through them). */
  readonly buffer?: BufferedPublisherOptions
  /** Told about every message the publisher accepted (stored or sent), after it did. */
  readonly onAccepted?: (topic: string, payload: string, options: PublishOptions | undefined) => void
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
        Effect.sync(() => bacnetDevices.forEach((device) => health.recordFailure(device.id, "connection"))),
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
  drivers: DriverRegistry
) => {
  /** Poll the device, and take commands for it while doing so. */
  const run = (driver: Driver) => Effect.andThen(drivers.register(driver), runDevice(ctx, driver))
  const ctx = {
    site: config.site,
    building: config.building,
    pollIntervalMs: device.pollIntervalMs,
    cycleTimeoutMs: cycleTimeoutMs(device),
    traceSampleRatio: sampleRatio,
    health
  }
  switch (device.protocol) {
    case "simulator":
      return runDevice(ctx, makeSimulatorDriver(device))
    case "modbus-tcp":
      // The device's connection lives as long as its polling loop.
      return Effect.scoped(Effect.flatMap(makeModbusDriver(device, network === undefined ? {} : { network }), run))
    case "bacnet-ip": {
      if (bacnet === undefined) return Effect.void
      // All BACnet devices share the gateway's one UDP socket, once it is open.
      return Deferred.await(bacnet).pipe(
        Effect.flatMap((client) =>
          makeBacnetDriverFromClient(device, client, { cov: covTimingFor(config.bacnet.covLifetimeSeconds) })
        ),
        Effect.flatMap(run),
        Effect.scoped,
        Effect.catchTag("DriverError", (error) => {
          health.recordFailure(device.id, error.reason)
          return Effect.logError("BACnet device not started").pipe(
            Effect.annotateLogs({ device: device.id, error: error.message })
          )
        })
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
  status: StatusState | undefined
) {
  const sampleRatio = yield* traceSampleRatio
  yield* Effect.log(`Plenum starting: ${config.site}/${config.building}, ${config.devices.length} device(s)`).pipe(
    Effect.annotateLogs({ traceSampleRatio: sampleRatio, health: health.topic })
  )
  let bacnet: BacnetNetwork
  if (config.devices.some((device) => device.protocol === "bacnet-ip")) {
    bacnet = yield* Deferred.make<BacnetClient>()
    yield* openBacnet(config, health.registry, bacnet, network).pipe(Effect.forkScoped)
  }
  if (config.status !== undefined && status !== undefined)
    yield* serveStatus(config.status, status).pipe(Effect.forkScoped)
  yield* Effect.all(
    [
      keepRunning(
        "health reporter",
        runHealthReporter({ topic: health.topic, intervalMs: config.healthIntervalMs, online: health.online })
      ),
      // A bug in one device's pipeline restarts that device only; suspended, so a restart builds a fresh driver.
      ...config.devices.map((device) =>
        superviseDevice(
          Effect.suspend(() => runOne(config, device, sampleRatio, health.registry, bacnet, network, commands.drivers)),
          { deviceId: device.id, health: health.registry }
        )
      ),
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
  status: StatusState | undefined
) => {
  const mqtt = MqttPublisher(config.mqtt, {
    health: { topic: health.topic, online: health.online },
    // With a buffer, a value that cannot go out now is stored, so waiting for the broker would only stall reads.
    waitForConnection: config.buffer === undefined,
    ...(options.network === undefined ? {} : { network: options.network }),
    ...(routing === undefined
      ? {}
      : {
          // Retain As Published, so a command published retained is seen as such even live, and refused.
          // No Local, so nothing the gateway publishes itself is ever taken for a command.
          subscriptions: [
            { filter: commandFilter(config.site, config.building), qos: 1, retainAsPublished: true, noLocal: true }
          ],
          onMessage: routing.onMessage
        })
  })
  const publisher =
    config.buffer === undefined ? mqtt : BufferedPublisher(config.buffer, options.buffer).pipe(Layer.provide(mqtt))
  const onAccepted = options.onAccepted
  if (onAccepted === undefined && status === undefined) return publisher
  return Layer.effect(
    Publisher,
    Effect.gen(function* () {
      const inner = yield* Publisher
      return Publisher.of({
        publish: (topic, payload, publishOptions) =>
          // The status page sees every value read, delivered or not: it matters most while the broker is down.
          Effect.sync(() => status?.recordPublish(topic, payload)).pipe(
            Effect.andThen(inner.publish(topic, payload, publishOptions)),
            Effect.tap(() => Effect.sync(() => onAccepted?.(topic, payload, publishOptions)))
          )
      })
    })
  ).pipe(Layer.provide(publisher))
}

/** Run the gateway for `config` until interrupted; its sockets and the outbox close with it. */
export const runGateway = Effect.fn("Gateway")(function* (config: GatewayConfig, options: GatewayOptions = {}) {
  const registry = makeHealthRegistry(config.devices.map((device) => device.id))
  const startedAt = yield* Clock.currentTimeMillis
  const health: GatewayHealth = {
    topic: healthTopic(config.site, config.building, config.id),
    registry,
    online: Effect.map(Clock.currentTimeMillis, (now) => onlinePayload(registry, startedAt, now))
  }
  const status = config.status === undefined ? undefined : makeStatusState(config, registry, startedAt)
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
  return yield* runDevices(config, health, options.network, commands, status).pipe(
    // The BACnet/IP socket closes before the broker connection does.
    Effect.scoped,
    // Inside the metric attributes, so the broker connection's metrics carry site and building too.
    Effect.provide(northbound(config, health, options, commands.routing, status)),
    withMetricAttributes({ site: config.site, building: config.building })
  )
})
