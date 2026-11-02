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
import {
  type BacnetClient,
  type BacnetSocketError,
  makeBacnetDriverFromClient,
  makeBacnetNetwork
} from "@plenum/bacnet"
import {
  type Device,
  type GatewayConfig,
  type HealthRegistry,
  healthTopic,
  makeHealthRegistry,
  onlinePayload,
  parseConfig,
  runDevice,
  runHealthReporter,
  withMetricAttributes
} from "@plenum/core"
import { makeModbusDriver } from "@plenum/modbus"
import { MqttPublisher } from "@plenum/mqtt"
import { BufferedPublisher } from "@plenum/buffer"
import { makeSimulatorDriver } from "@plenum/simulator"
import { Clock, Effect, FileSystem, Layer, Result } from "effect"
import { telemetryLayer, traceSampleRatio } from "./Telemetry.ts"

/** The gateway's BACnet/IP endpoint: absent without BACnet devices, failed when its port could not be opened. */
type BacnetNetwork = Result.Result<BacnetClient, BacnetSocketError> | undefined

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
      if (bacnet === undefined || Result.isFailure(bacnet)) {
        health.recordFailure(device.id, "connection")
        return Effect.logError("BACnet/IP endpoint is not available, not polling the device").pipe(
          Effect.annotateLogs({ device: device.id })
        )
      }
      // All BACnet devices share the gateway's one UDP socket.
      return makeBacnetDriverFromClient(device, bacnet.success).pipe(
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
  const bacnet: BacnetNetwork = config.devices.some((device) => device.protocol === "bacnet-ip")
    ? yield* makeBacnetNetwork(config.bacnet).pipe(
        Effect.tapError((error) =>
          Effect.logError("could not open the BACnet/IP endpoint").pipe(
            Effect.annotateLogs({ port: config.bacnet.port, error: error.message })
          )
        ),
        Effect.result
      )
    : undefined
  yield* Effect.all(
    [
      runHealthReporter({ topic: health.topic, intervalMs: config.healthIntervalMs, online: health.online }),
      ...config.devices.map((device) => runOne(config, device, sampleRatio, health.registry, bacnet))
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

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
