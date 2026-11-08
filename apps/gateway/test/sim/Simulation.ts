/**
 * The whole gateway under virtual time: the real pipeline, outbox, MQTT
 * client, Modbus and BACnet drivers, against the real test broker and device
 * simulators, all on an in-memory network (`MemoryNetwork`) and the test
 * clock. A seeded schedule crashes and partitions the broker, the devices and
 * the gateway's own host, loses datagrams, restarts the gateway, fills the
 * outbox's disk and steps the gateway's wall clock; a day of that takes
 * seconds, and a seed replays the same faults.
 *
 * At the end, after a quiet spell, the run checks what must hold whatever
 * happened (see `checkInvariants`).
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import {
  objectTypeNumber,
  serveSimulatedDevice,
  setPresentValue,
  type SimulatedDevice,
  simulatedDeviceFor
} from "@ot-gateway/bacnet"
import {
  type BacnetDevice,
  type GatewayConfig,
  makeMemoryNetwork,
  type MemoryNetwork,
  type ModbusDevice,
  parseConfig
} from "@ot-gateway/core"
import {
  decodeValue,
  FunctionCode,
  makeRegisterBank,
  makeSimulatorControl,
  serveModbus,
  setPointValue,
  type SimulatorControl
} from "@ot-gateway/modbus"
import { type BrokerControl, makeBrokerControl, publishToSubscribers, serveMqtt } from "@ot-gateway/mqtt"
import { Clock, Effect, Exit, Fiber, Logger, Random, Schedule, Scope } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "@ot-gateway/buffer"
import { classifySqliteError, SqlError } from "effect/sql/SqlError"
import { runGateway } from "../../src/Gateway.ts"

export const GATEWAY = "10.0.0.1"
export const BROKER = "10.0.0.2"
const modbusHost = (index: number) => `10.0.1.${index + 1}`
const bacnetHost = (index: number) => `10.0.2.${index + 1}`

export interface SimulationOptions {
  readonly seed: number
  readonly hours: number
  /** Modbus meters and BACnet air handlers, each (default 2). */
  readonly devices?: number
  /** Mean time between faults (default 20 minutes). */
  readonly meanFaultGapMinutes?: number
  /** Mean time between commands (default 10 minutes). */
  readonly meanCommandGapMinutes?: number
}

/** A small, fast, seedable generator (mulberry32), so a schedule is the same for a seed on every machine. */
export const seeded = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export type FaultKind =
  | "broker-crash"
  | "broker-partition"
  | "device-crash"
  | "device-partition"
  | "datagram-loss"
  | "gateway-partition"
  | "gateway-restart"
  | "disk-full"
  | "clock-step"

export interface Fault {
  readonly at: number
  readonly kind: FaultKind
  /** The device id for device faults, `disk` or `clock`, else the host. */
  readonly target: string
  readonly durationMs: number
  /** How far a clock step moves the gateway's wall clock (NTP; a Pi has no real-time clock), in either direction. */
  readonly stepMs?: number
}

const weights: ReadonlyArray<readonly [FaultKind, number]> = [
  ["broker-crash", 3],
  ["broker-partition", 2],
  ["device-crash", 3],
  ["device-partition", 2],
  ["datagram-loss", 2],
  ["gateway-partition", 1],
  ["gateway-restart", 2],
  ["disk-full", 2],
  ["clock-step", 2]
]

