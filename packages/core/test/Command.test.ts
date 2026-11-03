/**
 * The command guard: what reaches a device, in which units, and what every
 * command gets back. A recording driver stands in for the device.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Metric, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
  commands,
  type Device,
  type Driver,
  DriverError,
  makeCommandGuard,
  makeDriverRegistry,
  makeMemoryPublisher,
  monotonicMillis,
  parseConfig,
  toDeviceUnits,
  type WriteValue,
  withMetricAttributes
} from "../src/index.ts"

const config = parseConfig(
  JSON.stringify({
    site: "s",
    building: "b",
    mqtt: { url: "mqtt://broker" },
    devices: [
      {
        protocol: "modbus-tcp",
        id: "meter",
        host: "10.0.1.1",
        points: [
          {
            id: "setpoint",
            name: "Setpoint",
            table: "holding",
            address: 100,
            dataType: "int16",
            writable: true,
            limits: { min: 15, max: 25 },
            scaling: { factor: 0.1 }
          },
          { id: "enable", name: "Enable", table: "coil", address: 0, dataType: "bool", writable: true },
          { id: "power", name: "Power", table: "input", address: 0, dataType: "float32" }
        ]
      },
      {
        protocol: "bacnet-ip",
        id: "ahu",
        deviceInstance: 2001,
        points: [
          {
            id: "valve",
            name: "Valve",
            objectType: "analog-output",
            instance: 1,
            writable: true,
            limits: { min: 0, max: 100 }
          },
          {
            id: "mode",
            name: "Mode",
            objectType: "multi-state-value",
            instance: 2,
            writable: true,
            limits: { min: 1, max: 4 }
          },
          // Object type and property by number: a binary output's present value, binary all the same.
          { id: "fan", name: "Fan", objectType: "4", instance: 3, property: "85", writable: true }
        ]
      }
    ]
  })
)

/** A command result as published; decoded like any MQTT payload. */
const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.String,
      reason: Schema.optionalKey(Schema.String),
      value: Schema.optionalKey(Schema.Unknown)
    })
  )
)

const count = (attributes: Record<string, string>) =>
  Metric.value(Metric.withAttributes(commands, { test: "commands", ...attributes })).pipe(
    Effect.map((state) => state.count)
  )

/** A config with one Modbus device holding `point`. */
const modbusConfig = (point: Record<string, unknown>) =>
  JSON.stringify({
    site: "s",
    building: "b",
    mqtt: { url: "mqtt://broker" },
    devices: [{ protocol: "modbus-tcp", id: "m", host: "h", points: [{ id: "p", name: "p", ...point }] }]
  })

/** A driver that records writes, and fails or hangs when told to. */
const recordingDriver = (device: Device) => {
  const writes: Array<readonly [string, WriteValue]> = []
  const state = { fail: undefined as DriverError | undefined, hang: false }
  const driver: Driver = {
    deviceId: device.id,
    points: device.points,
    readAll: Effect.succeed([]),
    write: (pointId, value) =>
      Effect.suspend(() => {
        if (state.hang) return Effect.never
        if (state.fail !== undefined) return Effect.fail(state.fail)
        writes.push([pointId, value])
        return Effect.void
      })
  }
  return { driver, writes, state }
}

