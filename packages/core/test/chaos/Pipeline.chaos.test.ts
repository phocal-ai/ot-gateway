/**
 * Failure modes found by chaos testing the pipeline, kept as regression tests.
 * Each test asserts the fixed behaviour.
 */
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Layer, Logger, Metric, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  DriverError,
  makeHealthRegistry,
  makeMemoryPublisher,
  pointReadFailures,
  pollCycles,
  Publisher,
  PublishError,
  publishFailures,
  readFailures,
  runDevice
} from "../../src/index.ts"
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
      expect(yield* countOf(pointReadFailures, { device: "not-finite", reason: "not_finite" })).toBe(3)
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

describe("chaos: hangs", () => {
  it.effect("a readAll that hangs fails the cycle at its deadline and marks the device failing", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeMemoryPublisher
      const health = makeHealthRegistry(["hang-read"])
      let reads = 0
      let hanging = true
      const driver: Driver = {
        deviceId: "hang-read",
        points: [pointNamed("temp")],
        readAll: Effect.suspend(() => {
          reads++
          if (reads > 1 && hanging) return Effect.never
          return Effect.map(Clock.currentTimeMillis, (now): ReadonlyArray<Reading> => [
            { pointId: "temp", value: reads, timestamp: now }
          ])
        }),
        write: () => Effect.void
      }
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000, health }, driver).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      // Default deadline at a 1 s interval: 31 s. Cycles: ok at 0, hung from 1 s to 32 s, then from 33 s to 64 s.
      yield* TestClock.adjust("64500 millis")
      expect(health.devices.get("hang-read")).toMatchObject({ status: "failing", reason: "cycle-timeout" })
      expect(yield* countOf(pollCycles, { device: "hang-read", outcome: "timed_out" })).toBe(2)
      expect(reads).toBe(3)

      hanging = false
      yield* TestClock.adjust("40 seconds")
      yield* Fiber.interrupt(fiber)
      expect(health.devices.get("hang-read")?.status).toBe("ok")
    })
  )

  it.effect("a publish that hangs fails the cycle at a configured deadline", () =>
    Effect.gen(function* () {
      const health = makeHealthRegistry(["hang-publish"])
      const hangingPublisher = Layer.succeed(Publisher, {
        publish: (topic) => (topic.endsWith("$meta") ? Effect.void : Effect.never)
      })
      const driver = scripted("hang-publish", [pointNamed("temp")], [[["temp", 1]], [["temp", 2]]])
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 1000, cycleTimeoutMs: 5000, health },
        driver
      ).pipe(Effect.provide(hangingPublisher), Effect.forkChild)
      yield* TestClock.adjust("1 minute")
      yield* Fiber.interrupt(fiber)

      expect(health.devices.get("hang-publish")).toMatchObject({ status: "failing", reason: "cycle-timeout" })
      // One cycle every 6 s: 5 s until the deadline, then the 1 s interval.
      expect(yield* countOf(pollCycles, { device: "hang-publish", outcome: "timed_out" })).toBe(10)
    })
  )

  it.effect("a pushed value whose publish hangs is dropped at the deadline, so polling goes on", () =>
    Effect.gen(function* () {
      const { messages, layer: memory } = yield* makeMemoryPublisher
      const publisher = Layer.effect(
        Publisher,
        Effect.gen(function* () {
          const inner = yield* Publisher
          return Publisher.of({
            publish: (topic, payload, options) =>
              Effect.suspend(() => {
                if (JSON.parse(payload).value === 99) return Effect.never
                return inner.publish(topic, payload, options)
              })
          })
        })
      ).pipe(Layer.provide(memory))
      const pushes = yield* Queue.unbounded<Reading>()
      const polled = scripted("hang-push", [pointNamed("temp")], [[["temp", 1]], [["temp", 2]], [["temp", 3]]])
      const driver: Driver = { ...polled, changes: Stream.fromQueue(pushes) }
      yield* Queue.offer(pushes, { pointId: "temp", value: 99, timestamp: 0 })
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 1000, cycleTimeoutMs: 5000 },
        driver
      ).pipe(Effect.provide(publisher), Effect.forkChild)
      yield* TestClock.adjust("20 seconds")
      yield* Fiber.interrupt(fiber)

      // The pushed 99 hung and was dropped; the polled values that waited for it went out after.
      expect(valuesOn(messages, "s/b/hang-push/temp")).toContain(3)
      expect(valuesOn(messages, "s/b/hang-push/temp")).not.toContain(99)
      expect(yield* countOf(publishFailures, { device: "hang-push" })).toBeGreaterThanOrEqual(1)
    })
  )
})

