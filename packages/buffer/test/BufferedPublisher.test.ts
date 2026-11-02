/**
 * Store-and-forward against a controllable inner publisher, on a real SQLite
 * file in a temporary directory.
 */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import {
  bufferDrained,
  bufferDropped,
  bufferRows,
  bufferWritten,
  Publisher,
  PublishError,
  withMetricAttributes
} from "@plenum/core"
import { Context, Effect, Exit, FileSystem, Layer, Metric, Scope } from "effect"
import { BufferedPublisher } from "../src/index.ts"

/** A broker stand-in: up or down, optionally refusing one topic. */
const makeBroker = () => {
  const state = { up: true, rejectTopic: undefined as string | undefined, delivered: [] as Array<string> }
  const layer = Layer.succeed(Publisher, {
    publish: (topic, payload) =>
      Effect.suspend(() => {
        if (!state.up) return Effect.fail(new PublishError({ topic, reason: "unavailable", message: "broker down" }))
        if (topic === state.rejectTopic) {
          return Effect.fail(new PublishError({ topic, reason: "rejected", message: "not authorized" }))
        }
        state.delivered.push(payload)
        return Effect.void
      })
  })
  return { state, layer }
}

/** A buffered publisher over `broker`, in `scope`, on `path`. */
const openBuffer = (path: string, broker: ReturnType<typeof makeBroker>, scope: Scope.Scope, maxRows = 1000) =>
  BufferedPublisher({ path, maxRows }, { retryDelay: "20 millis" }).pipe(
    Layer.provide(broker.layer),
    Layer.provide(NodeServices.layer),
    (layer) => Layer.buildWithScope(layer, scope),
    Effect.map((context) => Context.get(context, Publisher))
  )

const tempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "plenum-buffer-" })
  // A subdirectory that does not exist yet, to check it is created.
  return `${directory}/nested/buffer.sqlite`
}).pipe(Effect.provide(NodeServices.layer))

/** Poll until `condition` holds, failing the test after `timeoutMs`. */
const eventually = (condition: () => boolean, timeoutMs = 3000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("condition not met in time"))
      yield* Effect.sleep("10 millis")
    }
  })

const counter = (metric: Metric.Counter<number>, attributes: Record<string, string>) =>
  Effect.map(Metric.value(Metric.withAttributes(metric, attributes)), (state) => state.count)

describe("BufferedPublisher", () => {
  it.live("passes values through while the broker is up", () =>
    Effect.gen(function* () {
      const broker = makeBroker()
      const publisher = yield* openBuffer(yield* tempDatabase, broker, yield* Effect.scope)
      yield* publisher.publish("t", "1")
      expect(broker.state.delivered).toEqual(["1"])
      expect(yield* counter(bufferWritten, { test: "through" })).toBe(0)
    }).pipe(withMetricAttributes({ test: "through" }))
  )

  it.live("stores values while the broker is down and delivers them in order once it is back", () =>
    Effect.gen(function* () {
      const broker = makeBroker()
      const publisher = yield* openBuffer(yield* tempDatabase, broker, yield* Effect.scope)

      broker.state.up = false
      yield* publisher.publish("t", "1")
      yield* publisher.publish("t", "2")
      const rows = yield* Metric.value(Metric.withAttributes(bufferRows, { test: "outage" }))
      expect(rows.value).toBe(2)

      broker.state.up = true
      // Queued behind the stored values, even though the broker is up again.
      yield* publisher.publish("t", "3")
      yield* eventually(() => broker.state.delivered.length === 3)
      expect(broker.state.delivered).toEqual(["1", "2", "3"])
      expect(yield* counter(bufferWritten, { test: "outage" })).toBe(3)
      expect(yield* counter(bufferDrained, { test: "outage" })).toBe(3)
      const after = yield* Metric.value(Metric.withAttributes(bufferRows, { test: "outage" }))
      expect(after.value).toBe(0)
    }).pipe(withMetricAttributes({ test: "outage" }))
  )

  it.live("does not buffer retained messages or messages the broker rejects", () =>
    Effect.gen(function* () {
      const broker = makeBroker()
      const publisher = yield* openBuffer(yield* tempDatabase, broker, yield* Effect.scope)

      broker.state.rejectTopic = "forbidden"
      const rejected = yield* Effect.flip(publisher.publish("forbidden", "x"))
      expect(rejected.reason).toBe("rejected")

      broker.state.up = false
      const retained = yield* Effect.flip(publisher.publish("s/b/d/p/$meta", "{}", { retain: true }))
      expect(retained.reason).toBe("unavailable")
      expect(yield* counter(bufferWritten, { test: "not-buffered" })).toBe(0)
    }).pipe(withMetricAttributes({ test: "not-buffered" }))
  )

  it.live("drops a stored message the broker rejects instead of blocking the queue", () =>
    Effect.gen(function* () {
      const broker = makeBroker()
      const publisher = yield* openBuffer(yield* tempDatabase, broker, yield* Effect.scope)

      broker.state.up = false
      yield* publisher.publish("ok", "1")
      yield* publisher.publish("forbidden", "2")
      yield* publisher.publish("ok", "3")
      broker.state.rejectTopic = "forbidden"
      broker.state.up = true

      yield* eventually(() => broker.state.delivered.length === 2)
      expect(broker.state.delivered).toEqual(["1", "3"])
      expect(yield* counter(bufferDropped, { test: "poison", reason: "rejected" })).toBe(1)
    }).pipe(withMetricAttributes({ test: "poison" }))
  )

  it.live("drops the oldest rows past maxRows", () =>
    Effect.gen(function* () {
      const broker = makeBroker()
      const publisher = yield* openBuffer(yield* tempDatabase, broker, yield* Effect.scope, 3)

      broker.state.up = false
      yield* Effect.forEach(["1", "2", "3", "4", "5"], (value) => publisher.publish("t", value), { discard: true })
      expect(yield* counter(bufferDropped, { test: "overflow", reason: "overflow" })).toBe(2)

      broker.state.up = true
      yield* eventually(() => broker.state.delivered.length === 3)
      expect(broker.state.delivered).toEqual(["3", "4", "5"])
    }).pipe(withMetricAttributes({ test: "overflow" }))
  )

  it.live("keeps stored values across a restart", () =>
    Effect.gen(function* () {
      const path = yield* tempDatabase
      const first = makeBroker()
      first.state.up = false
      const firstScope = yield* Scope.make()
      const before = yield* openBuffer(path, first, firstScope)
      yield* before.publish("t", "1")
      yield* before.publish("t", "2")
      yield* Scope.close(firstScope, Exit.void)

      const second = makeBroker()
      yield* openBuffer(path, second, yield* Effect.scope)
      yield* eventually(() => second.state.delivered.length === 2)
      expect(second.state.delivered).toEqual(["1", "2"])
    })
  )
})
