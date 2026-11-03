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

describe("HealthRegistry", () => {
  it("starts every device as starting, then tracks the last cycle", () => {
    const registry = makeHealthRegistry(["ahu-1", "meter"])
    expect(Object.fromEntries(registry.devices)).toEqual({
      "ahu-1": { status: "starting" },
      meter: { status: "starting" }
    })

    registry.recordSuccess("meter", 1000)
    registry.recordFailure("meter", "timeout")
    registry.recordFailure("ahu-1", "connection")
    expect(registry.devices.get("meter")).toEqual({ status: "failing", reason: "timeout", lastSuccess: 1000 })
    expect(registry.devices.get("ahu-1")).toEqual({ status: "failing", reason: "connection" })

    registry.recordSuccess("meter", 2000)
    expect(registry.devices.get("meter")).toEqual({ status: "ok", lastSuccess: 2000 })
  })
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
