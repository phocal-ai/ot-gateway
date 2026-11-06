import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import {
  addReading,
  closeWindow,
  DriverError,
  interruptWindow,
  makeMemoryPublisher,
  openWindow,
  parseConfig,
  publishOf,
  runDevice,
  windowEnd
} from "../src/index.ts"
import type { AnyPoint, DeviceContext, Driver, Publish } from "../src/index.ts"

describe("publish modes, the pure part", () => {
  it("takes the point's mode, then its deadband as change mode, then the device's, then every read", () => {
    const device: Publish = { mode: "aggregate", intervalMs: 60_000 }
    expect(publishOf(device, { publish: { mode: "sample" } })).toEqual({ mode: "sample" })
    expect(publishOf(device, { deadband: 0.5 })).toEqual({ mode: "change", deadband: 0.5 })
    expect(publishOf(device, {})).toEqual(device)
    expect(publishOf(undefined, {})).toEqual({ mode: "sample" })
  })

  it("aligns windows to the clock", () => {
    expect(windowEnd(0, 900_000)).toBe(900_000)
    expect(windowEnd(899_999, 900_000)).toBe(900_000)
    expect(windowEnd(900_000, 900_000)).toBe(1_800_000)
  })

  it("weights the average by how long each value held", () => {
    // 10 for 1 s, then 40 for 3 s: the time-weighted average is 32.5, the plain average of the reads 25.
    let window = addReading(openWindow(0), 10, 0, 0)
    window = addReading(window, 40, 1000, 1000)
    const { message, next } = closeWindow(window, 4000, 4000, 4000, "unit:DEG_C")
    expect(message).toEqual({
      value: 32.5,
      min: 10,
      max: 40,
      avg: 32.5,
      last: 40,
      count: 2,
      from: 0,
      to: 4000,
      ts: 4000,
      unit: "unit:DEG_C"
    })
    // The value that held at the close carries into the next window.
    expect(closeWindow(next, 8000, 8000, 4000, undefined).message).toMatchObject({
      value: 40,
      min: 40,
      max: 40,
      count: 0
    })
  })

  it("marks the first window partial when the gateway started inside it", () => {
    const window = addReading(openWindow(0), 5, 0, 2500)
    expect(closeWindow(window, 1500, 4000, 4000, undefined).message).toMatchObject({ from: 2500, partial: true })
  })

  it("gives a boolean's share of time true as avg, and its last value as value", () => {
    let window = addReading(openWindow(0), true, 0, 0)
    window = addReading(window, false, 1000, 1000)
    const { message } = closeWindow(window, 4000, 4000, 4000, undefined)
    expect(message).toEqual({ value: false, avg: 0.25, last: false, count: 2, from: 0, to: 4000, ts: 4000 })
  })

  it("does not average an outage as if the last value held", () => {
    const window = interruptWindow(addReading(openWindow(0), 10, 0, 0), 1000)
    // 10 held for 1 s before the device stopped answering; nothing is known after that.
    const { message, next } = closeWindow(window, 4000, 4000, 4000, undefined)
    expect(message).toMatchObject({ avg: 10, count: 1 })
    expect(closeWindow(next, 8000, 8000, 4000, undefined).message).toBeUndefined()
  })

  it("keeps a window whole when the device comes back inside it", () => {
    let window = interruptWindow(addReading(openWindow(0, 10), 10, 0, 0), 1000)
    window = addReading(window, 20, 3000, 3000)
    // 10 for 1 s, an outage, then 20 for 1 s.
    expect(closeWindow(window, 4000, 4000, 4000, undefined).message).toMatchObject({ avg: 15, from: 0, count: 2 })
  })
})

const withDevicePublish = (publish: unknown, pollIntervalMs = 5000) =>
  JSON.stringify({
    site: "s",
    building: "b",
    mqtt: { url: "mqtt://localhost:1883" },
    devices: [
      {
        protocol: "simulator",
        id: "sim",
        pollIntervalMs,
        publish,
        points: [{ id: "t", name: "T", waveform: "sine", min: 0, max: 1 }]
      }
    ]
  })

describe("publish modes in the config", () => {
  it.effect("takes the three modes", () =>
    Effect.gen(function* () {
      for (const publish of [
        { mode: "sample" },
        { mode: "sample", intervalMs: 60_000 },
        { mode: "aggregate", intervalMs: 900_000 },
        { mode: "change", deadband: 0.5, maxSilenceMs: 3_600_000 }
      ]) {
        const config = yield* parseConfig(withDevicePublish(publish))
        expect(config.devices[0]?.publish).toEqual(publish)
      }
    })
  )

  it.effect("refuses a window that does not line up with the clock, or is shorter than the polling", () =>
    Effect.gen(function* () {
      const uneven = yield* Effect.flip(parseConfig(withDevicePublish({ mode: "aggregate", intervalMs: 7000 })))
      expect(uneven.message).toContain("must divide a day evenly")
      const tooFast = yield* Effect.flip(
        parseConfig(withDevicePublish({ mode: "aggregate", intervalMs: 5000 }, 10_000))
      )
      expect(tooFast.message).toContain("is shorter than the device's pollIntervalMs (10000)")
      expect(tooFast.message).toContain(`at ["devices"][0]["publish"]["intervalMs"]`)
      const missing = yield* Effect.flip(parseConfig(withDevicePublish({ mode: "aggregate" })))
      expect(missing.message).toContain("intervalMs")
    })
  )

  it.effect("refuses a point with both a deadband and a publish mode", () =>
    Effect.gen(function* () {
      const config = JSON.parse(withDevicePublish({ mode: "sample" }))
      config.devices[0].points[0] = { ...config.devices[0].points[0], deadband: 1, publish: { mode: "change" } }
      const error = yield* Effect.flip(parseConfig(JSON.stringify(config)))
      expect(error.message).toContain(`["deadband"]`)
    })
  )
})