/** The faults of a run: none in the first 5 minutes or the last `quietMs`, at most one at a time per target. */
export const faultSchedule = (
  random: () => number,
  config: GatewayConfig,
  totalMs: number,
  quietMs: number,
  meanGapMs: number
): ReadonlyArray<Fault> => {
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0)
  const pick = <A>(items: ReadonlyArray<A>): A | undefined => items[Math.floor(random() * items.length)]
  const modbus = config.devices.filter((device) => device.protocol === "modbus-tcp").map((device) => device.id)
  const bacnet = config.devices.filter((device) => device.protocol === "bacnet-ip").map((device) => device.id)
  const busyUntil = new Map<string, number>()
  const faults: Array<Fault> = []
  let at = 5 * 60_000
  while (true) {
    at += Math.round(-Math.log(1 - random()) * meanGapMs)
    let roll = random() * total
    const kind = weights.find(([, weight]) => (roll -= weight) < 0)?.[0] ?? "broker-crash"
    // Mostly short faults, sometimes long ones: 10 s to 2 min, or up to 30 min.
    const durationMs = Math.round(random() < 0.8 ? 10_000 + random() * 110_000 : 120_000 + random() * 1_680_000)
    const target =
      kind === "device-crash" || kind === "device-partition"
        ? pick([...modbus, ...bacnet])
        : kind === "datagram-loss"
          ? pick(bacnet)
          : kind === "broker-crash" || kind === "broker-partition"
            ? BROKER
            : kind === "disk-full"
              ? "disk"
              : kind === "clock-step"
                ? "clock"
                : GATEWAY
    if (at + durationMs > totalMs - quietMs) break
    if (target === undefined || (busyUntil.get(target) ?? 0) > at) continue
    busyUntil.set(target, at + durationMs)
    if (kind === "clock-step") {
      // A step stays: the wall clock is wrong from here on, by 10 s to 2 h, ahead or behind.
      const stepMs = Math.round((random() < 0.5 ? -1 : 1) * (10_000 + random() * 7_190_000))
      faults.push({ at, kind, target, durationMs: 0, stepMs })
      continue
    }
    faults.push({
      at,
      kind,
      target,
      durationMs: kind === "gateway-restart" ? Math.min(durationMs, 60_000) : durationMs
    })
  }
  return faults
}

export const simulationConfig = (devices: number, bufferPath: string) =>
  parseConfig(
    JSON.stringify({
      site: "sim",
      building: "building-a",
      mqtt: { url: `mqtt://${BROKER}:1883`, clientId: "ot-gateway-sim" },
      buffer: { path: bufferPath },
      devices: [
        ...Array.from({ length: devices }, (_, index) => ({
          protocol: "modbus-tcp",
          id: `meter-${index + 1}`,
          host: modbusHost(index),
          pollIntervalMs: 5_000,
          points: [
            { id: "power", name: "power", table: "holding", address: 100, dataType: "float32", deadband: 0.5 },
            { id: "energy", name: "energy", table: "input", address: 0, dataType: "uint32" },
            { id: "tripped", name: "tripped", table: "discrete", address: 0, dataType: "bool" },
            {
              id: "setpoint",
              name: "setpoint",
              table: "holding",
              address: 200,
              dataType: "float32",
              writable: true,
              limits: { min: 15, max: 25 }
            }
          ]
        })),
        ...Array.from({ length: devices }, (_, index) => ({
          protocol: "bacnet-ip",
          id: `ahu-${index + 1}`,
          deviceInstance: 2001 + index,
          address: bacnetHost(index),
          pollIntervalMs: 10_000,
          points: [
            { id: "supply-temp", name: "supply-temp", objectType: "analog-input", instance: 1, deadband: 0.5 },
            { id: "valve", name: "valve", objectType: "analog-output", instance: 1, deadband: 1 },
            { id: "fan", name: "fan", objectType: "binary-input", instance: 1 },
            {
              id: "damper",
              name: "damper",
              objectType: "analog-output",
              instance: 2,
              writable: true,
              limits: { min: 0, max: 100 }
            }
          ]
        }))
      ]
    })
  )

/** Values that move like a building's: slow sines, a counter, and flags that flip. */
const sine = (seconds: number, index: number) => 50 + 50 * Math.sin((2 * Math.PI * seconds) / 1800 + index)

const runModbusDevice = (network: MemoryNetwork, device: ModbusDevice, control: SimulatorControl) =>
  Effect.gen(function* () {
    const server = yield* network.listen(device.host, device.port)
    const bank = makeRegisterBank()
    // Writable points start at 20 and then only change by command.
    for (const point of device.points) if (point.writable) setPointValue(bank, point, 20)
    const update = Effect.gen(function* () {
      const seconds = (yield* Clock.currentTimeMillis) / 1000
      device.points.forEach((point, index) => {
        if (point.writable) return
        if (point.dataType === "bool") return setPointValue(bank, point, Math.floor(seconds / 900) % 2 === 0)
        setPointValue(bank, point, point.dataType === "float32" ? sine(seconds, index) : Math.floor(seconds / 60))
      })
    })
    yield* update.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped)
    return yield* serveModbus(server, bank, control)
  }).pipe(Effect.scoped)

