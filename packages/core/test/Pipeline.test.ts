import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Layer, Metric, Queue, Stream, Tracer } from "effect"
import { TestClock } from "effect/testing"
import {
  DriverError,
  makeHealthRegistry,
  makeMemoryPublisher,
  pollCycles,
  Publisher,
  PublishError,
  pushedReadings,
  readFailures,
  runDevice,
  valuesPublished,
  valuesSuppressed
} from "../src/index.ts"
import type { AnyPoint, DeviceHealth, Driver, HealthRegistry, Reading } from "../src/index.ts"

const point: AnyPoint = {
  id: "zone-temp",
  name: "Zone temperature",
  unit: "unit:DEG_C",
  writable: false,
  deadband: 0.5,
  scaling: { factor: 0.1, offset: 0 }
}

/** A driver that returns scripted raw values, one per cycle. */
const scriptedDriver = (values: ReadonlyArray<number | "fail">, deviceId = "test-device"): Driver => {
  let i = 0
  return {
    deviceId,
    points: [point],
    readAll: Effect.suspend(() => {
      const v = values[Math.min(i++, values.length - 1)]
      return v === "fail"
        ? Effect.fail(new DriverError({ device: deviceId, reason: "timeout", message: "no reply" }))
        : Effect.succeed<ReadonlyArray<Reading>>([{ pointId: point.id, value: v ?? 0, timestamp: 0 }])
    }),
    write: () => Effect.void
  }
}

/** The first retained metadata `runDevice` publishes for the scripted point, parsed. */
const metaOf = (
  context: { readonly covPoints?: ReadonlyArray<string>; readonly gateway?: string } = {},
  driver: Driver = scriptedDriver([200])
) =>
  Effect.gen(function* () {
    const { messages, layer } = yield* makeMemoryPublisher
    const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000, ...context }, driver).pipe(
      Effect.provide(layer),
      Effect.forkChild
    )
    yield* TestClock.adjust("1 millis")
    yield* Fiber.interrupt(fiber)
    const meta = messages.find((message) => message.topic.endsWith("$meta"))
    return meta === undefined ? undefined : JSON.parse(meta.payload)
  })

