#!/usr/bin/env node
/**
 * A local test bench for `pnpm gateway`, so the whole path runs without
 * hardware or a real broker:
 *
 *   node apps/gateway/src/bench.ts path/to/gateway.json
 *
 * - an MQTT test broker on the port in `mqtt.url`, printing every message
 * - a Modbus TCP simulator for every `modbus-tcp` device on localhost, with
 *   values that change over time (floats follow a slow sine, integers count
 *   up every 10 s, booleans flip every 30 s)
 */
import { NodeRuntime, NodeServices, NodeSocketServer } from "@effect/platform-node"
import { type GatewayConfig, type ModbusDevice, parseConfig } from "@plenum/core"
import { makeRegisterBank, serveModbus, setPointValue } from "@plenum/modbus"
import { makeBrokerControl, parseBrokerUrl, serveMqtt } from "@plenum/mqtt"
import { Clock, Console, Effect, FileSystem, Schedule } from "effect"

const localHosts = new Set(["localhost", "127.0.0.1", "::1"])

const runBroker = Effect.fn("runBroker")(function* (config: GatewayConfig) {
  const address = yield* parseBrokerUrl(config.mqtt.url)
  if (address.tls || !localHosts.has(address.host)) {
    return yield* Effect.logWarning(`mqtt.url ${config.mqtt.url} is not a plain local broker, not starting one`)
  }
  const server = yield* NodeSocketServer.make({ host: address.host, port: address.port })
  const control = makeBrokerControl()
  control.onMessage = (message) =>
    console.log(`${message.retain ? "[retained] " : ""}${message.topic} ${message.payload}`)
  yield* Console.log(`MQTT test broker on ${address.host}:${address.port}`)
  return yield* serveMqtt(server, control)
})

const runSimulator = Effect.fn("runSimulator")(function* (device: ModbusDevice) {
  const server = yield* NodeSocketServer.make({ host: device.host, port: device.port })
  const bank = makeRegisterBank()
  const update = Effect.gen(function* () {
    const seconds = (yield* Clock.currentTimeMillis) / 1000
    device.points.forEach((point, index) => {
      if (point.dataType === "bool") return setPointValue(bank, point, Math.floor(seconds / 30) % 2 === 0)
      // Integers count up like a meter; floats follow a sine between 0 and 100, phase-shifted so points differ.
      const value =
        point.dataType === "float32"
          ? 50 + 50 * Math.sin((2 * Math.PI * seconds) / 120 + index)
          : Math.floor(seconds / 10) % 32_768
      setPointValue(bank, point, value)
    })
  })
  yield* update.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped)
  yield* Console.log(`Modbus simulator for ${device.id} on ${device.host}:${device.port}`)
  return yield* serveModbus(server, bank)
})

const program = Effect.gen(function* () {
  const path = process.argv[2] ?? "plenum.json"
  const fs = yield* FileSystem.FileSystem
  const config = yield* parseConfig(yield* fs.readFileString(path))
  const simulated = config.devices.filter(
    (device): device is ModbusDevice => device.protocol === "modbus-tcp" && localHosts.has(device.host)
  )
  yield* Effect.all([runBroker(config), ...simulated.map(runSimulator)], { concurrency: "unbounded", discard: true })
})

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain)
