#!/usr/bin/env node
/**
 * Plenum gateway entry point.
 *
 *   node apps/gateway/src/main.ts path/to/gateway.json
 *
 * Polls simulator and Modbus TCP devices and publishes to the MQTT broker in
 * `mqtt`. BACnet plugs in here as it lands.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { type Device, type GatewayConfig, parseConfig, runDevice, withMetricAttributes } from "@plenum/core"
import { makeModbusDriver } from "@plenum/modbus"
import { MqttPublisher } from "@plenum/mqtt"
import { makeSimulatorDriver } from "@plenum/simulator"
import { Effect, FileSystem } from "effect"
import { telemetryLayer, traceSampleRatio } from "./Telemetry.ts"

const runOne = (config: GatewayConfig, device: Device, sampleRatio: number) => {
  const ctx = {
    site: config.site,
    building: config.building,
    pollIntervalMs: device.pollIntervalMs,
    traceSampleRatio: sampleRatio
  }
  switch (device.protocol) {
    case "simulator":
      return runDevice(ctx, makeSimulatorDriver(device))
    case "modbus-tcp":
      // The device's connection lives as long as its polling loop.
      return Effect.scoped(Effect.flatMap(makeModbusDriver(device), (driver) => runDevice(ctx, driver)))
    case "bacnet-ip":
      return Effect.logWarning(`${device.protocol} driver is not implemented yet, skipping`).pipe(
        Effect.annotateLogs({ device: device.id })
      )
  }
}

const runGateway = Effect.fn("runGateway")(function* (config: GatewayConfig) {
  const sampleRatio = yield* traceSampleRatio
  yield* Effect.log(`Plenum starting: ${config.site}/${config.building}, ${config.devices.length} device(s)`).pipe(
    Effect.annotateLogs({ traceSampleRatio: sampleRatio })
  )
  yield* Effect.forEach(config.devices, (device) => runOne(config, device, sampleRatio), {
    concurrency: "unbounded",
    discard: true
  })
})

const program = Effect.gen(function* () {
  const path = process.argv[2] ?? "plenum.json"
  const fs = yield* FileSystem.FileSystem
  const config = yield* parseConfig(yield* fs.readFileString(path))

  yield* runGateway(config).pipe(
    // Inside the metric attributes, so the broker connection's metrics carry site and building too.
    Effect.provide(MqttPublisher(config.mqtt)),
    withMetricAttributes({ site: config.site, building: config.building }),
    Effect.provide(telemetryLayer(config))
  )
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
