#!/usr/bin/env node
/**
 * Plenum gateway entry point.
 *
 *   node apps/gateway/src/main.ts path/to/gateway.json
 *
 * Polls simulator and Modbus TCP devices and publishes to the MQTT broker in
 * `mqtt`, with the gateway's status on its retained health topic. BACnet
 * plugs in here as it lands.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
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
import { Clock, Effect, FileSystem, Layer } from "effect"
import { telemetryLayer, traceSampleRatio } from "./Telemetry.ts"

const runOne = (config: GatewayConfig, device: Device, sampleRatio: number, health: HealthRegistry) => {
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
    case "bacnet-ip":
      health.recordFailure(device.id, "not-implemented")
      return Effect.logWarning(`${device.protocol} driver is not implemented yet, skipping`).pipe(
        Effect.annotateLogs({ device: device.id })
      )
  }
}

const runGateway = Effect.fn("runGateway")(function* (config: GatewayConfig, health: GatewayHealth) {
  const sampleRatio = yield* traceSampleRatio
  yield* Effect.log(`Plenum starting: ${config.site}/${config.building}, ${config.devices.length} device(s)`).pipe(
    Effect.annotateLogs({ traceSampleRatio: sampleRatio, health: health.topic })
  )
  yield* Effect.all(
    [
      runHealthReporter({ topic: health.topic, intervalMs: config.healthIntervalMs, online: health.online }),
      ...config.devices.map((device) => runOne(config, device, sampleRatio, health.registry))
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
    // Inside the metric attributes, so the broker connection's metrics carry site and building too.
    Effect.provide(northbound(config, health)),
    withMetricAttributes({ site: config.site, building: config.building }),
    Effect.provide(telemetryLayer(config))
  )
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
