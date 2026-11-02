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
import { ConsolePublisher, type Device, parseConfig, runDevice } from "@plenum/core"
import { makeSimulatorDriver } from "@plenum/simulator"
import { Effect, FileSystem, Layer } from "effect"

const runOne = (config: { site: string; building: string }, device: Device) => {
  const ctx = { site: config.site, building: config.building, pollIntervalMs: device.pollIntervalMs }
  switch (device.protocol) {
    case "simulator":
      return runDevice(ctx, makeSimulatorDriver(device))
    case "modbus-tcp":
    case "bacnet-ip":
      return Effect.logWarning(`${device.protocol} driver is not implemented yet, skipping`, { device: device.id })
  }
}

const program = Effect.gen(function* () {
  const path = process.argv[2] ?? "plenum.json"
  const fs = yield* FileSystem.FileSystem
  const config = yield* parseConfig(yield* fs.readFileString(path))

  yield* Effect.log(`Plenum starting: ${config.site}/${config.building}, ${config.devices.length} device(s)`)
  yield* Effect.forEach(config.devices, (device) => runOne(config, device), {
    concurrency: "unbounded",
    discard: true
  })
})

program.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, ConsolePublisher)), NodeRuntime.runMain)