describe("runDevice", () => {
  it.effect("publishes metadata, then scaled values outside the deadband", () =>
    Effect.gen(function* () {
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
    })
  )

  it.effect("says when an alarm point's alarm is active", () =>
    Effect.gen(function* () {
      const alarm = { ...scriptedDriver([0]), points: [{ ...point, alarmWhen: "off" as const }] }
      expect(yield* metaOf({}, alarm)).toMatchObject({ name: "Zone temperature", alarmWhen: "off" })
      expect(yield* metaOf()).not.toHaveProperty("alarmWhen")
    })
  )

  it.effect("names the gateway that published the metadata", () =>
    Effect.gen(function* () {
      expect(yield* metaOf({ gateway: "roof" })).toMatchObject({ name: "Zone temperature", gateway: "roof" })
      expect(yield* metaOf()).not.toHaveProperty("gateway")
    })
  )

  it.effect("marks a point asked for by change of value in its metadata, and only that one", () =>
    Effect.gen(function* () {
      expect(yield* metaOf({ covPoints: ["zone-temp"] })).toMatchObject({ name: "Zone temperature", cov: true })
      expect(yield* metaOf()).not.toHaveProperty("cov")
    })
  )

  it.effect("keeps running when the driver fails, and reports it to the health registry", () =>
    Effect.gen(function* () {
      const { messages, layer } = yield* makeMemoryPublisher
      const registry = makeHealthRegistry(["test-device"])
      const recorded: Array<string> = []
      let lastFailure: DeviceHealth | undefined
      const health: HealthRegistry = {
        devices: registry.devices,
        recordSuccess: (device, timestamp) => {
          recorded.push("ok")
          registry.recordSuccess(device, timestamp)
        },
        recordFailure: (device, failure) => {
          recorded.push(`failing:${failure.reason}`)
          registry.recordFailure(device, failure)
          lastFailure = registry.devices.get(device)
        },
        onChange: registry.onChange
      }
      const driver = scriptedDriver(["fail", "fail", "fail", "fail", "fail", 300])
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000, health }, driver).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("1 minute")
      yield* Fiber.interrupt(fiber)

      const values = messages.slice(1).map((m) => JSON.parse(m.payload).value)
      expect(values).toEqual([30])
      // The first cycle fails after its retries; every later cycle reads fine.
      expect(recorded[0]).toBe("failing:timeout")
      // While it failed, the registry kept the driver's own words and when it started.
      expect(lastFailure).toMatchObject({ status: "failing", reason: "timeout", failures: 1 })
      expect(lastFailure?.failingSince).toEqual(expect.any(Number))
      expect(lastFailure?.lastError).toEqual(expect.any(String))
      expect(recorded.slice(1).every((entry) => entry === "ok")).toBe(true)
      expect(health.devices.get("test-device")?.status).toBe("ok")
    })
  )

  it.effect("retries a value on the next cycle when its publish failed", () =>
    Effect.gen(function* () {
      const published: Array<number> = []
      let valuePublishes = 0
      const flakyPublisher = Layer.succeed(Publisher, {
        publish: (topic, payload) =>
          Effect.suspend(() => {
            if (topic.endsWith("$meta")) return Effect.void
            valuePublishes++
            if (valuePublishes === 1)
              return Effect.fail(new PublishError({ topic, reason: "unavailable", message: "broker down" }))
            published.push(JSON.parse(payload).value)
            return Effect.void
          })
      })
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 1000 },
        scriptedDriver([200], "flaky-publish")
      ).pipe(Effect.provide(flakyPublisher), Effect.forkChild)
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(fiber)

      // The first publish failed; the unchanged value goes out on the next cycle.
      expect(published).toEqual([20])
    })
  )

  it.effect("keeps reading while the broker is down at startup, and sends metadata once it is back", () =>
    Effect.gen(function* () {
      const topics: Array<string> = []
      let brokerUp = false
      let reads = 0
      const publisher = Layer.succeed(Publisher, {
        publish: (topic) =>
          Effect.suspend(() => {
            if (!brokerUp)
              return Effect.fail(new PublishError({ topic, reason: "unavailable", message: "broker down" }))
            topics.push(topic)
            return Effect.void
          })
      })
      const driver = scriptedDriver([200], "late-broker")
      const counted: Driver = {
        ...driver,
        readAll: Effect.suspend(() => {
          reads++
          return driver.readAll
        })
      }
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000 }, counted).pipe(
        Effect.provide(publisher),
        Effect.forkChild
      )
      yield* TestClock.adjust("1 second")
      expect(reads).toBe(2)
      expect(topics).toEqual([])

      brokerUp = true
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)

      // Metadata first, exactly once, then the value that never got out.
      expect(topics).toEqual(["s/b/late-broker/zone-temp/$meta", "s/b/late-broker/zone-temp"])
    })
  )
  it.effect("skips a point the broker refuses and still publishes the others", () =>
    Effect.gen(function* () {
      const second: AnyPoint = { ...point, id: "zone-humidity", name: "Zone humidity" }
      const driver: Driver = {
        deviceId: "acl",
        points: [point, second],
        readAll: Effect.succeed<ReadonlyArray<Reading>>([
          { pointId: point.id, value: 200, timestamp: 0 },
          { pointId: second.id, value: 400, timestamp: 0 }
        ]),
        write: () => Effect.void
      }
      const attempts: Array<string> = []
      const delivered: Array<string> = []
      const publisher = Layer.succeed(Publisher, {
        publish: (topic) =>
          Effect.suspend(() => {
            attempts.push(topic)
            if (topic.includes("zone-temp"))
              return Effect.fail(new PublishError({ topic, reason: "rejected", message: "not authorized" }))
            delivered.push(topic)
            return Effect.void
          })
      })
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000 }, driver).pipe(
        Effect.provide(publisher),
        Effect.forkChild
      )
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(fiber)

      expect(delivered).toEqual(["s/b/acl/zone-humidity/$meta", "s/b/acl/zone-humidity"])
      // Refused metadata is given up on; a refused value is tried again with the next reading.
      expect(attempts.filter((topic) => topic === "s/b/acl/zone-temp/$meta")).toHaveLength(1)
      expect(attempts.filter((topic) => topic === "s/b/acl/zone-temp")).toHaveLength(2)
      expect(yield* countOf(pollCycles, { device: "acl", outcome: "ok" })).toBe(2)
    })
  )

  it.effect("records every point's reading while the broker is down, and asks the broker once per cycle", () =>
    Effect.gen(function* () {
      const second: AnyPoint = { ...point, id: "zone-humidity", name: "Zone humidity" }
      const driver: Driver = {
        deviceId: "offline",
        points: [point, second],
        readAll: Effect.succeed<ReadonlyArray<Reading>>([
          { pointId: point.id, value: 200, timestamp: 0 },
          { pointId: second.id, value: 400, timestamp: 0 }
        ]),
        write: () => Effect.void
      }
      const recorded: Array<string> = []
      const attempts: Array<string> = []
      const publisher = Layer.succeed(Publisher, {
        publish: (topic) =>
          Effect.suspend(() => {
            attempts.push(topic)
            return Effect.fail(new PublishError({ topic, reason: "unavailable", message: "not connected" }))
          })
      })
      const history = { record: (_device: string, pointId: string) => void recorded.push(pointId) }
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000, history }, driver).pipe(
        Effect.provide(publisher),
        Effect.forkChild
      )
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(fiber)

      expect(recorded).toEqual(["zone-temp", "zone-humidity", "zone-temp", "zone-humidity"])
      // A broker that is down is asked once per cycle, not once per point, each waiting for the publish timeout.
      expect(attempts.filter((topic) => !topic.endsWith("$meta"))).toEqual([
        "s/b/offline/zone-temp",
        "s/b/offline/zone-temp"
      ])
      expect(yield* countOf(pollCycles, { device: "offline", outcome: "publish_failed" })).toBe(2)
    })
  )
})