const setup = Effect.fnUntraced(function* () {
  const { devices } = yield* config
  const [meterDevice, ahuDevice] = devices
  if (meterDevice === undefined || ahuDevice === undefined) return yield* Effect.die(new Error("devices missing"))
  const drivers = makeDriverRegistry()
  const meter = recordingDriver(meterDevice)
  const ahu = recordingDriver(ahuDevice)
  yield* drivers.register(meter.driver)
  yield* drivers.register(ahu.driver)
  const { messages, layer } = yield* makeMemoryPublisher
  const outcomes: Array<{ readonly device: string; readonly point: string }> = []
  const guard = makeCommandGuard({
    site: "s",
    building: "b",
    devices,
    drivers,
    onOutcome: (command) => outcomes.push(command)
  })
  const send = (
    topic: string,
    payload: unknown,
    extra: { retain?: boolean; receivedAt?: number; expirySeconds?: number } = {}
  ) =>
    Effect.gen(function* () {
      const now = yield* monotonicMillis
      yield* guard.handle({
        topic: `s/b/${topic}/$set`,
        payload: typeof payload === "string" ? payload : JSON.stringify(payload),
        retain: extra.retain ?? false,
        receivedAt: extra.receivedAt ?? now,
        ...(extra.expirySeconds === undefined ? {} : { expirySeconds: extra.expirySeconds }),
        correlationData: Uint8Array.of(7)
      })
    }).pipe(Effect.provide(layer))
  const results = () => messages.map((message) => decodeResult(message.payload))
  return { meter, ahu, messages, send, results, guard, outcomes }
})

describe("command guard", () => {
  it.effect("writes an in-range value in device units and answers once, with the correlation data", () =>
    Effect.gen(function* () {
      const { meter, ahu, messages, send, results, guard } = yield* setup()
      expect(guard.filter).toBe("s/b/+/+/$set")
      yield* send("meter/setpoint", { value: 21.5 })
      // 19.9 / 0.1 is 198.99999999999997 in floating point: still register value 199, not a refusal.
      yield* send("meter/setpoint", { value: 19.9 })
      yield* send("meter/enable", { value: true })
      yield* send("ahu/valve", { value: null })
      yield* send("ahu/mode", { value: 3 })
      yield* send("ahu/fan", { value: true })
      // Scaling factor 0.1: 21.5 °C is register value 215.
      expect(meter.writes).toEqual([
        ["setpoint", 215],
        ["setpoint", 199],
        ["enable", true]
      ])
      expect(ahu.writes).toEqual([
        ["valve", null],
        ["mode", 3],
        ["fan", true]
      ])
      expect(results().map(({ status, value }) => [status, value])).toEqual([
        ["written", 21.5],
        ["written", 19.9],
        ["written", true],
        ["written", null],
        ["written", 3],
        ["written", true]
      ])
      // Always on …/$set/result (the simulation checks the correlation data end to end).
      expect(messages[0]?.topic).toBe("s/b/meter/setpoint/$set/result")
    }).pipe(Effect.scoped)
  )

  it.effect("rejects what is unsafe before it reaches a device, and says why", () =>
    Effect.gen(function* () {
      const { meter, ahu, send, results } = yield* setup()
      yield* send("meter/setpoint", { value: 20 }, { retain: true })
      yield* send("meter/nothing", { value: 20 })
      yield* send("meter/power", { value: 20 })
      yield* send("meter/setpoint", "21")
      yield* send("meter/setpoint", { value: "21" })
      yield* send("meter/setpoint", { value: true })
      yield* send("meter/enable", { value: 1 })
      yield* send("meter/setpoint", { value: null })
      yield* send("meter/setpoint", { value: 25.01 })
      yield* send("ahu/valve", { value: -1 })
      // Anything beside the value: no other message, a command result included, passes for a command.
      yield* send("meter/setpoint", { status: "written", value: 20, ts: 1 })
      yield* send("ahu/mode", { value: 2.5 })
      yield* send("ahu/fan", { value: 1 })
      expect(results().map(({ status, reason }) => `${status} ${reason ?? ""}`)).toEqual([
        "rejected retained",
        "rejected unknown-point",
        "rejected not-writable",
        "rejected invalid-payload",
        "rejected invalid-payload",
        "rejected wrong-type",
        "rejected wrong-type",
        "rejected wrong-type",
        "rejected out-of-range",
        "rejected out-of-range",
        "rejected invalid-payload",
        "rejected wrong-type",
        "rejected wrong-type"
      ])
      expect([...meter.writes, ...ahu.writes]).toEqual([])
    }).pipe(Effect.scoped)
  )

  it.effect("fails a command when the device is down, refuses, or does not answer in time", () =>
    Effect.gen(function* () {
      const { meter, send, results } = yield* setup()
      meter.state.fail = new DriverError({ device: "meter", reason: "protocol", message: "illegal_data_address" })
      yield* send("meter/setpoint", { value: 20 })
      meter.state.fail = undefined
      meter.state.hang = true
      const hanging = yield* send("meter/setpoint", { value: 20 }).pipe(Effect.forkChild)
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(hanging)
      expect(results().map(({ status, reason }) => `${status} ${reason ?? ""}`)).toEqual([
        "failed protocol",
        "failed timeout"
      ])
    }).pipe(Effect.scoped)
  )

  it.effect("refuses a command that waited longer than its maximum age or its message expiry", () =>
    Effect.gen(function* () {
      const { meter, send, results } = yield* setup()
      const now = yield* monotonicMillis
      yield* send("meter/setpoint", { value: 20 }, { receivedAt: now - 10_001 })
      yield* send("meter/setpoint", { value: 20 }, { receivedAt: now - 2_000, expirySeconds: 1 })
      yield* send("meter/setpoint", { value: 21 }, { receivedAt: now - 9_000 })
      expect(results().map(({ status, reason }) => `${status} ${reason ?? ""}`)).toEqual([
        "rejected expired",
        "rejected expired",
        "written "
      ])
      expect(meter.writes).toEqual([["setpoint", 210]])
    }).pipe(Effect.scoped)
  )

  it.effect("keeps topic levels from senders short in what it records", () =>
    Effect.gen(function* () {
      const { send, outcomes } = yield* setup()
      yield* send(`${"x".repeat(100_000)}/p`, { value: 1 })
      expect(outcomes[0]?.device).toHaveLength(65)
      expect(outcomes[0]?.point).toBe("p")
    }).pipe(Effect.scoped)
  )

  it.effect("counts every command by outcome and reason", () =>
    Effect.gen(function* () {
      const { send } = yield* setup()
      yield* send("meter/setpoint", { value: 20 })
      yield* send("meter/setpoint", { value: 99 })
      expect(yield* count({ outcome: "written" })).toBe(1)
      expect(yield* count({ outcome: "rejected", reason: "out-of-range" })).toBe(1)
    }).pipe(Effect.scoped, withMetricAttributes({ test: "commands" }))
  )
})