const plain: AnyPoint = { id: "t", name: "T", writable: false }

/** A driver that reads `values` in turn (the last one again after that), stamped with the clock. */
const reading = (values: ReadonlyArray<number | "fail">): Driver => {
  let i = 0
  return {
    deviceId: "dev",
    points: [plain],
    readAll: Effect.gen(function* () {
      const value = values[Math.min(i++, values.length - 1)] ?? 0
      if (value === "fail") return yield* new DriverError({ device: "dev", reason: "timeout", message: "no reply" })
      const timestamp = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      return [{ pointId: plain.id, value, timestamp }]
    }),
    write: () => Effect.void
  }
}

/** Runs the device from `startMs` to `untilMs` of test time and returns what went out on the value topic. */
const run = (ctx: Partial<DeviceContext>, driver: Driver, untilMs: number, startMs = 0) =>
  Effect.gen(function* () {
    const { messages, layer } = yield* makeMemoryPublisher
    yield* TestClock.adjust(startMs)
    const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000, ...ctx }, driver).pipe(
      Effect.provide(layer),
      Effect.forkChild
    )
    yield* TestClock.adjust(untilMs - startMs)
    yield* Fiber.interrupt(fiber)
    return {
      meta: messages.filter((m) => m.topic.endsWith("$meta")).map((m) => JSON.parse(m.payload)),
      values: messages.filter((m) => !m.topic.endsWith("$meta")).map((m) => JSON.parse(m.payload))
    }
  })

describe("runDevice publish modes", () => {
  it.effect("sends every read by default, unchanged values too, and says so on $meta", () =>
    Effect.gen(function* () {
      const { meta, values } = yield* run({}, reading([7]), 2000)
      expect(values.map((v) => [v.value, v.ts])).toEqual([
        [7, 0],
        [7, 1000],
        [7, 2000]
      ])
      expect(meta[0]).toMatchObject({ publish: { mode: "sample" } })
    })
  )

  it.effect("sends the latest value once per interval in sample mode", () =>
    Effect.gen(function* () {
      const { values } = yield* run(
        { publish: { mode: "sample", intervalMs: 5000 } },
        reading([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
        10_500,
        500
      )
      // Reads at 0.5 s, 1.5 s …; the window closing at 5 s last read 5 (at 4.5 s), the one at 10 s read 10.
      expect(values.map((v) => [v.value, v.ts])).toEqual([
        [5, 4500],
        [10, 9500]
      ])
    })
  )

  it.effect("sends a clock-aligned aggregate per window in aggregate mode", () =>
    Effect.gen(function* () {
      const { values } = yield* run(
        { publish: { mode: "aggregate", intervalMs: 4000 } },
        reading([1, 2, 3, 4, 5, 6, 7, 8, 9]),
        8000,
        500
      )
      expect(values).toEqual([
        // Started at 0.5 s inside [0, 4 s): 1, 2, 3 for a second each, then 4 for half a second.
        {
          value: 8 / 3.5,
          min: 1,
          max: 4,
          avg: 8 / 3.5,
          last: 4,
          count: 4,
          from: 500,
          to: 4000,
          ts: 4000,
          partial: true
        },
        // 4 held from 4 s to 4.5 s, then 5 to 8 at 4.5, 5.5, 6.5 and 7.5 s.
        { value: 6, min: 4, max: 8, avg: 6, last: 8, count: 4, from: 4000, to: 8000, ts: 8000 }
      ])
    })
  )

  it.effect("sends nothing for a window in which the device did not answer", () =>
    Effect.gen(function* () {
      const { values } = yield* run(
        { publish: { mode: "aggregate", intervalMs: 60_000 } },
        reading([10, "fail"]),
        180_000,
        500
      )
      expect(values).toHaveLength(1)
      expect(values[0]).toMatchObject({ avg: 10, count: 1, to: 60_000, partial: true })
    })
  )

  it.effect("sends on change, and again after maxSilenceMs without one", () =>
    Effect.gen(function* () {
      const { values } = yield* run(
        { publish: { mode: "change", maxSilenceMs: 3000 } },
        reading([7, 7, 8, 8, 8, 8, 8, 8]),
        7000
      )
      expect(values.map((v) => [v.value, v.ts])).toEqual([
        [7, 0],
        [8, 2000],
        [8, 5000]
      ])
    })
  )
})
