import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Logger, Metric } from "effect"
import { TestClock } from "effect/testing"
import {
  healthTopic,
  makeHealthRegistry,
  makeMemoryPublisher,
  offlinePayload,
  onlinePayload,
  Publisher,
  PublishError,
  publishFailures,
  runHealthReporter,
  withMetricAttributes
} from "../src/index.ts"
import type { DeviceFailure, HealthChange, HealthReason } from "../src/index.ts"

/** A failure of `reason`, at `at` ms. */
const fail = (reason: HealthReason, at = 0, message = `${reason} failure`): DeviceFailure => ({ reason, message, at })

describe("HealthRegistry", () => {
  it("starts every device as starting, then tracks the last cycle", () => {
    const registry = makeHealthRegistry(["ventilation-1", "meter"])
    expect(Object.fromEntries(registry.devices)).toEqual({
      "ventilation-1": { status: "starting" },
      meter: { status: "starting" }
    })

    registry.recordSuccess("meter", 1000)
    registry.recordFailure("meter", fail("timeout", 1500, "no response to 2 item(s) within 3s"))
    registry.recordFailure("ventilation-1", fail("connection", 1600))
    expect(registry.devices.get("meter")).toEqual({
      status: "failing",
      reason: "timeout",
      lastSuccess: 1000,
      failingSince: 1500,
      lastError: "no response to 2 item(s) within 3s",
      failures: 1
    })
    expect(registry.devices.get("ventilation-1")).toMatchObject({ status: "failing", reason: "connection" })

    registry.recordSuccess("meter", 2000)
    expect(registry.devices.get("meter")).toEqual({ status: "ok", lastSuccess: 2000 })
  })

  it("keeps when a run of failures started and counts it, whatever the reason, until a read works", () => {
    const registry = makeHealthRegistry(["meter"])
    registry.recordFailure("meter", fail("timeout", 100))
    registry.recordFailure("meter", fail("timeout", 200))
    registry.recordFailure("meter", fail("connection", 300, "could not connect: connection refused by 10.0.0.9:502"))
    expect(registry.devices.get("meter")).toMatchObject({
      failingSince: 100,
      failures: 3,
      reason: "connection",
      lastError: "could not connect: connection refused by 10.0.0.9:502"
    })
    registry.recordSuccess("meter", 400)
    registry.recordFailure("meter", fail("timeout", 500))
    expect(registry.devices.get("meter")).toMatchObject({ failingSince: 500, failures: 1, lastSuccess: 400 })
  })

  it("hands listeners the device's health before and after the change", () => {
    const registry = makeHealthRegistry(["meter"])
    const changes: Array<HealthChange> = []
    registry.onChange((change) => changes.push(change))
    registry.recordSuccess("meter", 1)
    registry.recordFailure("meter", fail("timeout", 2))
    expect(changes.map((change) => [change.device, change.previous.status, change.next.status])).toEqual([
      ["meter", "starting", "ok"],
      ["meter", "ok", "failing"]
    ])
  })

  it("tells listeners about status and reason changes only, until they unsubscribe", () => {
    const registry = makeHealthRegistry(["meter"])
    let changes = 0
    const unsubscribe = registry.onChange(() => changes++)

    registry.recordSuccess("meter", 1) // starting -> ok
    registry.recordSuccess("meter", 2) // still ok
    registry.recordFailure("meter", fail("timeout")) // ok -> failing
    registry.recordFailure("meter", fail("timeout")) // same reason
    registry.recordFailure("meter", fail("connection")) // another reason
    expect(changes).toBe(3)

    unsubscribe()
    registry.recordSuccess("meter", 3)
    expect(changes).toBe(3)
  })
})