const runBacnetDevice = (network: MemoryNetwork, device: BacnetDevice, host: string, simulated: SimulatedDevice) =>
  Effect.gen(function* () {
    const update = Effect.gen(function* () {
      const seconds = (yield* Clock.currentTimeMillis) / 1000
      device.points.forEach((point, index) => {
        if (point.writable) return
        const objectType = objectTypeNumber(point.objectType)
        if (objectType === undefined) return
        const object = { objectType, instance: point.instance }
        if (point.objectType.startsWith("binary-")) {
          setPresentValue(simulated, object, { type: "enumerated", value: Math.floor(seconds / 900) % 2 })
        } else {
          setPresentValue(simulated, object, { type: "real", value: Math.round(sine(seconds, index) * 100) / 100 })
        }
      })
    })
    yield* update.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped)
    yield* serveSimulatedDevice(yield* network.host(host).udp({ address: host, port: 47_808 }), simulated)
    return yield* Effect.never
  }).pipe(Effect.scoped)

export interface Received {
  readonly topic: string
  readonly payload: string
  readonly retain: boolean
  /** When it was accepted, on the simulation's clock (the gateway's wall clock may be stepped). */
  readonly at: number
  readonly correlationData?: Uint8Array
}

/** What a command is meant to test; everything but `valid` must be refused before any device sees it. */
export type CommandKind =
  | "valid"
  | "out-of-range"
  | "wrong-type"
  | "not-writable"
  | "unknown-point"
  | "invalid-payload"
  | "retained"

export interface SentCommand {
  readonly id: number
  readonly kind: CommandKind
  readonly device: string
  readonly point: string
  /** The value asked for: unique per command, so a write at a device names its command. */
  readonly value: number
  readonly at: number
  /** Whether the broker was up to take it. */
  readonly delivered: boolean
}

/** A write a simulated device applied: the device, the object or register, and the value. */
export interface DeviceWrite {
  readonly device: string
  readonly target: string
  readonly value: number
}

export const RESPONSES = "sim/responses"

const commandKinds: ReadonlyArray<readonly [CommandKind, number]> = [
  ["valid", 12],
  ["out-of-range", 2],
  ["wrong-type", 1],
  ["not-writable", 1],
  ["unknown-point", 1],
  ["invalid-payload", 1],
  ["retained", 1]
]

/** Commands at random times (about every `meanGapMs`), with values no two commands share. */
export const commandSchedule = (
  random: () => number,
  config: GatewayConfig,
  totalMs: number,
  quietMs: number,
  meanGapMs: number
): ReadonlyArray<Omit<SentCommand, "delivered">> => {
  const total = commandKinds.reduce((sum, [, weight]) => sum + weight, 0)
  const meters = config.devices.filter((device) => device.protocol === "modbus-tcp").map((device) => device.id)
  const ahus = config.devices.filter((device) => device.protocol === "bacnet-ip").map((device) => device.id)
  const commands: Array<Omit<SentCommand, "delivered">> = []
  let at = 5 * 60_000
  for (let id = 1; ; id++) {
    at += Math.round(-Math.log(1 - random()) * meanGapMs)
    if (at > totalMs - quietMs) return commands
    let roll = random() * total
    const kind = commandKinds.find(([, weight]) => (roll -= weight) < 0)?.[0] ?? "valid"
    const onMeter = kind === "unknown-point" || random() < 0.5
    const device = (onMeter ? meters : ahus)[Math.floor(random() * (onMeter ? meters.length : ahus.length))] ?? ""
    // Valid values are unique: 15 + id/1000 for a setpoint (15 to 25), id/100 for a damper (0 to 100).
    const valid = onMeter ? 15 + (id % 10_000) / 1000 : (id % 10_000) / 100
    const point =
      kind === "unknown-point"
        ? "nothing"
        : kind === "not-writable"
          ? onMeter
            ? "power"
            : "valve"
          : onMeter
            ? "setpoint"
            : "damper"
    const value = kind === "out-of-range" ? 1000 + id : valid
    commands.push({ id, kind, device, point, value, at })
  }
}

