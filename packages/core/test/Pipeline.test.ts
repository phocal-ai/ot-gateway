import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { DriverError, makeMemoryPublisher, runDevice } from "../src/index.ts"
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
const scriptedDriver = (values: ReadonlyArray<number | "fail">): Driver => {
  let i = 0
  return {
    deviceId: "test-device",
    points: [point],
    readAll: Effect.suspend(() => {
      const v = values[Math.min(i++, values.length - 1)]
      return v === "fail"
        ? Effect.fail(new DriverError({ device: "test-device", reason: "timeout", message: "no reply" }))
        : Effect.succeed<ReadonlyArray<Reading>>([{ pointId: point.id, value: v ?? 0, timestamp: 0 }])
    }),
    write: () => Effect.void
  }
}

describe("runDevice", () => {
  it.effect("publishes metadata, then scaled values outside the deadband", () =>
    Effect.gen(function*() {
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
    }))

  it.effect("keeps running when the driver fails", () =>
    Effect.gen(function*() {
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
    }))
})
