/**
 * The driver's change-of-value bookkeeping against a scripted client, with
 * the test clock: lapses, renewals, moves and restarts take minutes.
 */
import { describe, expect, it } from "@effect/vitest"
import type { BacnetDevice, BacnetPoint, Reading } from "@plenum/core"
import { Clock, Effect, Result, Stream } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import { TestClock } from "effect/testing"
import {
  type BacnetClient,
  BacnetTimeout,
  type DeviceAddress,
  ErrorClass,
  ErrorCode,
  makeBacnetDriverFromClient,
  ObjectType,
  parseDeviceAddress,
  PropertyId
} from "../src/index.ts"

const addressOf = (text: string) => Result.getOrThrow(parseDeviceAddress(text))
const here = addressOf("10.0.0.5")
const elsewhere = addressOf("10.0.0.6")

const point = (id: string, instance: number, property = "present-value"): BacnetPoint => ({
  id,
  name: id,
  writable: false,
  objectType: "analog-input",
  instance,
  property
})

const supplyTemp = point("supply-temp", 1)
const objectType = point("ai-type", 1, "object-type")
/** Instance 99 does not exist on the scripted device. */
const missing = point("missing", 99, "object-type")

const deviceConfig = (points: ReadonlyArray<BacnetPoint>, address?: string): BacnetDevice => ({
  protocol: "bacnet-ip",
  id: "ahu-2",
  deviceInstance: 2001,
  cov: true,
  pollIntervalMs: 1000,
  ...(address === undefined ? {} : { address }),
  points
})

const timing = { checkMs: 1000, retryMs: 5000, renewMs: 150_000, lifetimeSeconds: 300 }

/** A client for one device that answers every read with 1, unless it is offline. */
const scriptedClient = () => {
  const state = {
    at: here,
    offline: false,
    /** Subscriptions time out although reads are answered. */
    subscriptionsTimeOut: false,
    subscribes: [] as Array<{ readonly at: string; readonly instance: number; readonly cancel: boolean }>,
    listener: undefined as
      | ((notification: Parameters<NotificationListener>[0], from: DeviceAddress) => void)
      | undefined
  }
  const timeout = new BacnetTimeout({ message: "no answer" })
  const client: BacnetClient = {
    confirmed: () => Effect.die("not scripted"),
    readProperty: () => Effect.die("not scripted"),
    readPropertyMultiple: (_target, specifications) =>
      Effect.suspend(() =>
        state.offline
          ? Effect.fail(timeout)
          : Effect.succeed(
              specifications.map((specification) => ({
                object: specification.object,
                results: specification.properties.map(({ property }) =>
                  specification.object.instance === 99
                    ? {
                        property,
                        _tag: "Error" as const,
                        errorClass: ErrorClass.object,
                        errorCode: ErrorCode["unknown-object"]
                      }
                    : { property, _tag: "Value" as const, values: [{ type: "real" as const, value: 1 }] }
                )
              }))
            )
      ),
    discover: () => Effect.succeed([]),
    locate: (instance) =>
      Effect.suspend(() =>
        state.offline
          ? Effect.fail(timeout)
          : Effect.succeed({ instance, address: state.at, maxApdu: 1476, segmentation: 3, vendorId: 1 })
      ),
    subscribeCov: (target, request) =>
      Effect.suspend(() => {
        state.subscribes.push({
          at: NetAddress.formatInet(target.address),
          instance: request.object.instance,
          cancel: request.lifetime === undefined
        })
        return state.offline || state.subscriptionsTimeOut ? Effect.fail(timeout) : Effect.void
      }),
    newProcessId: Effect.succeed(1),
    onCovNotification: (_processId, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          state.listener = listener
        }),
        () =>
          Effect.sync(() => {
            state.listener = undefined
          })
      )
  }
  /** A notification of analog-input `instance`'s present value. */
  const notify = (value: number, options: { readonly from?: NetAddress.InetAddress; readonly device?: number } = {}) =>
    state.listener?.(
      {
        processId: 1,
        initiatingDevice: { objectType: ObjectType.device, instance: options.device ?? 2001 },
        object: { objectType: ObjectType["analog-input"], instance: 1 },
        timeRemaining: 300,
        values: [{ property: PropertyId["present-value"], values: [{ type: "real", value }] }]
      },
      { address: options.from ?? state.at }
    )
  const subscribed = () => state.subscribes.filter((subscribe) => !subscribe.cancel)
  return { state, client, notify, subscribed }
}
type NotificationListener = Parameters<BacnetClient["onCovNotification"]>[1]

