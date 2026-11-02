/**
 * The buffer under faults found by the chaos run: a poison message, transient
 * broker refusals, withheld acknowledgements, shutdown mid-drain, a full or
 * locked disk, a corrupt, unopenable or deleted file. Each test asserts the
 * fixed behaviour. The outbox file is locked while open, so tests inject
 * faults into it (triggers) between runs and observe it through metrics.
 */
import { NodeServices, NodeSocketServer } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import {
  bufferBypassed,
  bufferDisabled,
  bufferDrained,
  bufferDropped,
  bufferFailures,
  bufferRows,
  Publisher,
  PublishError,
  withMetricAttributes
} from "@plenum/core"
import { makeBrokerControl, MqttPublisher, serveMqtt } from "@plenum/mqtt"
import type { BrokerControl } from "@plenum/mqtt"
import { Context, Effect, Exit, FileSystem, Layer, Metric, Scope } from "effect"
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { BufferedPublisher } from "../../src/index.ts"

const tempDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "plenum-buffer-chaos-" })
}).pipe(Effect.provide(NodeServices.layer))

/** A broker stand-in whose behaviour each test scripts. */
const makeInner = () => {
  const state = {
    up: true,
    delivered: [] as Array<string>,
    /** Per payload: fail after it went out, as a broken connection or a withheld PUBACK does. */
    loseInFlight: (_payload: string): boolean => false,
    delay: "0 millis" as `${number} millis`
  }
  const publisher: Publisher["Service"] = {
    publish: (topic, payload) =>
      Effect.gen(function* () {
        if (!state.up) return yield* new PublishError({ topic, reason: "unavailable", message: "broker down" })
        yield* Effect.sleep(state.delay)
        if (state.loseInFlight(payload)) {
          return yield* new PublishError({ topic, reason: "unavailable", message: "no PUBACK", inFlight: true })
        }
        state.delivered.push(payload)
      })
  }
  return { state, publisher }
}

const openBufferOn = (path: string, inner: Layer.Layer<Publisher>, scope: Scope.Scope) =>
  BufferedPublisher({ path, maxRows: 1_000_000 }, { retryDelay: "50 millis", checkInterval: "100 millis" }).pipe(
    Layer.provide(inner),
    Layer.provide(NodeServices.layer),
    (layer) => Layer.buildWithScope(layer, scope),
    Effect.map((context) => Context.get(context, Publisher))
  )

const openBuffer = (path: string, inner: Publisher["Service"], scope: Scope.Scope) =>
  openBufferOn(path, Layer.succeed(Publisher, inner), scope)

/** The test broker on a free port, and a real MQTT publisher for it (as the gateway sets it up with a buffer). */
const startBroker = (control: BrokerControl) =>
  Effect.gen(function* () {
    const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
    yield* serveMqtt(server, control).pipe(Effect.forkScoped)
    const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port
    return MqttPublisher(
      { url: `mqtt://127.0.0.1:${port}`, clientId: "chaos-buffer" },
      {
        waitForConnection: false,
        publishTimeout: "300 millis",
        connectTimeout: "1 second",
        reconnectDelay: { initial: "20 millis", max: "100 millis" }
      }
    ).pipe(Layer.orDie)
  })

const eventually = (condition: () => boolean, timeoutMs = 5000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("condition not met in time"))
      yield* Effect.sleep("10 millis")
    }
  })

const counter = (metric: Metric.Counter<number>, attributes: Record<string, string>) =>
  Effect.map(Metric.value(Metric.withAttributes(metric, attributes)), (state) => state.count)
const gauge = (metric: Metric.Gauge<number>, attributes: Record<string, string>) =>
  Effect.map(Metric.value(Metric.withAttributes(metric, attributes)), (state) => state.value)

/** Run SQL on the closed outbox file, e.g. to install a fault trigger. */
const onFile = (path: string, statement: string) => {
  const db = new DatabaseSync(path)
  try {
    db.exec(statement)
  } finally {
    db.close()
  }
}
const rowsInFile = (path: string) => {
  const db = new DatabaseSync(path)
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM outbox").get()?.n)
  } finally {
    db.close()
  }
}

const range = (count: number) => Array.from({ length: count }, (_, i) => String(i))

/** Fill an outbox at `path` with `values` while the broker is down, then close it. */
const fill = (path: string, values: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const down = makeInner()
    down.state.up = false
    const scope = yield* Scope.make()
    const publisher = yield* openBuffer(path, down.publisher, scope)
    yield* Effect.forEach(values, (value) => publisher.publish("s/b/d/p", value), { discard: true })
    yield* Scope.close(scope, Exit.void)
  })