/** Read a counter's count for one combination of attributes. */
const countOf = (metric: Metric.Counter<number>, attributes: Record<string, string>) =>
  Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.map((state) => state.count))

/** How often a driver that always fails with `reason` is read in the first cycle. */
const readsInOneCycle = (reason: DriverError["reason"]) =>
  Effect.gen(function* () {
    const { layer } = yield* makeMemoryPublisher
    let reads = 0
    const driver: Driver = {
      deviceId: `always-${reason}`,
      points: [point],
      readAll: Effect.suspend(() => {
        reads++
        return Effect.fail(new DriverError({ device: `always-${reason}`, reason, message: "no" }))
      }),
      write: () => Effect.void
    }
    const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 60_000 }, driver).pipe(
      Effect.provide(layer),
      Effect.forkChild
    )
    // Long enough for every retry of the first cycle, short of the next cycle.
    yield* TestClock.adjust("30 seconds")
    yield* Fiber.interrupt(fiber)
    return reads
  })

describe("runDevice metrics", () => {
  it.effect("counts cycles, published and suppressed values per device", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeMemoryPublisher
      const device = "metrics-ok"
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 1000 },
        scriptedDriver([200, 202, 210], device)
      ).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)

      expect(yield* countOf(pollCycles, { device, outcome: "ok" })).toBe(3)
      expect(yield* countOf(valuesPublished, { device })).toBe(2)
      expect(yield* countOf(valuesSuppressed, { device })).toBe(1)
    })
  )

  it.effect("counts a failed cycle once, after retries, with the driver's reason", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeMemoryPublisher
      const device = "metrics-fail"
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 1000 },
        scriptedDriver(["fail", "fail", "fail", "fail", "fail", 300], device)
      ).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust("1 minute")
      yield* Fiber.interrupt(fiber)

      expect(yield* countOf(pollCycles, { device, outcome: "read_failed" })).toBe(1)
      expect(yield* countOf(readFailures, { device, reason: "timeout" })).toBe(1)
    })
  )

  it.effect("does not retry a timeout within the cycle when the driver resends requests itself", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeMemoryPublisher
      let reads = 0
      const scripted = scriptedDriver(["fail", 300], "self-retrying")
      const driver: Driver = {
        ...scripted,
        retriesTimeouts: true,
        readAll: Effect.suspend(() => {
          reads++
          return scripted.readAll
        })
      }
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 60_000 }, driver).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("30 seconds")
      yield* Fiber.interrupt(fiber)
      // One read for the first cycle: its timeout was not retried, and the next cycle is a minute away.
      expect(reads).toBe(1)
    })
  )

  it.effect("does not retry a device that refused the read", () =>
    Effect.gen(function* () {
      expect(yield* readsInOneCycle("protocol")).toBe(1)
      expect(yield* readsInOneCycle("configuration")).toBe(1)
    })
  )

  it.effect("retries transport failures within the cycle", () =>
    Effect.gen(function* () {
      expect(yield* readsInOneCycle("timeout")).toBe(5)
      expect(yield* readsInOneCycle("connection")).toBe(5)
      expect(yield* readsInOneCycle("invalid-response")).toBe(5)
    })
  )
})

