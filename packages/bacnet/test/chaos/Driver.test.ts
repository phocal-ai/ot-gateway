/**
 * Chaos: the driver against a programmable client, counting requests and
 * log lines, so a device that misbehaves for a moment neither degrades it
 * for good nor floods the device or the logs.
 */
import { describe, expect, it } from "@effect/vitest"
import { makeMemoryPublisher, runDevice } from "@ot-gateway/core"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { makeBacnetDriverFromClient } from "../../src/index.ts"
import { captureLogs, deviceConfig, points, scriptedClient } from "./scripted.ts"

const fixed = { address: "10.0.0.5" }

describe("chaos: driver", () => {
  it.effect("asks a device that rejected ReadPropertyMultiple once again after an hour", () =>
    Effect.gen(function* () {
      const { state, client } = scriptedClient()
      const driver = yield* makeBacnetDriverFromClient(deviceConfig(points(200), fixed), client)
      yield* driver.readAll
      // A controller whose stack is still starting rejects the service for one cycle.
      state.mode = "reject-rpm"
      yield* driver.readAll
      state.mode = "ok"
      state.rp = 0
      state.rpm = 0
      yield* driver.readAll
      expect([state.rpm, state.rp]).toEqual([0, 200])
      yield* TestClock.adjust("1 hour")
      state.rp = 0
      for (let cycle = 0; cycle < 10; cycle++) yield* driver.readAll
      // 200 points in batches of 66: four requests a cycle, no ReadProperty.
      expect(state.rpm).toBe(4 * 10)
      expect(state.rp).toBe(0)
    })
  )

  it.effect("keeps reading point by point a device that still rejects it, asking once an hour", () =>
    Effect.gen(function* () {
      const { state, client } = scriptedClient()
      state.mode = "reject-rpm"
      const { layer, count } = captureLogs()
      yield* Effect.gen(function* () {
        const driver = yield* makeBacnetDriverFromClient(deviceConfig(points(10), fixed), client)
        for (let hour = 0; hour < 3; hour++) {
          yield* driver.readAll
          yield* driver.readAll
          yield* TestClock.adjust("1 hour")
        }
        // Once per hour, and the rejection is logged the first time only.
        expect(state.rpm).toBe(3)
        expect(count()["device does not support ReadPropertyMultiple, reading points one at a time"]).toBe(1)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("asks a fixed address for its APDU size again after missing Who-Is at boot", () =>
    Effect.gen(function* () {
      const { state, client } = scriptedClient()
      state.answersWhoIs = false
      // Neither Who-Is nor the device object answers: 480 bytes is assumed.
      state.mode = "timeout"
      const driver = yield* makeBacnetDriverFromClient(deviceConfig(points(200), fixed), client)
      yield* Effect.flip(driver.readAll)
      state.mode = "ok"
      state.rpm = 0
      yield* driver.readAll
      // 480-byte batches of 21 points.
      expect(state.rpm).toBe(10)
      state.answersWhoIs = true
      yield* TestClock.adjust("10 minutes")
      state.rpm = 0
      yield* driver.readAll
      expect(state.locate).toBe(2)
      expect(state.rpm).toBe(4)
    })
  )

  it.effect("reads the APDU size from the device object when Who-Is is not answered", () =>
    Effect.gen(function* () {
      const { state, client } = scriptedClient()
      state.answersWhoIs = false
      const driver = yield* makeBacnetDriverFromClient(deviceConfig(points(200), fixed), client)
      yield* driver.readAll
      // One ReadProperty of max-apdu-length-accepted, then 1476-byte batches.
      expect([state.rp, state.rpm]).toEqual([1, 4])
    })
  )

  it.effect("logs a device that stops answering once, not every point failing and recovering", () =>
    Effect.gen(function* () {
      const { lines, layer, count } = captureLogs()
      const { state, client } = scriptedClient()
      yield* Effect.gen(function* () {
        const driver = yield* makeBacnetDriverFromClient(deviceConfig(points(1000), fixed), client)
        yield* driver.readAll
        const before = lines.length
        state.mode = "timeout"
        for (let cycle = 0; cycle < 5; cycle++) yield* Effect.flip(driver.readAll)
        state.mode = "ok"
        yield* driver.readAll
        expect(count(before)).toEqual({ "BACnet device stopped answering": 1, "BACnet device answers again": 1 })
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("backs off a busy device for the cycle instead of reading every point alone", () =>
    Effect.gen(function* () {
      const { state, client } = scriptedClient()
      const driver = yield* makeBacnetDriverFromClient(deviceConfig(points(1000), fixed), client)
      yield* driver.readAll
      state.mode = "busy"
      state.rp = 0
      state.rpm = 0
      expect(yield* Effect.flip(driver.readAll)).toMatchObject({
        reason: "protocol",
        message: "device is busy (aborted: preempted-by-higher-priority-task); asking again in 5 s"
      })
      expect([state.rpm, state.rp]).toEqual([1, 0])
      // Asked again at once (the pipeline retries): nothing is sent until the backoff ends.
      yield* Effect.flip(driver.readAll)
      expect(state.rpm).toBe(1)
      yield* TestClock.adjust("5 seconds")
      state.mode = "ok"
      expect(yield* driver.readAll).toHaveLength(1000)
    })
  )

  it.effect("caps the requests spent on a device that refuses every batch and every point", () =>
    Effect.gen(function* () {
      const { state, client } = scriptedClient()
      state.missing = new Set(points(1000).map((point) => point.instance))
      const driver = yield* makeBacnetDriverFromClient(deviceConfig(points(1000), fixed), client)
      for (let cycle = 0; cycle < 20; cycle++) {
        state.rp = 0
        state.rpm = 0
        expect(yield* Effect.flip(driver.readAll)).toMatchObject({ reason: "protocol" })
        // One request per batch (16 of 66 points at most), and 32 more to find the culprits.
        expect(state.rpm + state.rp).toBeLessThanOrEqual(16 + 32)
      }
    })
  )

  it.effect("finds the one point that fails its batch by halves, and reads the rest together again", () =>
    Effect.gen(function* () {
      const { state, client } = scriptedClient()
      // Like some older devices: one unknown object fails the whole request it is in.
      state.missing = new Set([3])
      const driver = yield* makeBacnetDriverFromClient(deviceConfig(points(100), fixed), client)
      expect(yield* driver.readAll).toHaveLength(99)
      // Batches of 66 and 34; the first refused, then halved 6 times (2 requests each) and point 3 asked alone.
      expect([state.rpm, state.rp]).toEqual([2 + 12, 1])
      state.rpm = 0
      state.rp = 0
      // From then on the missing point is read alone, and the other 99 in two batches.
      expect(yield* driver.readAll).toHaveLength(99)
      expect([state.rpm, state.rp]).toEqual([2, 1])
    })
  )

  it.effect("reads a device that refuses ReadPropertyMultiple with an error point by point", () =>
    Effect.gen(function* () {
      const { state, client } = scriptedClient()
      state.mode = "error-rpm"
      const driver = yield* makeBacnetDriverFromClient(deviceConfig(points(100), fixed), client)
      // Halved down to one point, which ReadProperty reads: it is the service, not a point.
      expect(yield* driver.readAll).toHaveLength(100)
      state.rpm = 0
      state.rp = 0
      expect(yield* driver.readAll).toHaveLength(100)
      expect([state.rpm, state.rp]).toEqual([0, 100])
    })
  )

  it.effect("a busy device run by the pipeline gets a handful of requests per cycle, not thousands", () =>
    Effect.gen(function* () {
      const { state, client } = scriptedClient()
      state.mode = "busy"
      const { layer } = yield* makeMemoryPublisher
      const driver = yield* makeBacnetDriverFromClient(
        { ...deviceConfig(points(1000), fixed), pollIntervalMs: 10_000 },
        client
      )
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 10_000 }, driver).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      // One cycle with the pipeline's four retries.
      for (let step = 0; step < 900; step++) yield* TestClock.adjust("10 millis")
      yield* Fiber.interrupt(fiber)
      expect(state.rp).toBe(0)
      expect(state.rpm).toBeLessThanOrEqual(2)
    })
  )
})