describe("chaos: buffer", () => {
  it.live("drops a poison row that makes the broker disconnect, and delivers everything else", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      // Down at first, so everything is buffered; then up, with a size limit it never announces.
      control.connackReason = 0x88
      control.dropPacketsOver = 1000
      const broker = yield* startBroker(control)
      const path = `${yield* tempDirectory}/buffer.sqlite`
      const publisher = yield* openBufferOn(path, broker, yield* Effect.scope)
      yield* Effect.sleep("100 millis")
      yield* publisher.publish("s/b/d/p", "0")
      yield* publisher.publish("s/b/d/big", "x".repeat(2000))
      yield* Effect.forEach(range(10), (i) => publisher.publish("s/b/d/p", String(Number(i) + 1)), { discard: true })
      expect(yield* gauge(bufferRows, { test: "poison" })).toBe(12)

      const refusedConnects = control.connects.length
      control.connackReason = 0
      yield* eventually(() => control.messages.length === 11)
      expect(control.messages.map((message) => message.payload)).toEqual(range(11))
      expect(yield* counter(bufferDropped, { test: "poison", reason: "undeliverable" })).toBe(1)
      expect(yield* gauge(bufferRows, { test: "poison" })).toBe(0)
      // Three attempts broke three connections, then the storm stopped.
      expect(control.connects.length - refusedConnects).toBeLessThanOrEqual(5)
    }).pipe(withMetricAttributes({ test: "poison" }))
  )

  it.live("keeps rows the broker refuses for now (PUBACK 0x97 quota exceeded) and delivers them later", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      control.connackReason = 0x88
      const broker = yield* startBroker(control)
      const path = `${yield* tempDirectory}/buffer.sqlite`
      const publisher = yield* openBufferOn(path, broker, yield* Effect.scope)
      yield* Effect.sleep("100 millis")
      yield* Effect.forEach(range(50), (value) => publisher.publish("s/b/d/p", value), { discard: true })

      control.pubackReason = 0x97
      control.connackReason = 0
      yield* Effect.sleep("400 millis")
      expect(control.messages).toEqual([])
      control.pubackReason = 0
      yield* eventually(() => control.messages.length === 50)
      expect(control.messages.map((message) => message.payload)).toEqual(range(50))
      expect(yield* counter(bufferDropped, { test: "quota", reason: "rejected" })).toBe(0)
    }).pipe(withMetricAttributes({ test: "quota" }))
  )

  it.live("stops a drain batch at the first failure instead of sending the rest past it", () =>
    Effect.gen(function* () {
      const path = `${yield* tempDirectory}/buffer.sqlite`
      yield* fill(path, range(60))
      const inner = makeInner()
      inner.state.delay = "5 millis"
      let withheld = false
      inner.state.loseInFlight = (payload) => {
        if (payload !== "3" || withheld) return false
        withheld = true
        return true
      }
      yield* openBuffer(path, inner.publisher, yield* Effect.scope)
      yield* eventually(() => inner.state.delivered.length === 60)

      const delivered = inner.state.delivered
      expect(new Set(delivered).size).toBe(60)
      // "3" comes again right after the rows that were already on their way, not after the whole batch.
      expect(delivered.indexOf("3")).toBeLessThanOrEqual(3 + 16)
      expect(yield* counter(bufferDropped, { test: "withheld", reason: "undeliverable" })).toBe(0)
    }).pipe(withMetricAttributes({ test: "withheld" }))
  )

  it.live("removes rows as they are delivered, so a shutdown mid-drain resends only a few", () =>
    Effect.gen(function* () {
      const path = `${yield* tempDirectory}/buffer.sqlite`
      yield* fill(path, range(300))
      const inner = makeInner()
      inner.state.delay = "5 millis"
      const scope = yield* Scope.make()
      yield* openBuffer(path, inner.publisher, scope)
      yield* eventually(() => inner.state.delivered.length >= 30)
      yield* Scope.close(scope, Exit.void)

      yield* openBuffer(path, inner.publisher, yield* Effect.scope)
      yield* eventually(() => new Set(inner.state.delivered).size === 300)
      yield* Effect.sleep("100 millis")
      const duplicates = inner.state.delivered.length - 300
      expect(duplicates).toBeLessThanOrEqual(16)
    })
  )

  it.live("delivers each row once when deletes fail (disk full), and publishes new values directly", () =>
    Effect.gen(function* () {
      const path = `${yield* tempDirectory}/buffer.sqlite`
      yield* fill(path, range(342))
      onFile(
        path,
        "CREATE TRIGGER full_disk BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;"
      )
      const inner = makeInner()
      const publisher = yield* openBuffer(path, inner.publisher, yield* Effect.scope)
      yield* eventually(() => inner.state.delivered.length === 342)
      yield* Effect.sleep("300 millis")
      // Not resent although they are still in the file.
      expect(inner.state.delivered.length).toBe(342)
      expect(yield* gauge(bufferRows, { test: "delete-fails" })).toBe(0)
      expect(yield* counter(bufferDrained, { test: "delete-fails" })).toBe(342)
      expect(yield* counter(bufferFailures, { test: "delete-fails", operation: "delete" })).toBeGreaterThan(0)

      yield* publisher.publish("s/b/d/p", "live")
      expect(inner.state.delivered.at(-1)).toBe("live")
    }).pipe(withMetricAttributes({ test: "delete-fails" }))
  )

  it.live("publishes directly when the outbox cannot store while older rows wait (disk full)", () =>
    Effect.gen(function* () {
      const path = `${yield* tempDirectory}/buffer.sqlite`
      yield* fill(path, range(400))
      onFile(
        path,
        "CREATE TRIGGER full_disk BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;"
      )
      const inner = makeInner()
      inner.state.delay = "5 millis"
      const publisher = yield* openBuffer(path, inner.publisher, yield* Effect.scope)
      yield* Effect.forEach(range(10), (i) => publisher.publish("s/b/d/p", `live${i}`), { discard: true })
      expect(inner.state.delivered.filter((value) => value.startsWith("live"))).toHaveLength(10)
      expect(yield* counter(bufferBypassed, { test: "insert-fails" })).toBe(10)
      expect(yield* counter(bufferFailures, { test: "insert-fails", operation: "insert" })).toBe(10)
      yield* eventually(() => inner.state.delivered.length === 410)

      // With the broker down too, the value is lost and the caller is told.
      inner.state.up = false
      const error = yield* Effect.flip(publisher.publish("s/b/d/p", "lost"))
      expect(error.reason).toBe("unavailable")
    }).pipe(withMetricAttributes({ test: "insert-fails" }))
  )

  it.live("moves a corrupt file aside and buffers in a fresh one", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      const path = `${directory}/buffer.sqlite`
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFile(path, new Uint8Array(8192).fill(0x41))
      const inner = makeInner()
      inner.state.up = false
      const publisher = yield* openBuffer(path, inner.publisher, yield* Effect.scope)
      expect(readdirSync(directory).some((name) => name.startsWith("buffer.sqlite.corrupt-"))).toBe(true)
      yield* publisher.publish("s/b/d/p", "1")
      expect(yield* gauge(bufferRows, { test: "corrupt" })).toBe(1)
      expect(yield* gauge(bufferDisabled, { test: "corrupt" })).toBe(0)
    }).pipe(withMetricAttributes({ test: "corrupt" }), Effect.provide(NodeServices.layer))
  )

  it.live("runs unbuffered when no file can be opened, and says so", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      chmodSync(directory, 0o555)
      yield* Effect.addFinalizer(() => Effect.sync(() => chmodSync(directory, 0o755)))
      const inner = makeInner()
      const publisher = yield* openBuffer(`${directory}/sub/buffer.sqlite`, inner.publisher, yield* Effect.scope)
      expect(yield* gauge(bufferDisabled, { test: "unopenable" })).toBe(1)
      expect(yield* counter(bufferFailures, { test: "unopenable", operation: "open" })).toBeGreaterThan(0)
      yield* publisher.publish("s/b/d/p", "1")
      expect(inner.state.delivered).toEqual(["1"])

      // Once the directory is writable again, the next check opens the file.
      chmodSync(directory, 0o755)
      yield* eventually(() => existsSync(`${directory}/sub/buffer.sqlite`))
      yield* Effect.sleep("50 millis")
      expect(yield* gauge(bufferDisabled, { test: "unopenable" })).toBe(0)
    }).pipe(withMetricAttributes({ test: "unopenable" }))
  )

  it.live("refuses to share its file with a second gateway, quickly", () =>
    Effect.gen(function* () {
      const path = `${yield* tempDirectory}/buffer.sqlite`
      yield* openBuffer(path, makeInner().publisher, yield* Effect.scope)
      const started = Date.now()
      const error = yield* Effect.flip(openBuffer(path, makeInner().publisher, yield* Effect.scope))
      expect(error._tag).toBe("BufferLocked")
      // A short busy timeout: node:sqlite blocks the event loop while it waits.
      expect(Date.now() - started).toBeLessThan(1000)
    })
  )

  it.live("restores a file deleted while the gateway runs", () =>
    Effect.gen(function* () {
      const path = `${yield* tempDirectory}/buffer.sqlite`
      const inner = makeInner()
      inner.state.up = false
      const scope = yield* Scope.make()
      const publisher = yield* openBuffer(path, inner.publisher, scope)
      yield* Effect.forEach(range(10), (value) => publisher.publish("s/b/d/p", value), { discard: true })
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true })
      yield* eventually(() => existsSync(path))
      yield* Effect.sleep("100 millis")
      yield* Effect.forEach(range(10), (i) => publisher.publish("s/b/d/p", String(10 + Number(i))), { discard: true })
      yield* Scope.close(scope, Exit.void)
      expect(rowsInFile(path)).toBe(20)
    })
  )

  it.live("gives the space back once an outage is drained", () =>
    Effect.gen(function* () {
      const path = `${yield* tempDirectory}/buffer.sqlite`
      yield* fill(
        path,
        range(3000).map((i) => `${i}:${"x".repeat(500)}`)
      )
      const full = statSync(path).size
      const inner = makeInner()
      const scope = yield* Scope.make()
      yield* openBuffer(path, inner.publisher, scope)
      yield* eventually(() => inner.state.delivered.length === 3000)
      yield* Effect.sleep("100 millis")
      yield* Scope.close(scope, Exit.void)
      expect(statSync(path).size).toBeLessThan(full / 4)
    })
  )
})
