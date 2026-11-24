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
 * - an energy counter (a point in Wh, kWh or MWh) on a device with an active power point (W, kW or MW) counts the
 *   energy that power delivers (`benchEnergyOf`), so the two agree as a real meter's do. It counts from a fixed
 *   moment (`benchEnergyTotal`), so a restarted bench carries on where the last one stopped rather than going back
 * - a simulated BACnet/IP device for every `bacnet-ip` device whose `address`
 *   is on localhost with a port other than the gateway's own, with analog
 *   values on the same sine and binary values flipping every 30 s
 * - a device with a flow and a return temperature runs like a heating circuit
 *   (`benchAnalogOf`): return stays 3 to 7 K below flow, and its compressor
 *   runs while that spread is above 4 K
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
 * The range a simulated analog value swings through, by its unit, so a bench reads like a site (a heat pump's flow
 * temperature of 25 to 40 °C, not 97); anything else 0 to 100.
 */
const rangeByUnit: Readonly<Record<string, readonly [number, number]>> = {
  "unit:DEG_C": [25, 40],
  "unit:DEG_F": [77, 104],
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

/** What the bench needs to know of a point to simulate it. */
interface BenchPoint {
  readonly id: string
  readonly unit?: string | undefined
  readonly semantics?: { readonly haystack?: ReadonlyArray<string> | undefined } | undefined
}

/**
 * Which side of a water circuit a temperature point measures, from its Haystack tags (`leaving` / `entering`) or its
 * id (`flow` or `supply` / `return`). Anything else is not part of a circuit.
 */
const circuitSide = (point: BenchPoint): "flow" | "return" | undefined => {
  const tags = point.semantics?.haystack ?? []
  if (tags.includes("leaving") || /flow|supply/.test(point.id)) return "flow"
  if (tags.includes("entering") || /return/.test(point.id)) return "return"
  return undefined
}

/** How much colder the return is than the flow: 3 to 7 K, on a four-minute cycle, as a heat pump's load varies. */
export const benchSpread = (seconds: number) => 5 + 2 * Math.sin((2 * Math.PI * seconds) / 240)

/** The flow point a return point on the same device pairs with: the first flow temperature in the same unit. */
const flowIndexFor = (points: ReadonlyArray<BenchPoint>, point: BenchPoint): number | undefined => {
  if (circuitSide(point) !== "return") return undefined
  const index = points.findIndex((other) => other.unit === point.unit && circuitSide(other) === "flow")
  return index === -1 ? undefined : index
}

/**
 * The analog value of `points[index]` over simulated seconds. A return temperature with a flow temperature beside it
 * follows the flow `benchSpread` below, so a heating circuit never runs backwards; anything else is `benchValue`.
 * Worked out once per device, so an update does not search the points again.
 */
export const benchAnalogOf = (points: ReadonlyArray<BenchPoint>, index: number): ((seconds: number) => number) => {
  const point = points[index]
  const flowIndex = point === undefined ? undefined : flowIndexFor(points, point)
  const unit = point?.unit
  if (flowIndex === undefined) return (seconds) => benchValue(unit, seconds, index)
  return (seconds) => Math.round((benchValue(unit, seconds, flowIndex) - benchSpread(seconds)) * 100) / 100
}

/**
 * The binary value of `points[index]`: a compressor on a device with a flow and a return temperature runs while the
 * spread between them is above 4 K (it is putting heat in); any other binary value flips every 30 s.
 */
export const benchBinaryOf = (points: ReadonlyArray<BenchPoint>, index: number): ((seconds: number) => boolean) => {
  const point = points[index]
  const circuit = points.some((other) => flowIndexFor(points, other) !== undefined)
  if (point !== undefined && circuit && /compressor/.test(point.id)) return (seconds) => benchSpread(seconds) > 4
  return (seconds) => Math.floor(seconds / 30) % 2 === 0
}

/** Each power unit in kW, and each energy unit in kWh: the units `benchEnergyOf` pairs. */
const POWER_IN_KW: Readonly<Record<string, number>> = { "unit:W": 0.001, "unit:KiloW": 1, "unit:MegaW": 1000 }
const ENERGY_IN_KWH: Readonly<Record<string, number>> = {
  "unit:W-HR": 0.001,
  "unit:KiloW-HR": 1,
  "unit:MegaW-HR": 1000
}

/** Where a simulated energy counter starts, in its own unit: a meter that has run for a while. */
export const BENCH_ENERGY_START = 12_000

/**
 * The energy counter `points[index]` (a point in an energy unit), as the energy the device's first power point
 * delivered from simulated second `from` to `seconds`, in the counter's unit: the integral of `benchValue`'s sine,
 * worked out exactly, so it never runs backwards and agrees with the power read at any pace. Undefined for a point
 * that is no energy counter, or one on a device without a power point.
 */
export const benchEnergyOf = (
  points: ReadonlyArray<BenchPoint>,
  index: number
): ((from: number, seconds: number) => number) | undefined => {
  const unit = points[index]?.unit
  const perUnitKwh = unit === undefined ? undefined : ENERGY_IN_KWH[unit]
  if (perUnitKwh === undefined) return undefined
  const powerIndex = points.findIndex((point) => point.unit !== undefined && POWER_IN_KW[point.unit] !== undefined)
  const powerUnit = points[powerIndex]?.unit
  const kw = powerUnit === undefined ? undefined : POWER_IN_KW[powerUnit]
  if (powerUnit === undefined || kw === undefined) return undefined
  const [low, high] = rangeByUnit[powerUnit] ?? [0, 100]
  const half = (high - low) / 2
  const omega = (2 * Math.PI) / 120
  // The integral of low + half * (1 + sin(omega * s + powerIndex)) over s, in the power's unit times seconds.
  const integral = (seconds: number) => (low + half) * seconds - (half / omega) * Math.cos(omega * seconds + powerIndex)
  return (from, seconds) => ((integral(seconds) - integral(from)) * kw) / 3600 / perUnitKwh
}

/**
 * Unix ms the bench's energy counters count from: 2026-11-01, UTC. Counting from a fixed moment rather than from
 * the bench's start makes a counter a function of the clock alone, so a restarted bench (or demo) carries on from
 * where the last one left off instead of starting at `BENCH_ENERGY_START` again, which read as a meter that went back.
 */
export const BENCH_ENERGY_EPOCH_MS = Date.UTC(2026, 10, 1)

/**
 * An energy counter's reading at simulated second `seconds` (the clock's seconds times `speed`): `BENCH_ENERGY_START`
 * plus what `counted` delivered since `BENCH_ENERGY_EPOCH_MS` at that pace. Never below the start, and the same
 * for the same clock, so it never goes back across restarts at one pace.
 */
export const benchEnergyTotal = (counted: (from: number, seconds: number) => number, seconds: number, speed: number) =>
  BENCH_ENERGY_START + Math.max(0, counted((BENCH_ENERGY_EPOCH_MS / 1000) * speed, seconds))

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
  const analog = device.points.map((_, index) => benchAnalogOf(device.points, index))
  const binary = device.points.map((_, index) => benchBinaryOf(device.points, index))
  const energy = device.points.map((_, index) => benchEnergyOf(device.points, index))
  const update = Effect.gen(function* () {
    const seconds = yield* simulatedSeconds(pace)
    device.points.forEach((point, index) => {
      if (point.writable) return
      if (point.dataType === "bool") return setPointValue(bank, point, binary[index]?.(seconds) ?? false)
      const float = point.dataType === "float32" || point.dataType === "float64"
      // An energy counter counts what the device's power delivered; other integers count up like a meter; other
      // floats swing through their unit's range.
      const counted = energy[index]
      if (counted !== undefined) {
        const total = benchEnergyTotal(counted, seconds, pace.speed)
        return setPointValue(bank, point, float ? Math.round(total * 1000) / 1000 : Math.floor(total))
      }
      setPointValue(bank, point, float ? (analog[index]?.(seconds) ?? 0) : Math.floor(seconds / 10) % 32_768)
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
  const analog = device.points.map((_, index) => benchAnalogOf(device.points, index))
  const binary = device.points.map((_, index) => benchBinaryOf(device.points, index))
  const energy = device.points.map((_, index) => benchEnergyOf(device.points, index))
  const update = Effect.gen(function* () {
    const seconds = yield* simulatedSeconds(pace)
    device.points.forEach((point, index) => {
      // A writable point changes only by command.
      if (point.writable) return
      const objectType = objectTypeNumber(point.objectType)
      if (objectType === undefined) return
      const object = { objectType, instance: point.instance }
      if (point.objectType.startsWith("binary-")) {
        setPresentValue(simulated, object, { type: "enumerated", value: binary[index]?.(seconds) === true ? 1 : 0 })
      } else {
        const counted = energy[index]
        const value =
          counted === undefined
            ? (analog[index]?.(seconds) ?? 0)
            : Math.round(benchEnergyTotal(counted, seconds, pace.speed) * 1000) / 1000
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

/** A port the bench or the demo listens on, and what usually holds it when it is taken. */
export interface ListenPort {
  readonly transport: "TCP" | "UDP"
  readonly host: string
  readonly port: number
  /** What it is for: `the demo's MQTT broker`. */
  readonly role: string
  /** What usually holds it when another program does: `another MQTT broker or ot-gateway demo`. */
  readonly likelyHolder: string
}

/** The ports `runBench` listens on for `config`, with the same `only` (a broker that is not local is not started). */
export const benchPorts = Effect.fn("benchPorts")(function* (
  config: GatewayConfig,
  options: Pick<BenchOptions, "only"> = {}
) {
  const ports: Array<ListenPort> = []
  if (options.only !== "devices") {
    const address = yield* parseBrokerUrl(config.mqtt.url)
    if (!address.tls && localHosts.has(address.host)) {
      ports.push({
        transport: "TCP",
        host: address.host === "localhost" ? "127.0.0.1" : address.host,
        port: address.port,
        role: "the test MQTT broker",
        likelyHolder: "another MQTT broker or ot-gateway demo"
      })
    }
  }
  if (options.only === "broker") return ports
  const endpoints = new Set<string>()
  for (const device of config.devices) {
    if (device.protocol === "modbus-tcp" && localHosts.has(device.host) && !endpoints.has(endpointOf(device))) {
      endpoints.add(endpointOf(device))
      ports.push({
        transport: "TCP",
        host: device.host === "localhost" ? "127.0.0.1" : device.host,
        port: device.port,
        role: `the simulated Modbus device ${device.id}`,
        likelyHolder: "another ot-gateway demo or test bench"
      })
    }
    const at = device.protocol === "bacnet-ip" ? simulatedBacnetAt(config, device) : undefined
    if (at !== undefined) {
      ports.push({
        transport: "UDP",
        host: at.host === "localhost" ? "127.0.0.1" : at.host,
        port: at.port,
        role: `the simulated BACnet device ${device.id}`,
        likelyHolder: "another ot-gateway demo or test bench"
      })
    }
  }
  return ports
})

/** Whether binding failed because another program holds the address, as Node says it (`EADDRINUSE`). */
const heldByAnother = (cause: unknown) => Reflect.get(Object(cause), "code") === "EADDRINUSE"

/**
 * The first of `ports` another program holds, found by binding each and letting go at once. An address that cannot
 * be bound for another reason (no IPv6 loopback, say) is left to the real start to report.
 */
export const firstPortInUse = Effect.fn("firstPortInUse")(function* (ports: ReadonlyArray<ListenPort>) {
  for (const port of ports) {
    const bind =
      port.transport === "TCP"
        ? NodeSocketServer.make({ host: port.host, port: port.port }).pipe(
            Effect.as(false),
            Effect.catchTag("SocketServerError", (error) => Effect.succeed(heldByAnother(error.reason.cause)))
          )
        : NodeDatagramSocket.make({ bind: { address: port.host, port: port.port } }).pipe(
            Effect.flatMap((socket) => socket.reader),
            Effect.as(false),
            Effect.catchTag("DatagramSocketError", (error) =>
              Effect.succeed(
                error.reason._tag === "DatagramSocketOpenError" &&
                  (error.reason.kind === "AddressInUse" || heldByAnother(error.reason.cause))
              )
            )
          )
    if (yield* Effect.scoped(bind)) return port
  }
  return undefined
})

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