describe("runDevice with pushed values", () => {
  it.effect("publishes pushed values between polls, through the same scaling and deadband", () =>
    Effect.gen(function* () {
      const { messages, layer } = yield* makeMemoryPublisher
      const pushes = yield* Queue.unbounded<Reading>()
      const driver: Driver = { ...scriptedDriver([200], "pushing"), changes: Stream.fromQueue(pushes) }
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 60_000 }, driver).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("1 second")
      // 20.2 is inside the deadband of the polled 20.0; 21.0 and 19.0 are not.
      for (const [value, timestamp] of [
        [202, 2000],
        [210, 3000],
        [190, 4000]
      ] as const) {
        yield* Queue.offer(pushes, { pointId: point.id, value, timestamp })
        yield* TestClock.adjust("1 second")
      }
      yield* Fiber.interrupt(fiber)

      const values = messages.slice(1).map((m) => JSON.parse(m.payload))
      expect(values).toEqual([
        { value: 20, unit: "unit:DEG_C", ts: 0 },
        { value: 21, unit: "unit:DEG_C", ts: 3000 },
        { value: 19, unit: "unit:DEG_C", ts: 4000 }
      ])
      expect(yield* countOf(pushedReadings, { device: "pushing" })).toBe(3)
    })
  )

  it.effect("keeps polling when a pushed value cannot be published", () =>
    Effect.gen(function* () {
      const { messages, layer: memory } = yield* makeMemoryPublisher
      let brokerDown = true
      const flaky = Layer.effect(
        Publisher,
        Effect.gen(function* () {
          const inner = yield* Publisher
          return Publisher.of({
            ...inner,
            publish: (topic, payload, options) =>
              brokerDown && !topic.endsWith("$meta")
                ? Effect.fail(new PublishError({ topic, reason: "unavailable", message: "broker down" }))
                : inner.publish(topic, payload, options)
          })
        })
      ).pipe(Layer.provide(memory))
      const pushes = yield* Queue.unbounded<Reading>()
      const driver: Driver = { ...scriptedDriver([200, 200, 230], "flaky-push"), changes: Stream.fromQueue(pushes) }
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000 }, driver).pipe(
        Effect.provide(flaky),
        Effect.forkChild
      )
      yield* Queue.offer(pushes, { pointId: point.id, value: 250, timestamp: 0 })
      yield* TestClock.adjust("500 millis")
      brokerDown = false
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)

      // The pushed 25.0 was lost with the broker; polling went on and published 20.0, then 23.0.
      expect(messages.slice(1).map((m) => JSON.parse(m.payload).value)).toEqual([20, 23])
      expect(yield* countOf(pushedReadings, { device: "flaky-push" })).toBe(1)
    })
  )

  it.effect("drops a polled value when a push for its point arrived while the device was being read", () =>
    Effect.gen(function* () {
      const { messages, layer } = yield* makeMemoryPublisher
      const pushes = yield* Queue.unbounded<Reading>()
      // The read takes 500 ms; the push arrives 200 ms into it, so the polled 30.0 is older.
      const slow = scriptedDriver([300], "overlap")
      const driver: Driver = {
        ...slow,
        readAll: Effect.andThen(Effect.sleep("500 millis"), slow.readAll),
        changes: Stream.fromQueue(pushes)
      }
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000 }, driver).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("200 millis")
      yield* Queue.offer(pushes, { pointId: point.id, value: 250, timestamp: 200 })
      yield* TestClock.adjust("700 millis")
      yield* Fiber.interrupt(fiber)

      expect(messages.slice(1).map((m) => JSON.parse(m.payload).value)).toEqual([25])
    })
  )

  it.effect("orders readings by when they were handled, not by their timestamps, which can step back", () =>
    Effect.gen(function* () {
      const { messages, layer } = yield* makeMemoryPublisher
      const pushes = yield* Queue.unbounded<Reading>()
      // Polled values carry timestamp 0, an hour before the push: the wall clock stepped back since.
      const driver: Driver = { ...scriptedDriver([200, 200, 300], "stepped"), changes: Stream.fromQueue(pushes) }
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 1000 }, driver).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("100 millis")
      yield* Queue.offer(pushes, { pointId: point.id, value: 250, timestamp: 3_600_000 })
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)

      expect(messages.slice(1).map((m) => JSON.parse(m.payload).value)).toEqual([20, 25, 20, 30])
    })
  )
})

