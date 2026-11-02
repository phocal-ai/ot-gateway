import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { keepRunning } from "../src/KeepRunning.ts"

describe("keepRunning", () => {
  it.effect("restarts a task after a defect, after the delay", () =>
    Effect.gen(function* () {
      let runs = 0
      const task = Effect.suspend(() => {
        runs++
        return runs < 3 ? Effect.die(new Error("bug")) : Effect.void
      })
      const fiber = yield* keepRunning("task", task, "1 second").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(runs).toBe(1)
      yield* TestClock.adjust("1 second")
      expect(runs).toBe(2)
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(fiber)
      expect(runs).toBe(3)
    })
  )

  it.effect("stops when interrupted instead of restarting", () =>
    Effect.gen(function* () {
      let runs = 0
      const task = Effect.suspend(() => {
        runs++
        return Effect.never
      })
      const fiber = yield* keepRunning("task", task).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust("1 minute")
      expect(runs).toBe(1)
    })
  )
})
