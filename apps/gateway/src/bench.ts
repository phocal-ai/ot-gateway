#!/usr/bin/env node
/**
 * A local test bench for `pnpm gateway`, so the whole path runs without
 * hardware or a real broker:
 *
 *   node apps/gateway/src/bench.ts path/to/gateway.json
 *
 * - an MQTT test broker on the port in `mqtt.url`, printing every message
 * - a Modbus TCP simulator for every `modbus-tcp` endpoint on localhost, with
 *   values that change over time (floats follow a slow sine, integers count
 *   up every 10 s, booleans flip every 30 s). Devices on the same port are
 *   units behind one simulated gateway, each answering its own unit id.
 * - a simulated BACnet/IP device for every `bacnet-ip` device whose `address`
 *   is on localhost with a port other than the gateway's own, with analog
 *   values on the same sine and binary values flipping every 30 s
 * - writable points are left alone, so a command's value stays; the broker
 *   routes commands to the gateway, so `$set` works against the bench too
 *
 * `--only broker` or `--only devices` starts one half, so a soak test can stop
 * the broker without stopping the devices. `--speed N` makes the simulated
 * values change N times faster (an accelerated soak polls N times faster too).
 */
import * as NodeDatagramSocket from "@effect/platform-node/NodeDatagramSocket"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { objectTypeNumber, serveSimulatedDevice, setPresentValue, simulatedDeviceFor } from "@plenum/bacnet"
import { type BacnetDevice, type GatewayConfig, type ModbusDevice, parseConfig } from "@plenum/core"
import { endpointOf, makeRegisterBank, type RegisterBank, serveModbus, setPointValue } from "@plenum/modbus"
import { makeBrokerControl, parseBrokerUrl, serveMqtt } from "@plenum/mqtt"
import { Clock, Console, Effect, FileSystem, Result, Schedule } from "effect"

const localHosts = new Set(["localhost", "127.0.0.1", "::1"])

/** How the simulated values move: seconds of simulated time per real second, and how often they are updated. */
interface Pace {
  readonly speed: number
  readonly update: Schedule.Schedule<unknown>
}

const paceOf = (speed: number): Pace => ({
  speed,
  update: Schedule.spaced(Math.max(50, Math.round(1000 / speed)))
})

/** Simulated seconds since the epoch: wall time, sped up. */
const simulatedSeconds = (pace: Pace) => Effect.map(Clock.currentTimeMillis, (millis) => (millis / 1000) * pace.speed)

const runBroker = Effect.fn("runBroker")(function* (config: GatewayConfig) {
  const address = yield* parseBrokerUrl(config.mqtt.url)
  if (address.tls || !localHosts.has(address.host)) {
    return yield* Effect.logWarning(`mqtt.url ${config.mqtt.url} is not a plain local broker, not starting one`)
  }
  // `localhost` is both loopbacks (Docker's /etc/hosts lists ::1 too), and binding the name takes only the
  // first: listen on each that exists, as real brokers do, so a client finds it whichever family it tries.
  const hosts = address.host === "localhost" ? ["127.0.0.1", "::1"] : [address.host]
  const bound = yield* Effect.forEach(hosts, (host) =>
    Effect.result(NodeSocketServer.make({ host, port: address.port }))
  )
  const servers = bound.flatMap((result) => (Result.isSuccess(result) ? [result.success] : []))
  const [first] = bound
  if (servers.length === 0 && first !== undefined && Result.isFailure(first)) return yield* first.failure
  const control = makeBrokerControl()
  control.onMessage = (message) =>
    console.log(`${message.retain ? "[retained] " : ""}${message.topic} ${message.payload}`)
  yield* Console.log(`MQTT test broker on ${address.host}:${address.port}`)
  return yield* Effect.forEach(servers, (server) => serveMqtt(server, control), {
    concurrency: "unbounded",
    discard: true
  })
})

/**
 * One simulated endpoint: a device, or a Modbus TCP gateway with several
 * devices behind it (one register bank per unit id), as the config has them.
 */