describe("runHealthReporter on change", () => {
  it.effect("stops listening to the registry when it stops", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeMemoryPublisher
      const registry = makeHealthRegistry(["meter"])
      let listeners = 0
      const counting = {
        ...registry,
        onChange: (listener: (change: HealthChange) => void) => {
          listeners++
          const unsubscribe = registry.onChange(listener)
          return () => {
            listeners--
            unsubscribe()
          }
        }
      }
      const fiber = yield* runHealthReporter({
        topic: "t",
        intervalMs: 60_000,
        online: Effect.succeed("{}"),
        registry: counting
      }).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust("1 second")
      expect(listeners).toBe(1)
      yield* Fiber.interrupt(fiber)
      expect(listeners).toBe(0)
    })
  )
})

describe("health messages", () => {
  it("uses the $gateway topic convention", () => {
    expect(healthTopic("s", "b", "main")).toBe("s/b/$gateway/main/health")
  })

  it("renders online with device status and offline with a reason", () => {
    const registry = makeHealthRegistry(["meter"])
    registry.recordSuccess("meter", 5)
    expect(JSON.parse(onlinePayload(registry, 1, 10))).toEqual({
      status: "online",
      since: 1,
      ts: 10,
      devices: { meter: { status: "ok", lastSuccess: 5 } }
    })
    expect(JSON.parse(offlinePayload("shutdown"))).toEqual({ status: "offline", reason: "shutdown" })
  })

  it("says since when a device fails, but keeps the error text and count on the gateway", () => {
    const registry = makeHealthRegistry(["meter"])
    registry.recordSuccess("meter", 5)
    registry.recordFailure("meter", fail("connection", 7, "could not connect: connection refused by 10.0.0.9:502"))
    expect(JSON.parse(onlinePayload(registry, 1, 10)).devices).toEqual({
      meter: { status: "failing", reason: "connection", lastSuccess: 5, failingSince: 7 }
    })
  })

  it("carries the host's sample once there is one", () => {
    const host = { memoryBytes: 1e8, eventLoopLagMs: 12, clockSteps: 1, temperatureC: 61.2, throttled: [] }
    expect(JSON.parse(onlinePayload(makeHealthRegistry([]), 1, 10, host))).toEqual({
      status: "online",
      since: 1,
      ts: 10,
      devices: {},
      host
    })
  })
})