describe("toDeviceUnits", () => {
  it("undoes scaling, and lands on the whole number floating point just missed", () => {
    expect(toDeviceUnits(19.9, { factor: 0.1, offset: 0 })).toBe(199)
    expect(toDeviceUnits(0.7, { factor: 0.1, offset: 0 })).toBe(7)
    expect(toDeviceUnits(22.7, { factor: 0.1, offset: 0 })).toBe(227)
    expect(toDeviceUnits(-40, { factor: 0.5, offset: -50 })).toBe(20)
    // A real fraction stays one: the driver refuses it for an integer register.
    expect(toDeviceUnits(19.95, { factor: 0.1, offset: 0 })).toBeCloseTo(199.5)
    expect(toDeviceUnits(3.3, undefined)).toBe(3.3)
  })
})

describe("config for writable points", () => {
  it.effect("requires limits on writable numeric points and refuses writable read-only tables", () =>
    Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(
        [
          { table: "holding", address: 0, dataType: "uint16", writable: true },
          { table: "input", address: 0, dataType: "uint16", writable: true, limits: { min: 0, max: 1 } },
          { table: "holding", address: 0, dataType: "uint16", writable: true, limits: { min: 2, max: 1 } },
          { table: "coil", address: 0, dataType: "bool", writable: true },
          { table: "holding", address: 0, dataType: "uint16", writable: true, limits: { min: 0, max: 10 } }
        ],
        (point) => Effect.exit(parseConfig(modbusConfig(point)))
      )
      expect(outcomes.map((exit) => exit._tag)).toEqual(["Failure", "Failure", "Failure", "Success", "Success"])
    })
  )
})
