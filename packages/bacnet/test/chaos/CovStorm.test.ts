/**
 * Chaos: COV maintenance when some objects' SubscribeCOV go unanswered, and
 * when the whole device stops answering.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { TestClock } from "effect/testing"
import { BacnetTimeout, makeBacnetDriverFromClient } from "../../src/index.ts"
import { deviceConfig, points, scriptedClient, settle } from "./scripted.ts"

const fixed = { cov: true, address: "10.0.0.5" }

describe("chaos: COV maintenance", () => {
  it.effect(
    "40 objects whose SubscribeCOV is never answered do not starve the renewals of the other 960",
    () =>
      Effect.gen(function* () {
        const { state, client } = scriptedClient()
        const attempts = new Map<number, Array<number>>()
        let now = 0
        // Instances 500 to 539 are silent: the client gives up after 3 s x 3 attempts.
        state.subscribe = (request) =>
          Effect.gen(function* () {
            attempts.set(request.object.instance, [...(attempts.get(request.object.instance) ?? []), now])
            if (request.object.instance >= 500 && request.object.instance < 540) {
              yield* Effect.sleep("9 seconds")
              return yield* new BacnetTimeout({ message: "no answer" })
            }
            yield* Effect.sleep("5 millis")
          })
        const driver = yield* makeBacnetDriverFromClient(deviceConfig(points(1000), fixed), client)
        yield* driver.readAll
        if (driver.changes !== undefined) yield* Stream.runDrain(driver.changes).pipe(Effect.forkScoped)
        for (let second = 0; second < 1800; second += 5) {
          yield* TestClock.adjust("5 seconds")
          now = second + 5
        }
        // Every answering object is renewed well within its 300 s lifetime, every time.
        const worstGap = Math.max(
          ...[...attempts.entries()]
            .filter(([instance]) => instance < 500 || instance >= 540)
            .flatMap(([, times]) => times.slice(1).map((time, index) => time - (times[index] ?? 0)))
        )
        expect(worstGap).toBeLessThan(200)
        // Renewed every 150 s: 12 subscriptions in 30 minutes.
        expect(attempts.get(1)?.length).toBeGreaterThanOrEqual(12)
        expect(attempts.get(1000)?.length).toBeGreaterThanOrEqual(11)
        // The silent ones back off, up to 10 minutes apart.
        expect(attempts.get(500)?.length).toBeLessThanOrEqual(8)
        // Cancelling on stop is answered at once.
        state.subscribe = () => Effect.void
      }).pipe(Effect.scoped),
    60_000
  )

  it.effect("stops subscribing while the device does not answer, and subscribes again when it does", () =>
    Effect.gen(function* () {
      const { state, client, subscribed } = scriptedClient()
      const driver = yield* makeBacnetDriverFromClient(deviceConfig(points(100), fixed), client, {
        cov: { checkMs: 1000 }
      })
      yield* driver.readAll
      if (driver.changes !== undefined) yield* Stream.runDrain(driver.changes).pipe(Effect.forkScoped)
      yield* settle
      expect(subscribed()).toHaveLength(100)
      state.mode = "timeout"
      yield* Effect.flip(driver.readAll)
      // Renewals fall due while it is down; none is sent.
      yield* TestClock.adjust("200 seconds")
      expect(subscribed()).toHaveLength(100)
      state.mode = "ok"
      yield* driver.readAll
      yield* TestClock.adjust("1 second")
      expect(subscribed()).toHaveLength(200)
    }).pipe(Effect.scoped)
  )

  it.effect("ends a round early when several subscriptions in a row get no answer", () =>
    Effect.gen(function* () {
      const { state, client, subscribed } = scriptedClient()
      // Reads are answered, subscriptions are not: a device whose COV task hangs.
      state.subscribe = () =>
        Effect.sleep("9 seconds").pipe(Effect.andThen(Effect.fail(new BacnetTimeout({ message: "no answer" }))))
      const driver = yield* makeBacnetDriverFromClient(deviceConfig(points(1000), fixed), client)
      yield* driver.readAll
      if (driver.changes !== undefined) yield* Stream.runDrain(driver.changes).pipe(Effect.forkScoped)
      yield* TestClock.adjust("30 seconds")
      // Two waves of four, not a thousand attempts at 9 s each holding up the rest.
      expect(subscribed().length).toBeLessThanOrEqual(3 * 4 * 2)
    }).pipe(Effect.scoped)
  )
})