/** `count` points `p-0`, `p-1`, …, published on every read unless `extra` says otherwise. */
const manyPoints = (count: number, extra: Partial<AnyPoint> = {}): ReadonlyArray<AnyPoint> =>
  Array.from({ length: count }, (_, index) => ({ id: `p-${index}`, name: `Point ${index}`, writable: false, ...extra }))

/** A driver that reads every point as `value` on every cycle. */
const constantDriver = (deviceId: string, points: ReadonlyArray<AnyPoint>, value = 1): Driver => ({
  deviceId,
  points,
  readAll: Effect.succeed(points.map((p): Reading => ({ pointId: p.id, value, timestamp: 0 }))),
  write: () => Effect.void
})

interface Attempt {
  readonly topic: string
  readonly payload: string
  readonly startedAt: number
  readonly endedAt?: number
}

/**
 * A publisher whose every publish takes 50 ms of test-clock time (`delayMs` decides otherwise), then fails with
 * what `failWith` returns for the topic, if anything. Records each attempt and when it started and ended.
 */
const slowPublisher = (
  options: {
    readonly failWith?: (topic: string) => PublishError["reason"] | undefined
    readonly delayMs?: (topic: string, payload: string) => number
  } = {}
) => {
  const attempts: Array<Attempt> = []
  const delivered: Array<Attempt> = []
  const layer = Layer.succeed(Publisher, {
    publish: (topic, payload) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        attempts.push({ topic, payload, startedAt })
        yield* Effect.sleep(options.delayMs?.(topic, payload) ?? 50)
        const reason = options.failWith?.(topic)
        if (reason !== undefined) return yield* new PublishError({ topic, reason, message: reason })
        delivered.push({ topic, payload, startedAt, endedAt: yield* Clock.currentTimeMillis })
      })
  })
  return { attempts, delivered, layer } as const
}

const valuesOf = (attempts: ReadonlyArray<Attempt>) => attempts.filter((attempt) => !attempt.topic.endsWith("$meta"))

const metaTopics = (attempts: ReadonlyArray<Attempt>) =>
  attempts.filter((attempt) => attempt.topic.endsWith("$meta")).map((attempt) => attempt.topic)