const ids = (readings: ReadonlyArray<Reading>) => readings.map((reading) => reading.pointId)

/** Let forked fibers run without moving the clock. */
const settle = TestClock.adjust("1 millis")

const start = Effect.fnUntraced(function* (points: ReadonlyArray<BacnetPoint>, address?: string) {
  const scripted = scriptedClient()
  const driver = yield* makeBacnetDriverFromClient(deviceConfig(points, address), scripted.client, { cov: timing })
  const pushed: Array<number | boolean> = []
  const poll = Effect.map(driver.readAll, ids)
  // Nothing is subscribed before the device has been found by the first cycle.
  const firstPoll = yield* poll
  if (driver.changes !== undefined) {
    yield* Stream.runForEach(driver.changes, (reading) => Effect.sync(() => pushed.push(reading.value))).pipe(
      Effect.forkScoped
    )
  }
  yield* settle
  return { ...scripted, driver, pushed, poll, firstPoll }
})

describe("change of value, over time", () => {
  it.effect("renews a subscription, and polls the object again once it goes quiet", () =>
    Effect.gen(function* () {
      const { notify, pushed, poll, subscribed, firstPoll } = yield* start([supplyTemp, objectType], "10.0.0.5")
      expect(firstPoll).toEqual(["supply-temp", "ai-type"])
      expect(subscribed()).toEqual([{ at: "10.0.0.5:47808", instance: 1, cancel: false }])
      notify(21)
      yield* settle
      expect(pushed).toEqual([21])
      expect(yield* poll).toEqual(["ai-type"])

      yield* TestClock.adjust("150 seconds")
      expect(subscribed()).toHaveLength(2)
      // The device acknowledged the renewal but sent nothing since: after a lifetime it is polled again.
      yield* TestClock.adjust("150 seconds")
      expect(yield* poll).toEqual(["supply-temp", "ai-type"])
    }).pipe(Effect.scoped)
  )

  it.effect("ignores a notification from another address or about another device", () =>
    Effect.gen(function* () {
      const { notify, pushed, poll } = yield* start([supplyTemp, objectType], "10.0.0.5")
      notify(30, { from: elsewhere })
      notify(31, { device: 9 })
      yield* settle
      expect(pushed).toEqual([])
      expect(yield* poll).toEqual(["supply-temp", "ai-type"])
      notify(32)
      yield* settle
      expect(pushed).toEqual([32])
    }).pipe(Effect.scoped)
  )

  it.effect("does not fail the device when only a polled point is unreadable while others are pushed", () =>
    Effect.gen(function* () {
      const scripted = scriptedClient()
      const driver = yield* makeBacnetDriverFromClient(
        deviceConfig([supplyTemp, missing], "10.0.0.5"),
        scripted.client,
        { cov: timing }
      )
      expect((yield* driver.readAll).map((reading) => reading.pointId)).toEqual(["supply-temp"])
      if (driver.changes !== undefined) yield* Stream.runDrain(driver.changes).pipe(Effect.forkScoped)
      yield* settle
      scripted.notify(21)
      yield* settle
      expect(yield* driver.readAll).toEqual([])
    }).pipe(Effect.scoped)
  )

  it.effect("subscribes again and polls everything when a device answers after timing out", () =>
    Effect.gen(function* () {
      const { state, notify, poll, subscribed, driver } = yield* start([supplyTemp, objectType], "10.0.0.5")
      notify(21)
      yield* settle
      expect(yield* poll).toEqual(["ai-type"])
      state.offline = true
      expect(yield* driver.readAll.pipe(Effect.flip)).toMatchObject({ reason: "timeout" })
      state.offline = false
      // It may have restarted and lost its subscriptions: everything is read until notifications return.
      expect(yield* poll).toEqual(["supply-temp", "ai-type"])
      const before = subscribed().length
      yield* TestClock.adjust("1 second")
      expect(subscribed().length).toBe(before + 1)
    }).pipe(Effect.scoped)
  )

  it.effect("subscribes at the new address after the device moved, and retries there at the retry pace", () =>
    Effect.gen(function* () {
      const { state, notify, poll, subscribed, driver } = yield* start([supplyTemp, objectType])
      notify(21)
      yield* settle
      state.offline = true
      for (let cycle = 0; cycle < 3; cycle++) yield* Effect.flip(driver.readAll)
      state.offline = false
      state.at = elsewhere
      state.subscriptionsTimeOut = true
      expect(yield* poll).toEqual(["supply-temp", "ai-type"])
      const before = subscribed().length
      yield* TestClock.adjust("4 seconds")
      const atNewAddress = subscribed()
        .slice(before)
        .filter((subscribe) => subscribe.at === "10.0.0.6:47808")
      // One attempt, then the 5 s retry: not one per 1 s check.
      expect(atNewAddress).toHaveLength(1)
    }).pipe(Effect.scoped)
  )

  it.effect("cancels its subscriptions where they were made when it stops", () =>
    Effect.gen(function* () {
      const { state, subscribed } = yield* Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start([supplyTemp], "10.0.0.5")
          expect(started.subscribed()).toHaveLength(1)
          return started
        })
      )
      expect(state.subscribes.filter((subscribe) => subscribe.cancel)).toEqual([
        { at: "10.0.0.5:47808", instance: 1, cancel: true }
      ])
      expect(subscribed()).toHaveLength(1)
    })
  )

  it.effect("keeps renewing and falls back to polling when the wall clock steps back", () =>
    Effect.gen(function* () {
      const { clock, skew } = yield* skewedClock
      yield* Effect.gen(function* () {
        const { notify, pushed, poll, subscribed } = yield* start([supplyTemp, objectType], "10.0.0.5")
        notify(21)
        yield* settle
        expect(pushed).toEqual([21])
        const before = subscribed().length
        // NTP steps the wall clock back an hour; ten minutes pass on the monotonic clock.
        skew.ms -= 3_600_000
        const polls: Array<ReadonlyArray<string>> = []
        for (let minute = 0; minute < 10; minute++) {
          yield* TestClock.adjust("60 seconds")
          polls.push(yield* poll)
        }
        // Renewed every 150 s regardless, and polled again once the device stayed quiet for a lifetime.
        expect(subscribed().length - before).toBe(4)
        // Still pushed within the lifetime, polled again after it.
        expect(polls[0]).toEqual(["ai-type"])
        expect(polls.at(-1)).toEqual(["supply-temp", "ai-type"])
      }).pipe(Effect.provideService(Clock.Clock, clock))
    }).pipe(Effect.scoped)
  )
})

/**
 * A clock whose wall time is the test clock's plus `skew`, while sleeps and
 * monotonic time stay the test clock's: how `Date.now()` and timers behave
 * when NTP steps the time.
 */
const skewedClock = Effect.gen(function* () {
  const test = yield* TestClock.testClockWith(Effect.succeed)
  const skew = { ms: 1_700_000_000_000 }
  const wallNanos = () => test.currentTimeNanosUnsafe() + BigInt(skew.ms) * 1_000_000n
  // TestClock.adjust calls `adjust` on the current clock, so this one passes it on.
  const clock: Clock.Clock & Pick<TestClock.TestClock, "adjust"> = {
    currentTimeMillisUnsafe: () => test.currentTimeMillisUnsafe() + skew.ms,
    currentTimeMillis: Effect.sync(() => test.currentTimeMillisUnsafe() + skew.ms),
    currentTimeNanosUnsafe: wallNanos,
    currentTimeNanos: Effect.sync(wallNanos),
    monotonicTimeNanosUnsafe: () => test.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: Effect.sync(() => test.monotonicTimeNanosUnsafe()),
    sleep: (duration) => test.sleep(duration),
    adjust: (duration) => test.adjust(duration)
  }
  return { clock, skew }
})