/** A logger that records each message with its level, instead of printing it. */
const recordLogs = () => {
  const lines: Array<string> = []
  const layer = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      lines.push(`${logLevel}: ${(Array.isArray(message) ? message : [message]).join(" ")}`)
    })
  ])
  return { lines, layer } as const
}

describe("chaos: a device or broker that stays down", () => {
  it.effect("logs a failing device when it starts failing and when it recovers, not every cycle", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeMemoryPublisher
      const logs = recordLogs()
      let reads = 0
      const driver: Driver = {
        deviceId: "down",
        points: [pointNamed("temp")],
        readAll: Effect.suspend(() => {
          reads++
          if (reads <= 10)
            return Effect.fail(new DriverError({ device: "down", reason: "protocol", message: "refused" }))
          return Effect.map(Clock.currentTimeMillis, (now): ReadonlyArray<Reading> => [
            { pointId: "temp", value: reads, timestamp: now }
          ])
        }),
        write: () => Effect.void
      }
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000 }, driver).pipe(
        Effect.provide(layer),
        Effect.provide(logs.layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("15 seconds")
      yield* Fiber.interrupt(fiber)

      expect(logs.lines.filter((line) => line.includes("device read failed"))).toEqual(["Warn: device read failed"])
      expect(logs.lines.filter((line) => line.includes("device works again"))).toEqual(["Info: device works again"])
      expect(yield* countOf(readFailures, { device: "down", reason: "protocol" })).toBe(10)
    })
  )

  it.effect("logs a broker outage once per device, and once when publishing works again", () =>
    Effect.gen(function* () {
      const logs = recordLogs()
      let brokerDown = true
      const publisher = Layer.succeed(Publisher, {
        publish: (topic) =>
          brokerDown ? Effect.fail(new PublishError({ topic, reason: "unavailable", message: "down" })) : Effect.void
      })
      const driver = scripted("no-broker", [pointNamed("temp")], [[["temp", 1]], [["temp", 2]]])
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000 }, driver).pipe(
        Effect.provide(publisher),
        Effect.provide(logs.layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("10 seconds")
      brokerDown = false
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)

      const warnings = logs.lines.filter((line) => line.startsWith("Warn"))
      expect(warnings).toHaveLength(1)
      expect(logs.lines.filter((line) => line.includes("publishing works again"))).toHaveLength(1)
      expect(yield* countOf(publishFailures, { device: "no-broker" })).toBeGreaterThanOrEqual(20)
    })
  )

  it.effect("does not take a cycle that published nothing for the end of a broker outage", () =>
    Effect.gen(function* () {
      const logs = recordLogs()
      let brokerDown = false
      const publisher = Layer.succeed(Publisher, {
        publish: (topic) =>
          brokerDown ? Effect.fail(new PublishError({ topic, reason: "unavailable", message: "down" })) : Effect.void
      })
      // 1 goes out; then the broker goes down while the value alternates: 1 stays inside the deadband
      // (nothing to publish, so the cycle succeeds) and 2 fails to publish.
      const values = Array.from({ length: 20 }, (_, index): ReadonlyArray<readonly [string, PointValue]> => [
        ["temp", index % 2 === 0 ? 1 : 2]
      ])
      const driver = scripted("flapping", [pointNamed("temp")], values)
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000 }, driver).pipe(
        Effect.provide(publisher),
        Effect.provide(logs.layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("500 millis")
      brokerDown = true
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.interrupt(fiber)

      expect(logs.lines.filter((line) => line.startsWith("Warn"))).toEqual(["Warn: publish failed"])
      expect(logs.lines.filter((line) => line.includes("publishing works again"))).toEqual([])
    })
  )
})
