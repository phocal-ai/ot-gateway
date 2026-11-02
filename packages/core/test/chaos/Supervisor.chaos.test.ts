/**
 * A defect in one device's pipeline used to end the whole gateway, since every
 * device ran in one `Effect.all`. These tests run devices the way
 * `apps/gateway/src/main.ts` does, each under `superviseDevice`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Metric } from "effect"
import { TestClock } from "effect/testing"
import { deviceRestarts, makeHealthRegistry, makeMemoryPublisher, runDevice, superviseDevice } from "../../src/index.ts"
import type { Driver, Reading } from "../../src/index.ts"

const ctx = { site: "s", building: "b", pollIntervalMs: 1000 }

/** A driver that reads its own cycle number. */
const counting = (deviceId: string): Driver => {
  let cycle = 0
  return {
    deviceId,
    points: [{ id: "temp", name: "temp", writable: false }],
    readAll: Effect.map(Clock.currentTimeMillis, (now): ReadonlyArray<Reading> => [
      { pointId: "temp", value: ++cycle, timestamp: now }
    ]),
    write: () => Effect.void
  }
}

/** A driver whose read dies after its first cycle, as a codec bug would. */
const crashing = (deviceId: string, onRead: () => void = () => {}): Driver => {
  let reads = 0
  return {
    deviceId,
    points: [{ id: "x", name: "x", writable: false }],
    readAll: Effect.suspend(() => {
      onRead()
      return reads++ < 1 ? Effect.succeed([]) : Effect.die(new RangeError("offset out of bounds"))
    }),
    write: () => Effect.void
  }
}

const restartsOf = (device: string) =>
  Metric.value(Metric.withAttributes(deviceRestarts, { device })).pipe(Effect.map((state) => state.count))

describe("chaos: a defect in one device", () => {
  it.effect("does not stop the other devices, and restarts the broken one with backoff", () =>
    Effect.gen(function* () {
      const { messages, layer } = yield* makeMemoryPublisher
      const health = makeHealthRegistry(["good", "bad"])
      let badReads = 0
      const gateway = Effect.all(
        [
          superviseDevice(
            Effect.suspend(() => runDevice({ ...ctx, health }, counting("good"))),
            { deviceId: "good", health }
          ),
          superviseDevice(
            Effect.suspend(() =>
              runDevice(
                { ...ctx, health },
                crashing("bad", () => badReads++)
              )
            ),
            { deviceId: "bad", health }
          )
        ],
        { concurrency: "unbounded", discard: true }
      )
      const fiber = yield* gateway.pipe(Effect.provide(layer), Effect.forkChild)
      // Crashes at 1 s, restarts at 2 s (1 s backoff), crashes at 3 s, restarts at 5 s (2 s), crashes at 6 s,
      // restarts at 10 s (4 s): each run reads once fine and dies on the second read, a second later.
      yield* TestClock.adjust("9 seconds")

      expect(fiber.pollUnsafe()).toBeUndefined()
      expect(messages.filter((m) => m.topic === "s/b/good/temp")).toHaveLength(10)
      expect(yield* restartsOf("bad")).toBe(3)
      expect(badReads).toBe(6)
      expect(health.devices.get("bad")).toMatchObject({ status: "failing", reason: "crashed" })
      expect(health.devices.get("good")?.status).toBe("ok")

      // Restarted, the device reads fine again until its next crash.
      yield* TestClock.adjust("1 second")
      expect(health.devices.get("bad")?.status).toBe("ok")
      yield* Fiber.interrupt(fiber)
    })
  )

  it.effect("caps the restart backoff, and resets it after a run that lasted", () =>
    Effect.gen(function* () {
      const starts: Array<number> = []
      let crashAfter = 0
      const device = Effect.gen(function* () {
        starts.push(yield* Clock.currentTimeMillis)
        yield* Effect.sleep(crashAfter)
        return yield* Effect.die(new Error("bug"))
      })
      const fiber = yield* superviseDevice(device, {
        deviceId: "backoff",
        initialBackoff: "1 second",
        maxBackoff: "10 seconds"
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust("40 seconds")
      // Delays 1, 2, 4, 8, then capped at 10.
      expect(starts.slice(0, 7)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 25_000, 35_000])

      // A run that lasts at least the cap starts the backoff over.
      crashAfter = 10_000
      yield* TestClock.adjust("25 seconds")
      expect(starts.slice(7)).toEqual([45_000, 56_000])
      yield* Fiber.interrupt(fiber)
    })
  )

  it.effect("stops on interruption without restarting", () =>
    Effect.gen(function* () {
      let starts = 0
      const device = Effect.suspend(() => {
        starts++
        return Effect.never
      })
      const fiber = yield* superviseDevice(device, { deviceId: "shutdown" }).pipe(Effect.forkChild)
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust("10 minutes")
      expect(starts).toBe(1)
      expect(yield* restartsOf("shutdown")).toBe(0)
    })
  )
})
