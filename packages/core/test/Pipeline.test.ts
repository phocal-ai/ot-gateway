import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Metric } from "effect"
import { TestClock } from "effect/testing"
import {
  DriverError,
  makeMemoryPublisher,
  pollCycles,
  Publisher,
  PublishError,
  readFailures,
  runDevice,
  valuesPublished,
  valuesSuppressed
} from "../src/index.ts"
import type { AnyPoint, Driver, Reading } from "../src/index.ts"

const point: AnyPoint = {
  id: "zone-temp",
  name: "Zone temperature",
  unit: "unit:DEG_C",
  writable: false,
  deadband: 0.5,
  scaling: { factor: 0.1, offset: 0 }
}

/** A driver that returns scripted raw values, one per cycle. */
const scriptedDriver = (values: ReadonlyArray<number | "fail">, deviceId = "test-device"): Driver => {
  let i = 0
  return {
    deviceId,
    points: [point],
    readAll: Effect.suspend(() => {
      const v = values[Math.min(i++, values.length - 1)]
      return v === "fail"
        ? Effect.fail(new DriverError({ device: deviceId, reason: "timeout", message: "no reply" }))
        : Effect.succeed<ReadonlyArray<Reading>>([{ pointId: point.id, value: v ?? 0, timestamp: 0 }])
    }),
    write: () => Effect.void
  }
}

describe("runDevice", () => {
  it.effect("publishes metadata, then scaled values outside the deadband", () =>
    Effect.gen(function* () {
      const { messages, layer } = yield* makeMemoryPublisher
      const driver = scriptedDriver([200, 202, 210])
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000 }, driver).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)

      expect(messages[0]).toMatchObject({ topic: "s/b/test-device/zone-temp/$meta", retain: true })
      const values = messages.slice(1).map((m) => JSON.parse(m.payload).value)
      // 20.0 publishes, 20.2 is inside the 0.5 deadband, 21.0 publishes.
      expect(values).toEqual([20, 21])
    })
  )

  it.effect("keeps running when the driver fails", () =>
    Effect.gen(function* () {
      const { messages, layer } = yield* makeMemoryPublisher
      const driver = scriptedDriver(["fail", "fail", "fail", "fail", "fail", 300])
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000 }, driver).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("1 minute")
      yield* Fiber.interrupt(fiber)

      const values = messages.slice(1).map((m) => JSON.parse(m.payload).value)
      expect(values).toEqual([30])
    })
  )

  it.effect("retries a value on the next cycle when its publish failed", () =>
    Effect.gen(function* () {
      const published: Array<number> = []
      let valuePublishes = 0
      const flakyPublisher = Layer.succeed(Publisher, {
        publish: (topic, payload) =>
          Effect.suspend(() => {
            if (topic.endsWith("$meta")) return Effect.void
            valuePublishes++
            if (valuePublishes === 1) return Effect.fail(new PublishError({ topic, message: "broker down" }))
            published.push(JSON.parse(payload).value)
            return Effect.void
          })
      })
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 1000 },
        scriptedDriver([200], "flaky-publish")
      ).pipe(Effect.provide(flakyPublisher), Effect.forkChild)
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(fiber)

      // The first publish failed; the unchanged value goes out on the next cycle.
      expect(published).toEqual([20])
    })
  )
})

/** Read a counter's count for one combination of attributes. */
const countOf = (metric: Metric.Counter<number>, attributes: Record<string, string>) =>
  Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.map((state) => state.count))

describe("runDevice metrics", () => {
  it.effect("counts cycles, published and suppressed values per device", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeMemoryPublisher
      const device = "metrics-ok"
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 1000 },
        scriptedDriver([200, 202, 210], device)
      ).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)

      expect(yield* countOf(pollCycles, { device, outcome: "ok" })).toBe(3)
      expect(yield* countOf(valuesPublished, { device })).toBe(2)
      expect(yield* countOf(valuesSuppressed, { device })).toBe(1)
    })
  )

  it.effect("counts a failed cycle once, after retries, with the driver's reason", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeMemoryPublisher
      const device = "metrics-fail"
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 1000 },
        scriptedDriver(["fail", "fail", "fail", "fail", "fail", 300], device)
      ).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust("1 minute")
      yield* Fiber.interrupt(fiber)

      expect(yield* countOf(pollCycles, { device, outcome: "read_failed" })).toBe(1)
      expect(yield* countOf(readFailures, { device, reason: "timeout" })).toBe(1)
    })
  )
})