export interface SimulationRun {
  readonly config: GatewayConfig
  readonly faults: ReadonlyArray<Fault>
  /** Values the gateway's publisher accepted, in order. */
  readonly accepted: ReadonlyArray<Received>
  /** Everything the broker accepted, in order, across its restarts. */
  readonly received: ReadonlyArray<Received>
  /** Warnings and errors the gateway logged. */
  readonly problems: ReadonlyArray<string>
  /** Rows left in the outbox once the gateway stopped. */
  readonly backlog: number
  /** Open connection ends of the gateway's host while it ran at the end, and after it stopped. */
  readonly gatewayEnds: { readonly running: number; readonly stopped: number }
  readonly udpEndpointsAfterStop: number
  readonly datagramsLost: number
  readonly commands: ReadonlyArray<SentCommand>
  /** Every write the simulated devices applied, across their restarts. */
  readonly deviceWrites: ReadonlyArray<DeviceWrite>
}

/** What SQLite raises when the disk is full: SQLITE_FULL (13), as `node:sqlite` reports it. */
const diskFull = () =>
  new SqlError({
    reason: classifySqliteError(
      Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13 }),
      { message: "Failed to execute statement", operation: "execute" }
    )
  })

/**
 * The real outbox, except that every write fails with SQLITE_FULL while
 * `disk.full` is set, as on an SD card that filled up under the running
 * gateway. Reads still work, as they do on a full disk.
 */
const outboxOnDisk = (disk: { full: boolean }): typeof openDatabase => {
  const write =
    <Args extends ReadonlyArray<unknown>, A, E>(operation: (...args: Args) => Effect.Effect<A, E>) =>
    (...args: Args) =>
      Effect.suspend((): Effect.Effect<A, E | SqlError> => (disk.full ? Effect.fail(diskFull()) : operation(...args)))
  return (path) =>
    Effect.map(openDatabase(path), (database) => {
      const outbox = database.outbox
      return {
        ...database,
        outbox: {
          ...outbox,
          append: write(outbox.append),
          remove: write(outbox.remove),
          removeThrough: write(outbox.removeThrough),
          dropOldest: write(outbox.dropOldest),
          vacuum: Effect.suspend(() => (disk.full ? Effect.fail(diskFull()) : outbox.vacuum))
        }
      }
    })
}

/**
 * The simulation's clock with the wall clock moved by `offset()`: what NTP
 * does to a Raspberry Pi, which has no real-time clock. Monotonic time and
 * sleeps are untouched, as they are on Linux.
 */
const steppedClock = (clock: Clock.Clock, offset: () => number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + offset(),
  currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + offset()),
  currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() + BigInt(offset()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => clock.currentTimeNanosUnsafe() + BigInt(offset()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  sleep: (duration) => clock.sleep(duration)
})

/** Let real I/O (the outbox's file checks) finish between steps of virtual time. */
const realTick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))

/** Advance virtual time until `fiber` is done (a shutdown waiting on its own timeouts). */
const advanceUntilDone = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let second = 0; second < 600 && fiber.pollUnsafe() === undefined; second++) {
      yield* TestClock.adjust("1 second")
      yield* realTick
    }
    return yield* Fiber.join(fiber)
  })