const runSimulator = Effect.fn("runSimulator")(function* (devices: ReadonlyArray<ModbusDevice>, pace: Pace) {
  const [first] = devices
  if (first === undefined) return yield* Effect.never
  const server = yield* NodeSocketServer.make({ host: first.host, port: first.port })
  const units = new Map<number, RegisterBank>()
  for (const device of devices) {
    const bank = units.get(device.unitId) ?? makeRegisterBank()
    units.set(device.unitId, bank)
    yield* simulateDevice(device, bank, pace)
  }
  yield* Console.log(
    `Modbus simulator for ${devices.map((device) => `${device.id} (unit ${device.unitId})`).join(", ")} on ${first.host}:${first.port}`
  )
  return yield* serveModbus(server, units)
})

/** Keep `device`'s points in `bank` moving, until the scope closes. */
const simulateDevice = Effect.fn("simulateDevice")(function* (device: ModbusDevice, bank: RegisterBank, pace: Pace) {
  // A writable point starts at its lower limit (or 0) and then changes only by command.
  for (const point of device.points) if (point.writable) setPointValue(bank, point, point.limits?.min ?? 0)
  const update = Effect.gen(function* () {
    const seconds = yield* simulatedSeconds(pace)
    device.points.forEach((point, index) => {
      if (point.writable) return
      if (point.dataType === "bool") return setPointValue(bank, point, Math.floor(seconds / 30) % 2 === 0)
      // Integers count up like a meter; floats follow a sine between 0 and 100, phase-shifted so points differ.
      const value =
        point.dataType === "float32" || point.dataType === "float64"
          ? 50 + 50 * Math.sin((2 * Math.PI * seconds) / 120 + index)
          : Math.floor(seconds / 10) % 32_768
      setPointValue(bank, point, value)
    })
  })
  yield* update.pipe(Effect.repeat(pace.update), Effect.forkScoped)
})

const runBacnetSimulator = Effect.fn("runBacnetSimulator")(function* (
  device: BacnetDevice,
  host: string,
  port: number,
  pace: Pace
) {
  const simulated = simulatedDeviceFor(device)
  const update = Effect.gen(function* () {
    const seconds = yield* simulatedSeconds(pace)
    device.points.forEach((point, index) => {
      // A writable point changes only by command.
      if (point.writable) return
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
  yield* update.pipe(Effect.repeat(pace.update), Effect.forkScoped)
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
  const args = process.argv.slice(2)
  const onlyAt = args.indexOf("--only")
  const only = onlyAt === -1 ? undefined : args.splice(onlyAt, 2)[1]
  if (only !== undefined && only !== "broker" && only !== "devices") {
    return yield* Effect.die(new Error(`--only takes broker or devices, not ${only}`))
  }
  const speedAt = args.indexOf("--speed")
  const speed = speedAt === -1 ? 1 : Number(args.splice(speedAt, 2)[1])
  if (!Number.isFinite(speed) || speed < 1) {
    return yield* Effect.die(new Error("--speed takes a number of at least 1"))
  }
  const pace = paceOf(speed)
  const path = args[0] ?? "plenum.json"
  const fs = yield* FileSystem.FileSystem
  const config = yield* parseConfig(yield* fs.readFileString(path))
  const simulated = config.devices.filter(
    (device): device is ModbusDevice => device.protocol === "modbus-tcp" && localHosts.has(device.host)
  )
  const bacnet = config.devices.flatMap((device) => {
    if (device.protocol !== "bacnet-ip") return []
    const at = simulatedBacnetAt(config, device)
    return at === undefined ? [] : [runBacnetSimulator(device, at.host, at.port, pace)]
  })
  const broker = only === "devices" ? [] : [runBroker(config)]
  const endpoints = new Map<string, Array<ModbusDevice>>()
  for (const device of simulated)
    endpoints.set(endpointOf(device), [...(endpoints.get(endpointOf(device)) ?? []), device])
  const devices =
    only === "broker" ? [] : [...[...endpoints.values()].map((group) => runSimulator(group, pace)), ...bacnet]
  yield* Effect.all([...broker, ...devices], {
    concurrency: "unbounded",
    discard: true
  })
})

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain)