describe("runDevice publishing a cycle concurrently", () => {
  it.effect("publishes a hundred values within 400 ms of 50 ms acknowledgements", () =>
    Effect.gen(function* () {
      const { delivered, layer } = slowPublisher()
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 60_000 },
        constantDriver("concurrent", manyPoints(100))
      ).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)

      const values = valuesOf(delivered)
      expect(new Set(values.map((attempt) => attempt.topic)).size).toBe(100)
      const started = Math.min(...values.map((attempt) => attempt.startedAt))
      const ended = Math.max(...values.map((attempt) => attempt.endedAt ?? Infinity))
      // 7 rounds of 16, 50 ms each; one at a time would take 5 s.
      expect(ended - started).toBeLessThanOrEqual(400)
    })
  )

  it.effect("keeps a refused point's deadband reference while its neighbours' references update", () =>
    Effect.gen(function* () {
      const { attempts, layer } = slowPublisher({
        failWith: (topic) => (topic === "s/b/deadbands/p-1" ? "rejected" : undefined)
      })
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 1000 },
        constantDriver("deadbands", manyPoints(3, { deadband: 0.5 }))
      ).pipe(Effect.provide(layer), Effect.forkChild)
      // Two cycles reading the same values.
      yield* TestClock.adjust("1500 millis")
      yield* Fiber.interrupt(fiber)

      const tries = (topic: string) => valuesOf(attempts).filter((attempt) => attempt.topic === topic).length
      // The refused value is offered again; the others stayed inside their deadband.
      expect(tries("s/b/deadbands/p-1")).toBe(2)
      expect(tries("s/b/deadbands/p-0")).toBe(1)
      expect(tries("s/b/deadbands/p-2")).toBe(1)
    })
  )

  it.effect("starts no publish after the broker failed, and still records every reading and the device's health", () =>
    Effect.gen(function* () {
      const device = "concurrent-down"
      const { attempts, layer } = slowPublisher({ failWith: () => "unavailable" })
      const recorded: Array<string> = []
      const history = { record: (_device: string, pointId: string) => void recorded.push(pointId) }
      const health = makeHealthRegistry([device])
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 60_000, history, health },
        constantDriver(device, manyPoints(100))
      ).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)

      expect(valuesOf(attempts).length).toBeGreaterThan(0)
      expect(valuesOf(attempts).length).toBeLessThanOrEqual(16)
      expect(new Set(recorded).size).toBe(100)
      expect(recorded).toHaveLength(100)
      expect(yield* countOf(pollCycles, { device, outcome: "publish_failed" })).toBe(1)
      expect(health.devices.get(device)?.status).toBe("ok")
    })
  )

  it.effect("publishes the other 99 values when the broker refuses one in the middle", () =>
    Effect.gen(function* () {
      const device = "concurrent-refused"
      const { delivered, layer } = slowPublisher({
        failWith: (topic) => (topic === `s/b/${device}/p-50` ? "rejected" : undefined)
      })
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 60_000 },
        constantDriver(device, manyPoints(100))
      ).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)

      const topics = new Set(valuesOf(delivered).map((attempt) => attempt.topic))
      expect(topics.size).toBe(99)
      expect(topics.has(`s/b/${device}/p-50`)).toBe(false)
      expect(yield* countOf(pollCycles, { device, outcome: "ok" })).toBe(1)
    })
  )

  it.effect("publishes two readings of one point in one cycle in the order they were read", () =>
    Effect.gen(function* () {
      const points = manyPoints(2)
      const driver: Driver = {
        deviceId: "twice",
        points,
        readAll: Effect.succeed<ReadonlyArray<Reading>>([
          { pointId: "p-0", value: 1, timestamp: 0 },
          { pointId: "p-1", value: 5, timestamp: 0 },
          { pointId: "p-0", value: 2, timestamp: 1 }
        ]),
        write: () => Effect.void
      }
      // The first value is the slowest to publish: concurrently it would arrive after the second.
      const { delivered, layer } = slowPublisher({
        delayMs: (_topic, payload) => (JSON.parse(payload).value === 1 ? 100 : 10)
      })
      const fiber = yield* runDevice({ site: "s", building: "b", pollIntervalMs: 60_000 }, driver).pipe(
        Effect.provide(layer),
        Effect.forkChild
      )
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(fiber)

      const values = valuesOf(delivered)
        .filter((attempt) => attempt.topic === "s/b/twice/p-0")
        .map((attempt) => JSON.parse(attempt.payload).value)
      expect(values).toEqual([1, 2])
    })
  )

  it.effect("publishes a hundred points' metadata within 400 ms", () =>
    Effect.gen(function* () {
      const { delivered, layer } = slowPublisher()
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 60_000 },
        constantDriver("concurrent-meta", manyPoints(100))
      ).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust("400 millis")
      yield* Fiber.interrupt(fiber)

      expect(delivered.filter((attempt) => attempt.topic.endsWith("$meta"))).toHaveLength(100)
    })
  )

  it.effect("retries only the metadata the broker did not take", () =>
    Effect.gen(function* () {
      const failing = "s/b/meta-retry/p-1/$meta"
      let failures = 0
      const { attempts, delivered, layer } = slowPublisher({
        // The others finish at once; the failing one fails after they did, so nothing in flight is interrupted.
        delayMs: (topic) => (topic === failing ? 10 : 0),
        failWith: (topic) => {
          if (topic !== failing || failures > 0) return undefined
          failures++
          return "unavailable"
        }
      })
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 1000 },
        constantDriver("meta-retry", manyPoints(3))
      ).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust("2500 millis")
      yield* Fiber.interrupt(fiber)

      expect(metaTopics(attempts).toSorted()).toEqual([
        "s/b/meta-retry/p-0/$meta",
        "s/b/meta-retry/p-1/$meta",
        "s/b/meta-retry/p-1/$meta",
        "s/b/meta-retry/p-2/$meta"
      ])
      expect(metaTopics(delivered).toSorted()).toEqual([
        "s/b/meta-retry/p-0/$meta",
        "s/b/meta-retry/p-1/$meta",
        "s/b/meta-retry/p-2/$meta"
      ])
    })
  )
})

