#!/usr/bin/env node
/**
 * Plenum gateway entry point.
 *
 *   node apps/gateway/src/main.ts path/to/gateway.json
 *
 * Today it runs simulator devices and prints to the console. Modbus, BACnet
 * and MQTT plug in here as their drivers land.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
  ConsolePublisher,
  type Device,
  type GatewayConfig,
  parseConfig,
  runDevice,
  withMetricAttributes
} from "@plenum/core"
import { makeSimulatorDriver } from "@plenum/simulator"
import { Effect, FileSystem, Layer } from "effect"
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
    withMetricAttributes({ site: config.site, building: config.building }),
    Effect.provide(telemetryLayer(config))
  )
})

program.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, ConsolePublisher)), NodeRuntime.runMain)
