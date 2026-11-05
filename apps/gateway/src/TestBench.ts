/**
 * The test bench: an MQTT test broker and simulators for the devices of a config that are on this machine, so
 * the whole path runs without hardware or a real broker. `bench.ts` runs it on its own (for `pnpm bench`, the
 * soak and interop runs) and `ot-gateway demo` runs it next to the gateway.
 *
 * - an MQTT test broker on the port in `mqtt.url`, passing every message to `onMessage`
 * - a Modbus TCP simulator for every `modbus-tcp` endpoint on localhost, with
 *   values that change over time (floats follow a slow sine, integers count
 *   up every 10 s, booleans flip every 30 s). Devices on the same port are
 *   units behind one simulated gateway, each answering its own unit id.
 * - a simulated BACnet/IP device for every `bacnet-ip` device whose `address`
 *   is on localhost with a port other than the gateway's own, with analog
 *   values on the same sine and binary values flipping every 30 s
 * - writable points are left alone, so a command's value stays; the broker
 *   routes commands to the gateway, so `$set` works against the bench too
 */
import * as NodeDatagramSocket from "@effect/platform-node/NodeDatagramSocket"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { objectTypeNumber, serveSimulatedDevice, setPresentValue, simulatedDeviceFor } from "@ot-gateway/bacnet"
import type { BacnetDevice, GatewayConfig, ModbusDevice } from "@ot-gateway/core"
import { endpointOf, makeRegisterBank, type RegisterBank, serveModbus, setPointValue } from "@ot-gateway/modbus"
import { makeBrokerControl, parseBrokerUrl, serveMqtt } from "@ot-gateway/mqtt"
import { Clock, Console, Deferred, Effect, Result, Schedule } from "effect"

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
/**
 * The range a simulated analog value swings through, by its unit, so a bench reads like a building (a supply air
 * temperature of 12 to 24 °C, not 97); anything else 0 to 100.
 */
const rangeByUnit: Readonly<Record<string, readonly [number, number]>> = {
  "unit:DEG_C": [12, 24],
  "unit:DEG_F": [54, 75],
  "unit:PERCENT_RelativeHumidity": [30, 60],
  "unit:PPM": [400, 1200],
  "unit:PA": [100, 400]
}

/** A float that follows a two-minute sine through its unit's range, phase-shifted by `index` so points differ. */
export const benchValue = (unit: string | undefined, seconds: number, index: number) => {
  const [low, high] = (unit === undefined ? undefined : rangeByUnit[unit]) ?? [0, 100]
  const value = low + (high - low) * (0.5 + 0.5 * Math.sin((2 * Math.PI * seconds) / 120 + index))
  return Math.round(value * 100) / 100
}

const simulatedSeconds = (pace: Pace) => Effect.map(Clock.currentTimeMillis, (millis) => (millis / 1000) * pace.speed)

const runBroker = Effect.fn("runBroker")(function* (
  config: GatewayConfig,
  onMessage: (message: BrokerMessage) => void,
  ready: Deferred.Deferred<void> | undefined
) {
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
  control.onMessage = onMessage
  if (ready !== undefined) yield* Deferred.succeed(ready, undefined)
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
      // Integers count up like a meter; floats swing through their unit's range.
      const value =
        point.dataType === "float32" || point.dataType === "float64"
          ? benchValue(point.unit, seconds, index)
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
        setPresentValue(simulated, object, { type: "real", value: benchValue(point.unit, seconds, index) })
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

/** A message as the bench's broker received it. */
export interface BrokerMessage {
  readonly topic: string
  readonly payload: string
  readonly retain: boolean
}

/** One line per message: `[retained] topic payload`. */
export const printMessage = (message: BrokerMessage) =>
  console.log(`${message.retain ? "[retained] " : ""}${message.topic} ${message.payload}`)

export interface BenchOptions {
  /** Start only the broker or only the device simulators, so a soak can stop one without the other. */
  readonly only?: "broker" | "devices" | undefined
  /** How many times faster than real time the simulated values change. */
  readonly speed?: number | undefined
  /** Called for every message the broker receives; prints it by default. */
  readonly onMessage?: ((message: BrokerMessage) => void) | undefined
  /** Completed once the broker listens, so a gateway started next connects on its first try. */
  readonly ready?: Deferred.Deferred<void> | undefined
}

/** Runs the bench for `config` until interrupted. */
export const runBench = Effect.fn("runBench")(function* (config: GatewayConfig, options: BenchOptions = {}) {
  const pace = paceOf(options.speed ?? 1)
  const simulated = config.devices.filter(
    (device): device is ModbusDevice => device.protocol === "modbus-tcp" && localHosts.has(device.host)
  )
  const bacnet = config.devices.flatMap((device) => {
    if (device.protocol !== "bacnet-ip") return []
    const at = simulatedBacnetAt(config, device)
    return at === undefined ? [] : [runBacnetSimulator(device, at.host, at.port, pace)]
  })
  const broker = options.only === "devices" ? [] : [runBroker(config, options.onMessage ?? printMessage, options.ready)]
  const endpoints = new Map<string, Array<ModbusDevice>>()
  for (const device of simulated)
    endpoints.set(endpointOf(device), [...(endpoints.get(endpointOf(device)) ?? []), device])
  const devices =
    options.only === "broker" ? [] : [...[...endpoints.values()].map((group) => runSimulator(group, pace)), ...bacnet]
  yield* Effect.all([...broker, ...devices], { concurrency: "unbounded", discard: true })
})