describe("runDevice closing aggregate windows", () => {
  it.effect("closes every window at a boundary the broker is down for, and asks it once", () =>
    Effect.gen(function* () {
      const device = "windows-outage"
      let brokerDown = false
      const attempts: Array<{ readonly topic: string; readonly at: number }> = []
      const delivered: Array<{ readonly topic: string; readonly payload: string }> = []
      const layer = Layer.succeed(Publisher, {
        publish: (topic, payload) =>
          Effect.gen(function* () {
            if (topic.endsWith("$meta")) return
            attempts.push({ topic, at: yield* Clock.currentTimeMillis })
            if (brokerDown) return yield* new PublishError({ topic, reason: "unavailable", message: "down" })
            delivered.push({ topic, payload })
          })
      })
      const points = manyPoints(3, { publish: { mode: "aggregate", intervalMs: 5000 } })
      // Off the window boundaries, so a read never lands on one.
      yield* TestClock.adjust("500 millis")
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 1000 },
        constantDriver(device, points)
      ).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust("9 seconds")
      brokerDown = true
      yield* TestClock.adjust("1 second")
      brokerDown = false
      yield* TestClock.adjust("5 seconds")
      yield* Fiber.interrupt(fiber)

      // The boundary at 10 s asked the broker once, not once per point.
      expect(attempts.filter((attempt) => attempt.at === 10_000)).toHaveLength(1)
      // After the outage each point's message covers the one window [10 s, 15 s), with its five reads.
      for (const aggregated of points) {
        const last = delivered
          .filter((message) => message.topic === `s/b/${device}/${aggregated.id}`)
          .map((message) => JSON.parse(message.payload))
          .at(-1)
        expect(last).toMatchObject({ count: 5, from: 10_000, to: 15_000 })
      }
    })
  )
})

/** A tracer that records whether each `Device.pollCycle` span was sampled. */
const recordingTracer = () => {
  const sampled: Array<boolean> = []
  const tracer = Tracer.make({
    span: (options) => {
      if (options.name === "Device.pollCycle") sampled.push(options.sampled)
      return new Tracer.NativeSpan(options)
    }
  })
  return { sampled, tracer } as const
}

/** Run ten cycles and return whether each was sampled. */
const runCycles = (traceSampleRatio: number | undefined) =>
  Effect.gen(function* () {
    const { layer } = yield* makeMemoryPublisher
    const { sampled, tracer } = recordingTracer()
    const ctx = {
      site: "s",
      building: "b",
      pollIntervalMs: 1000,
      ...(traceSampleRatio === undefined ? {} : { traceSampleRatio })
    }
    const fiber = yield* runDevice(ctx, scriptedDriver([200], "sampling")).pipe(
      Effect.provide(layer),
      Effect.withTracer(tracer),
      Effect.forkChild
    )
    yield* TestClock.adjust("9 seconds")
    yield* Fiber.interrupt(fiber)
    return sampled
  })

describe("runDevice trace sampling", () => {
  it.effect("samples every cycle by default", () =>
    Effect.gen(function* () {
      const sampled = yield* runCycles(undefined)
      expect(sampled).toHaveLength(10)
      expect(sampled.every((value) => value)).toBe(true)
    })
  )

  it.effect("samples no cycle at ratio 0", () =>
    Effect.gen(function* () {
      const sampled = yield* runCycles(0)
      expect(sampled).toHaveLength(10)
      expect(sampled.some((value) => value)).toBe(false)
    })
  )
})