describe("runHealthReporter", () => {
  it.effect("refreshes the retained health message every interval", () =>
    Effect.gen(function* () {
      const { messages, layer } = yield* makeMemoryPublisher
      let renders = 0
      const fiber = yield* runHealthReporter({
        topic: "s/b/$gateway/main/health",
        intervalMs: 60_000,
        online: Effect.sync(() => `{"n":${++renders}}`)
      }).pipe(Effect.provide(layer), Effect.forkChild)

      yield* TestClock.adjust("59 seconds")
      expect(messages).toEqual([])
      // 59 s + 121 s = 3 minutes: refreshes at 1, 2 and 3 minutes.
      yield* TestClock.adjust("121 seconds")
      yield* Fiber.interrupt(fiber)
      expect(messages).toEqual([
        { topic: "s/b/$gateway/main/health", payload: '{"n":1}', retain: true },
        { topic: "s/b/$gateway/main/health", payload: '{"n":2}', retain: true },
        { topic: "s/b/$gateway/main/health", payload: '{"n":3}', retain: true }
      ])
    })
  )

  it.effect("publishes soon after a device's status changes, not only every interval", () =>
    Effect.gen(function* () {
      const { messages, layer } = yield* makeMemoryPublisher
      const registry = makeHealthRegistry(["meter", "heat-pump"])
      const fiber = yield* runHealthReporter({
        topic: "t",
        intervalMs: 60_000,
        online: Effect.sync(() => onlinePayload(registry, 0, 0)),
        registry
      }).pipe(Effect.provide(layer), Effect.forkChild)
      const payloads = () => messages.map((message): unknown => JSON.parse(message.payload))

      yield* TestClock.adjust("5 seconds")
      expect(messages).toEqual([])
      registry.recordSuccess("meter", 1)
      // A read that keeps the status is not a change.
      yield* TestClock.adjust("2 seconds")
      registry.recordSuccess("meter", 2)
      registry.recordSuccess("heat-pump", 2)
      yield* TestClock.adjust("2 seconds")
      expect(payloads()).toMatchObject([
        { devices: { meter: { status: "ok" }, "heat-pump": { status: "starting" } } },
        { devices: { meter: { status: "ok" }, "heat-pump": { status: "ok" } } }
      ])
      expect(messages.every((message) => message.retain)).toBe(true)

      // The heartbeat goes on as before, at 60 s.
      yield* TestClock.adjust("51 seconds")
      yield* Fiber.interrupt(fiber)
      expect(messages).toHaveLength(3)
    })
  )

  it.effect("coalesces a flapping device into one publish per window", () =>
    Effect.gen(function* () {
      const { messages, layer } = yield* makeMemoryPublisher
      const registry = makeHealthRegistry(["meter"])
      const fiber = yield* runHealthReporter({
        topic: "t",
        intervalMs: 60_000,
        online: Effect.sync(() => onlinePayload(registry, 0, 0)),
        registry
      }).pipe(Effect.provide(layer), Effect.forkChild)

      // Ten seconds of a status change every 10 ms: 1000 changes.
      for (let tick = 0; tick < 1_000; tick++) {
        if (tick % 2 === 0) registry.recordSuccess("meter", tick)
        else registry.recordFailure("meter", fail("timeout"))
        yield* TestClock.adjust("10 millis")
      }
      // At most one change-driven publish per second.
      expect(messages.length).toBeGreaterThanOrEqual(9)
      expect(messages.length).toBeLessThanOrEqual(10)
      // Once the device settles, the last message has its final status.
      registry.recordSuccess("meter", 2_000)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)
      expect(JSON.parse(messages.at(-1)?.payload ?? "{}").devices.meter.status).toBe("ok")
    })
  )

  it.effect("counts a failed refresh and keeps going", () =>
    Effect.gen(function* () {
      let attempts = 0
      const failing = Layer.succeed(Publisher, {
        publish: (topic) =>
          Effect.suspend(() => {
            attempts++
            return Effect.fail(new PublishError({ topic, reason: "unavailable", message: "broker down" }))
          })
      })
      const fiber = yield* runHealthReporter({ topic: "t", intervalMs: 1000, online: Effect.succeed("{}") }).pipe(
        Effect.provide(failing),
        Effect.forkChild
      )
      yield* TestClock.adjust("3 seconds")
      yield* Fiber.interrupt(fiber)

      expect(attempts).toBe(3)
      const failures = yield* Metric.value(Metric.withAttributes(publishFailures, { test: "health-reporter" }))
      expect(failures.count).toBe(3)
    }).pipe(withMetricAttributes({ test: "health-reporter" }))
  )

  it.effect("logs when refreshes start failing and when they recover, not every interval", () =>
    Effect.gen(function* () {
      let down = true
      const lines: Array<string> = []
      const logger = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          lines.push(`${logLevel}: ${(Array.isArray(message) ? message : [message]).join(" ")}`)
        })
      ])
      const flaky = Layer.succeed(Publisher, {
        publish: (topic) =>
          Effect.suspend(() =>
            down ? Effect.fail(new PublishError({ topic, reason: "unavailable", message: "broker down" })) : Effect.void
          )
      })
      const fiber = yield* runHealthReporter({ topic: "t", intervalMs: 1000, online: Effect.succeed("{}") }).pipe(
        Effect.provide([flaky, logger]),
        Effect.forkChild
      )
      yield* TestClock.adjust("10 seconds")
      down = false
      yield* TestClock.adjust("10 seconds")
      down = true
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)

      expect(lines).toEqual([
        "Warn: health publish failed",
        "Info: health publish recovered",
        "Warn: health publish failed"
      ])
    })
  )
})
