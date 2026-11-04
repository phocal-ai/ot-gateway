/** Request timing: every request's time lands in one counter per device, whatever its outcome. */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Metric } from "effect"
import { TestClock } from "effect/testing"
import { driverRequestSeconds, timeRequest, withMetricAttributes } from "../src/index.ts"

describe("timeRequest", () => {
  it.effect("adds the time of answered and failed requests alike", () =>
    Effect.gen(function* () {
      const attributes = { test: "time-request" }
      const slow = Effect.sleep("250 millis")
      const failing = Effect.sleep("2 seconds").pipe(Effect.andThen(Effect.fail("timeout")))
      const fiber = yield* Effect.all([timeRequest(slow), Effect.flip(timeRequest(failing))]).pipe(
        withMetricAttributes(attributes),
        Effect.forkChild
      )
      yield* TestClock.adjust("3 seconds")
      yield* Fiber.join(fiber)
      const state = yield* Metric.value(Metric.withAttributes(driverRequestSeconds, attributes))
      expect(state.count).toBeCloseTo(2.25)
    })
  )
})