export const simulate = (options: SimulationOptions) =>
  Effect.gen(function* () {
    const random = seeded(options.seed)
    const directory = mkdtempSync(join(tmpdir(), "ot-gateway-sim-"))
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { recursive: true, force: true })))
    const bufferPath = join(directory, "buffer.sqlite")
    const config = yield* simulationConfig(options.devices ?? 2, bufferPath)
    const totalMs = options.hours * 3_600_000
    const quietMs = 10 * 60_000
    const faults = faultSchedule(random, config, totalMs, quietMs, (options.meanFaultGapMinutes ?? 20) * 60_000)

    const network = makeMemoryNetwork(random)
    const clock = yield* Clock.clockWith(Effect.succeed)
    const disk = { full: false }
    let wallOffset = 0
    const world = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(world, Exit.void))

    const received: Array<Received> = []
    const accepted: Array<Received> = []
    const problems: Array<string> = []
    const logger = Logger.layer([
      Logger.make(({ logLevel, message }) => {
        if (logLevel !== "Warn" && logLevel !== "Error" && logLevel !== "Fatal") return
        problems.push(`${logLevel}: ${(Array.isArray(message) ? message : [message]).join(" ")}`)
      })
    ])
    const start = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.provide(logger),
        Effect.forkIn(world),
        Effect.map((fiber) => ({ fiber }))
      )

    // The running broker's control, to send commands through; undefined while it is down.
    let brokerControl: BrokerControl | undefined
    const startBroker = Effect.gen(function* () {
      const control = makeBrokerControl()
      control.onMessage = (message) =>
        received.push({
          topic: message.topic,
          payload: message.payload,
          retain: message.retain,
          at: clock.currentTimeMillisUnsafe(),
          ...(message.correlationData === undefined ? {} : { correlationData: message.correlationData })
        })
      brokerControl = control
      return yield* start(
        Effect.scoped(Effect.flatMap(network.listen(BROKER, 1883), (server) => serveMqtt(server, control)))
      )
    })
    // Every incarnation of every device, so the writes they applied can be read at the end.
    const modbusControls: Array<{ readonly device: string; readonly control: SimulatorControl }> = []
    const bacnetDevices: Array<{ readonly device: string; readonly simulated: SimulatedDevice }> = []
    const startDevice = (id: string) => {
      const index = config.devices.findIndex((device) => device.id === id)
      const device = config.devices[index]
      if (device?.protocol === "modbus-tcp") {
        const control = makeSimulatorControl()
        modbusControls.push({ device: id, control })
        return start(runModbusDevice(network, device, control))
      }
      if (device?.protocol === "bacnet-ip") {
        const simulated = simulatedDeviceFor(device)
        bacnetDevices.push({ device: id, simulated })
        return start(runBacnetDevice(network, device, device.address ?? "", simulated))
      }
      return Effect.die(new Error(`no simulated device ${id}`))
    }
    const hostOf = (id: string) => {
      const device = config.devices.find((candidate) => candidate.id === id)
      if (device?.protocol === "modbus-tcp") return device.host
      if (device?.protocol === "bacnet-ip") return device.address ?? ""
      return id
    }
    const startGateway = start(
      runGateway(config, {
        network: network.host(GATEWAY),
        buffer: { openDatabase: outboxOnDisk(disk) },
        onAccepted: (topic, payload, publishOptions) => {
          // Values only: retained metadata and health, and transient command results, are not buffered.
          if (publishOptions?.retain !== true && publishOptions?.transient !== true) {
            accepted.push({ topic, payload, retain: false, at: clock.currentTimeMillisUnsafe() })
          }
        }
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(
          Clock.Clock,
          steppedClock(clock, () => wallOffset)
        ),
        Random.withSeed(options.seed)
      )
    )

    let broker = yield* startBroker
    const devices = new Map<string, { readonly fiber: Fiber.Fiber<unknown, unknown> }>()
    for (const device of config.devices) {
      if (device.protocol !== "simulator") devices.set(device.id, yield* startDevice(device.id))
    }
    let gateway = yield* startGateway

    // The fault schedule runs in virtual time, like everything else.
    const events = faults
      .flatMap((fault) => [
        { at: fault.at, fault, phase: "start" as const },
        { at: fault.at + fault.durationMs, fault, phase: "end" as const }
      ])
      .toSorted((a, b) => a.at - b.at)
    const runFaults = Effect.gen(function* () {
      for (const { at, fault, phase } of events) {
        yield* Effect.sleep(Math.max(0, at - (yield* Clock.currentTimeMillis)))
        const starting = phase === "start"
        switch (fault.kind) {
          case "broker-crash":
            if (starting) {
              brokerControl = undefined
              yield* Fiber.interrupt(broker.fiber)
            } else broker = yield* startBroker
            break
          case "device-crash": {
            const device = devices.get(fault.target)
            if (starting && device !== undefined) yield* Fiber.interrupt(device.fiber)
            if (!starting) devices.set(fault.target, yield* startDevice(fault.target))
            break
          }
          case "gateway-restart":
            if (starting) yield* Fiber.interrupt(gateway.fiber)
            else gateway = yield* startGateway
            break
          case "datagram-loss":
            network.setLoss(hostOf(fault.target), starting ? 0.3 : 0)
            break
          case "disk-full":
            disk.full = starting
            break
          case "clock-step":
            if (starting) wallOffset += fault.stepMs ?? 0
            break
          case "broker-partition":
          case "device-partition":
          case "gateway-partition":
            network.partition(hostOf(fault.target), starting)
        }
      }
    })
    yield* runFaults.pipe(Effect.forkIn(world))

    // Commands, sent like an application would: QoS 1, a response topic, the command's id as correlation data.
    const schedule = commandSchedule(random, config, totalMs, quietMs, (options.meanCommandGapMinutes ?? 10) * 60_000)
    const commands: Array<SentCommand> = []
    const runCommands = Effect.gen(function* () {
      for (const command of schedule) {
        yield* Effect.sleep(Math.max(0, command.at - (yield* Clock.currentTimeMillis)))
        const control = brokerControl
        // When it actually went out: clearing a retained command holds the next ones back for five minutes,
        // and the invariants judge a command by the faults around the moment it was sent, not when it was due.
        commands.push({ ...command, at: yield* Clock.currentTimeMillis, delivered: control !== undefined })
        if (control === undefined) continue
        const topic = `${config.site}/${config.building}/${command.device}/${command.point}/$set`
        const value = command.kind === "wrong-type" ? true : command.value
        publishToSubscribers(control, {
          topic,
          payload: command.kind === "invalid-payload" ? "{not json" : JSON.stringify({ value }),
          qos: 1,
          retain: command.kind === "retained",
          responseTopic: RESPONSES,
          correlationData: new Uint8Array(new Uint32Array([command.id]).buffer)
        })
        // A retained command is cleared after a while, as an operator would once it was refused.
        if (command.kind === "retained") {
          yield* Effect.sleep("5 minutes")
          if (brokerControl === control) {
            publishToSubscribers(control, { topic, payload: "", qos: 1, retain: true })
          }
        }
      }
    })
    yield* runCommands.pipe(Effect.forkIn(world))

    for (let elapsed = 0; elapsed < totalMs; elapsed += 1000) {
      yield* TestClock.adjust("1 second")
      if (elapsed % 60_000 === 0) yield* realTick
    }

    const running = network.stats().openEnds.get(GATEWAY) ?? 0
    yield* advanceUntilDone(yield* Fiber.interrupt(gateway.fiber).pipe(Effect.forkIn(world)))
    const stopped = network.stats()
    const database = new DatabaseSync(bufferPath, { readOnly: true })
    const backlog = Number(database.prepare("SELECT COUNT(*) AS n FROM outbox").get()?.["n"] ?? -1)
    database.close()
    return {
      config,
      faults,
      accepted,
      received,
      problems,
      backlog,
      gatewayEnds: { running, stopped: stopped.openEnds.get(GATEWAY) ?? 0 },
      udpEndpointsAfterStop: stopped.udpEndpoints,
      datagramsLost: stopped.datagramsLost,
      commands,
      deviceWrites: [
        ...modbusControls.flatMap(({ device, control }) =>
          control.writes.map((write): DeviceWrite => {
            if (write.functionCode === FunctionCode.WriteMultipleRegisters) {
              return {
                device,
                target: `register ${write.address}`,
                value: Number(decodeValue(write.values, "float32"))
              }
            }
            return { device, target: `${write.functionCode} ${write.address}`, value: Number(write.value) }
          })
        ),
        ...bacnetDevices.flatMap(({ device, simulated }) =>
          simulated.writes.map((write): DeviceWrite => ({
            device,
            target: `object ${write.object.objectType}:${write.object.instance}`,
            value: write.value.type === "real" ? write.value.value : Number.NaN
          }))
        )
      ]
    } satisfies SimulationRun
  }).pipe(Effect.scoped)
