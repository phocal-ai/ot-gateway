/**
 * Chaos: the wall clock steps back an hour (NTP on a Raspberry Pi without a
 * real-time clock), while sleeps and the monotonic clock keep going. Timers,
 * renewals, backoffs and the order of values must not notice.
 */
import { describe, expect, it } from "@effect/vitest"
import type { BacnetPoint } from "@ot-gateway/core"
import { makeMemoryPublisher, runDevice } from "@ot-gateway/core"
import { Clock, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { makeBacnetDriverFromClient } from "../../src/index.ts"
import { deviceConfig, scriptedClient, settle, skewedClock } from "./scripted.ts"

const analogInput = (id: string, property: string): BacnetPoint => ({
  id,
  name: id,
  writable: false,
  priority: 8,
  objectType: "analog-input",
  instance: 1,
  property
})
const supplyTemp = analogInput("supply-temp", "present-value")
const objectType = analogInput("ai-type", "object-type")

const timing = { checkMs: 1000, retryMs: 5000, renewMs: 150_000, lifetimeSeconds: 300 }

describe("chaos: wall clock steps back an hour", () => {
  it.effect("COV: renewals go on every 150 s, and a quiet object is polled again after its lifetime", () =>
    Effect.gen(function* () {
      const { clock, skew } = yield* skewedClock
      yield* Effect.gen(function* () {
        const scripted = scriptedClient()
        const driver = yield* makeBacnetDriverFromClient(
          deviceConfig([supplyTemp, objectType], { cov: true, address: "10.0.0.5" }),
          scripted.client,
          { cov: timing }
        )
        const pushed: Array<unknown> = []
        const poll = Effect.map(driver.readAll, (readings) => readings.map((reading) => reading.pointId))
        yield* poll
        if (driver.changes !== undefined) {
          yield* Stream.runForEach(driver.changes, (reading) => Effect.sync(() => pushed.push(reading.value))).pipe(
            Effect.forkScoped
          )
        }
        yield* settle
        scripted.notify(21)
        yield* settle
        expect(pushed).toEqual([21])
        expect(yield* poll).toEqual(["ai-type"])
        const before = scripted.subscribed().length

        skew.ms -= 3_600_000
        const polls: Array<ReadonlyArray<string>> = []
        for (let minute = 0; minute < 10; minute++) {
          yield* TestClock.adjust("60 seconds")
          polls.push(yield* poll)
        }
        expect(scripted.subscribed().length - before).toBe(4)
        expect(polls[0]).toEqual(["ai-type"])
        expect(polls.at(-1)).toEqual(["supply-temp", "ai-type"])
      }).pipe(Effect.provideService(Clock.Clock, clock))
    }).pipe(Effect.scoped)
  )

  it.effect("pipeline: values read after the step are published, not dropped as older", () =>
    Effect.gen(function* () {
      const { clock, skew } = yield* skewedClock
      yield* Effect.gen(function* () {
        const { messages, layer } = yield* makeMemoryPublisher
        const scripted = scriptedClient()
        const driver = yield* makeBacnetDriverFromClient(
          deviceConfig([supplyTemp], { address: "10.0.0.5" }),
          scripted.client
        )
        // Change mode: a value equal to the last one sent is held back, so a value read after the step that
        // were mistaken for older would be missing here.
        const fiber = yield* runDevice(
          { site: "s", building: "b", pollIntervalMs: 1000, publish: { mode: "change" } },
          driver
        ).pipe(Effect.provide(layer), Effect.forkChild)
        const values = () =>
          messages
            .filter((message) => !message.topic.endsWith("$meta"))
            .map((message) => {
              const payload: unknown = JSON.parse(message.payload)
              return typeof payload === "object" && payload !== null && "value" in payload ? payload.value : undefined
            })
        yield* TestClock.adjust("1 second")
        scripted.state.value = 2
        yield* TestClock.adjust("1 second")
        expect(values()).toEqual([1, 2])
        skew.ms -= 3_600_000
        for (let value = 3; value < 13; value++) {
          scripted.state.value = value
          yield* TestClock.adjust("1 second")
        }
        yield* Fiber.interrupt(fiber)
        expect(values()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
      }).pipe(Effect.provideService(Clock.Clock, clock))
    })
  )

  it.effect("locate: a device without an address is looked for again after the 30 s backoff", () =>
    Effect.gen(function* () {
      const { clock, skew } = yield* skewedClock
      yield* Effect.gen(function* () {
        const scripted = scriptedClient()
        scripted.state.mode = "timeout"
        const driver = yield* makeBacnetDriverFromClient(deviceConfig([supplyTemp]), scripted.client)
        yield* Effect.flip(driver.readAll)
        skew.ms -= 3_600_000
        scripted.state.mode = "ok"
        let firstSuccessAfter = -1
        for (let second = 10; second <= 600 && firstSuccessAfter < 0; second += 10) {
          yield* TestClock.adjust("10 seconds")
          const read = yield* Effect.result(driver.readAll)
          if (read._tag === "Success") firstSuccessAfter = second
        }
        expect(firstSuccessAfter).toBe(30)
      }).pipe(Effect.provideService(Clock.Clock, clock))
    })
  )
})
