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
 * - a simulated BACnet/IP device for every `bacnet-ip` device whose `address`
 *   is on localhost with a port other than the gateway's own, with analog
 *   values on the same sine and binary values flipping every 30 s
 */
import { NodeDatagramSocket, NodeRuntime, NodeServices, NodeSocketServer } from "@effect/platform-node"
import { objectTypeNumber, serveSimulatedDevice, setPresentValue, simulatedDeviceFor } from "@plenum/bacnet"
import { type BacnetDevice, type GatewayConfig, type ModbusDevice, parseConfig } from "@plenum/core"
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

const runBacnetSimulator = Effect.fn("runBacnetSimulator")(function* (
  device: BacnetDevice,
  host: string,
  port: number
) {
  const simulated = simulatedDeviceFor(device)
  const update = Effect.gen(function* () {
    const seconds = (yield* Clock.currentTimeMillis) / 1000
    device.points.forEach((point, index) => {
      const objectType = objectTypeNumber(point.objectType)
      if (objectType === undefined) return
      const object = { objectType, instance: point.instance }
      if (point.objectType.startsWith("binary-")) {
        setPresentValue(simulated, object, { type: "enumerated", value: Math.floor(seconds / 30) % 2 })
      } else {
        const value = Math.round((50 + 50 * Math.sin((2 * Math.PI * seconds) / 120 + index)) * 100) / 100
        setPresentValue(simulated, object, { type: "real", value })
      }
    })
  })
  yield* update.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped)
  const socket = yield* NodeDatagramSocket.make({ bind: { address: host, port } })
  yield* serveSimulatedDevice(socket, simulated)
  yield* Console.log(`BACnet simulator for ${device.id} (device ${device.deviceInstance}) on ${host}:${port}`)
  return yield* Effect.never
})

/** The localhost address and port of a BACnet device the bench should simulate, if any. */
const simulatedBacnetAt = (config: GatewayConfig, device: BacnetDevice) => {
  const [host = "", portText] = (device.address ?? "").split(":")
  const port = portText === undefined ? 47_808 : Number(portText)
  return localHosts.has(host) && port !== config.bacnet.port ? { host, port } : undefined
}

const program = Effect.gen(function* () {
  const path = process.argv[2] ?? "plenum.json"
  const fs = yield* FileSystem.FileSystem
  const config = yield* parseConfig(yield* fs.readFileString(path))
  const simulated = config.devices.filter(
    (device): device is ModbusDevice => device.protocol === "modbus-tcp" && localHosts.has(device.host)
  )
  const bacnet = config.devices.flatMap((device) => {
    if (device.protocol !== "bacnet-ip") return []
    const at = simulatedBacnetAt(config, device)
    return at === undefined ? [] : [runBacnetSimulator(device, at.host, at.port)]
  })
  yield* Effect.all([runBroker(config), ...simulated.map(runSimulator), ...bacnet], {
    concurrency: "unbounded",
    discard: true
  })
})

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain)
