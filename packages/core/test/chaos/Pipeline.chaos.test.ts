/**
 * Failure modes found by chaos testing the pipeline, kept as regression tests.
 * Each test asserts the fixed behaviour.
 */
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Metric } from "effect"
import { TestClock } from "effect/testing"
import { makeMemoryPublisher, pointReadFailures, runDevice } from "../../src/index.ts"
import type { AnyPoint, Driver, PointValue, Reading } from "../../src/index.ts"

const pointNamed = (id: string, extra: Partial<AnyPoint> = {}): AnyPoint => ({
  id,
  name: id,
  writable: false,
  ...extra
})

/** A driver that returns scripted raw values per cycle, timestamped with the test clock; the last cycle repeats. */
const scripted = (
  deviceId: string,
  points: ReadonlyArray<AnyPoint>,
  cycles: ReadonlyArray<ReadonlyArray<readonly [string, PointValue]>>
): Driver => {
  let cycle = 0
  return {
    deviceId,
    points,
    readAll: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const values = cycles[Math.min(cycle++, cycles.length - 1)] ?? []
      return values.map(([pointId, value]): Reading => ({ pointId, value, timestamp: now }))
    }),
    write: () => Effect.void
  }
}

const payloadsOn = (messages: ReadonlyArray<{ readonly topic: string; readonly payload: string }>, topic: string) =>
  messages.filter((message) => message.topic === topic).map((message) => message.payload)

const valuesOn = (messages: ReadonlyArray<{ readonly topic: string; readonly payload: string }>, topic: string) =>
  payloadsOn(messages, topic).map((payload) => JSON.parse(payload).value)

const countOf = (metric: Metric.Counter<number>, attributes: Record<string, string>) =>
  Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.map((state) => state.count))

describe("chaos: values that are not finite numbers", () => {
  it.effect("a NaN first reading does not freeze a deadbanded point", () =>
    Effect.gen(function* () {
      const { messages, layer } = yield* makeMemoryPublisher
      const driver = scripted(
        "nan-first",
        [pointNamed("temp", { deadband: 0.5 })],
        [[["temp", Number.NaN]], [["temp", 20]], [["temp", 25]], [["temp", 30]]]
      )
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000 }, driver).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("5 seconds")
      yield* Fiber.interrupt(fiber)

      expect(valuesOn(messages, "s/b/nan-first/temp")).toEqual([20, 25, 30])
    })
  )

  it.effect("NaN and Infinity are never published, and count as point read failures", () =>
    Effect.gen(function* () {
      const { messages, layer } = yield* makeMemoryPublisher
      const driver = scripted(
        "not-finite",
        [pointNamed("temp"), pointNamed("energy", { scaling: { factor: 1e308, offset: 0 } })],
        [
          [
            ["temp", Number.NaN],
            ["energy", 1]
          ],
          [
            ["temp", Number.POSITIVE_INFINITY],
            ["energy", 10]
          ],
          [
            ["temp", 21],
            ["energy", 0]
          ]
        ]
      )
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000 }, driver).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)

      expect(payloadsOn(messages, "s/b/not-finite/temp").some((payload) => payload.includes("null"))).toBe(false)
      expect(valuesOn(messages, "s/b/not-finite/temp")).toEqual([21])
      // 10 × 1e308 overflows to Infinity after scaling; 1 × 1e308 is finite.
      expect(valuesOn(messages, "s/b/not-finite/energy")).toEqual([1e308, 0])
      expect(yield* countOf(pointReadFailures, { device: "not-finite" })).toBe(3)
    })
  )

  it.effect("a non-finite value keeps the last good value as the deadband reference", () =>
    Effect.gen(function* () {
      const { messages, layer } = yield* makeMemoryPublisher
      const driver = scripted(
        "nan-between",
        [pointNamed("temp", { deadband: 1 })],
        [[["temp", 20]], [["temp", Number.NaN]], [["temp", 20.5]], [["temp", 22]]]
      )
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000 }, driver).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("3 seconds")
      yield* Fiber.interrupt(fiber)

      // 20.5 is inside the deadband of 20, not "changed" because NaN came in between.
      expect(valuesOn(messages, "s/b/nan-between/temp")).toEqual([20, 22])
    })
  )
})
