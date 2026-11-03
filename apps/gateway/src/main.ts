#!/usr/bin/env node
/**
 * Plenum gateway entry point.
 *
 *   node apps/gateway/src/main.ts path/to/gateway.json
 *
 * Polls simulator, Modbus TCP and BACnet/IP devices and publishes to the MQTT
 * broker in `mqtt`, with the gateway's status on its retained health topic.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { type BacnetClient, covTimingFor, makeBacnetDriverFromClient, makeBacnetNetwork } from "@plenum/bacnet"
import {
  cycleTimeoutMs,
  type Device,
  type GatewayConfig,
  type HealthRegistry,
  healthTopic,
  makeHealthRegistry,
  onlinePayload,
  parseConfig,
  runDevice,
  runHealthReporter,
  superviseDevice,
  withMetricAttributes
} from "@plenum/core"
import { makeModbusDriver } from "@plenum/modbus"
import { MqttPublisher } from "@plenum/mqtt"
import { BufferedPublisher } from "@plenum/buffer"
import { makeSimulatorDriver } from "@plenum/simulator"
import { Clock, Deferred, Effect, Exit, FileSystem, Layer, Schedule, Scope } from "effect"
import { keepRunning } from "./KeepRunning.ts"
import { gatewayTeardown } from "./Shutdown.ts"
import { telemetryLayer, traceSampleRatio } from "./Telemetry.ts"

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
  network: Deferred.Deferred<BacnetClient>
) {
  const gatewayScope = yield* Effect.scope
  const bacnetDevices = config.devices.filter((device) => device.protocol === "bacnet-ip")
  const attempt = Effect.gen(function* () {
    const scope = yield* Scope.fork(gatewayScope)
    return yield* makeBacnetNetwork(config.bacnet).pipe(
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
  yield* Deferred.succeed(network, client)
})

const runOne = (
  config: GatewayConfig,
  device: Device,
  sampleRatio: number,
  health: HealthRegistry,
  bacnet: BacnetNetwork
) => {
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
      return Effect.scoped(Effect.flatMap(makeModbusDriver(device), (driver) => runDevice(ctx, driver)))
    case "bacnet-ip": {
      if (bacnet === undefined) return Effect.void
      // All BACnet devices share the gateway's one UDP socket, once it is open.
      return Deferred.await(bacnet).pipe(
        Effect.flatMap((client) =>
          makeBacnetDriverFromClient(device, client, { cov: covTimingFor(config.bacnet.covLifetimeSeconds) })
        ),
        Effect.flatMap((driver) => runDevice(ctx, driver)),
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

const runGateway = Effect.fn("runGateway")(function* (config: GatewayConfig, health: GatewayHealth) {
  const sampleRatio = yield* traceSampleRatio
  yield* Effect.log(`Plenum starting: ${config.site}/${config.building}, ${config.devices.length} device(s)`).pipe(
    Effect.annotateLogs({ traceSampleRatio: sampleRatio, health: health.topic })
  )
  let bacnet: BacnetNetwork
  if (config.devices.some((device) => device.protocol === "bacnet-ip")) {
    bacnet = yield* Deferred.make<BacnetClient>()
    yield* openBacnet(config, health.registry, bacnet).pipe(Effect.forkScoped)
  }
  yield* Effect.all(
    [
      keepRunning(
        "health reporter",
        runHealthReporter({ topic: health.topic, intervalMs: config.healthIntervalMs, online: health.online })
      ),
      // A bug in one device's pipeline restarts that device only; suspended, so a restart builds a fresh driver.
      ...config.devices.map((device) =>
        superviseDevice(
          Effect.suspend(() => runOne(config, device, sampleRatio, health.registry, bacnet)),
          { deviceId: device.id, health: health.registry }
        )
      )
    ],
    { concurrency: "unbounded", discard: true }
  )
})

interface GatewayHealth {
  readonly topic: string
  readonly registry: HealthRegistry
  readonly online: Effect.Effect<string>
}

/** MQTT, behind a SQLite outbox when `buffer` is configured. */
const northbound = (config: GatewayConfig, health: GatewayHealth) => {
  const mqtt = MqttPublisher(config.mqtt, {
    health: { topic: health.topic, online: health.online },
    // With a buffer, a value that cannot go out now is stored, so waiting for the broker would only stall reads.
    waitForConnection: config.buffer === undefined
  })
  return config.buffer === undefined ? mqtt : BufferedPublisher(config.buffer).pipe(Layer.provide(mqtt))
}

const program = Effect.gen(function* () {
  const path = process.argv[2] ?? "plenum.json"
  const fs = yield* FileSystem.FileSystem
  const config = yield* parseConfig(yield* fs.readFileString(path))
  const registry = makeHealthRegistry(config.devices.map((device) => device.id))
  const startedAt = yield* Clock.currentTimeMillis
  const health: GatewayHealth = {
    topic: healthTopic(config.site, config.building, config.id),
    registry,
    online: Effect.map(Clock.currentTimeMillis, (now) => onlinePayload(registry, startedAt, now))
  }

  yield* runGateway(config, health).pipe(
    // The BACnet/IP socket closes before the broker connection does.
    Effect.scoped,
    // Inside the metric attributes, so the broker connection's metrics carry site and building too.
    Effect.provide(northbound(config, health)),
    withMetricAttributes({ site: config.site, building: config.building }),
    Effect.provide(telemetryLayer(config))
  )
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain({ teardown: gatewayTeardown }))
