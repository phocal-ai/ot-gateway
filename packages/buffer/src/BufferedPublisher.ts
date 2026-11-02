/**
 * Store-and-forward (VISION.md, "Northbound"): a `Publisher` that wraps the
 * real one and keeps values in a SQLite outbox while the broker is
 * unavailable, then delivers them once it is back. The outbox survives a
 * gateway restart.
 *
 * - Only values are buffered. Retained messages (`$meta`, health) pass
 *   straight through: the pipeline retries `$meta` and the MQTT publisher
 *   replays retained state after a reconnect.
 * - Once anything is waiting, new values queue behind it, so delivery keeps
 *   the order values were read in. The drainer pipelines up to 16 messages
 *   at a time for throughput; every message carries its own `ts`.
 * - `unavailable` failures are stored; `rejected` ones (too large, not
 *   authorized) are not, because retrying them cannot help. A rejected
 *   message already in the outbox is dropped and counted, so it never blocks
 *   the queue.
 * - Past `maxRows` the oldest rows are dropped and counted.
 */
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import {
  type BufferSettings,
  bufferDrained,
  bufferDropped,
  bufferRows,
  bufferWritten,
  Publisher,
  PublishError
} from "@plenum/core"
import { Clock, type Duration, Effect, FileSystem, Latch, Layer, Metric, Path, Result } from "effect"
import { makeOutbox, outboxMigrations } from "./Outbox.ts"
import type { OutboxRow } from "./Outbox.ts"

export interface BufferedPublisherOptions {
  /** Rows read and delivered per drain step (default 100). */
  readonly batchSize?: number
  /** Pause after a drain step that could not reach the broker (default 5 s). */
  readonly retryDelay?: Duration.Input
}

/** Messages delivered concurrently while draining; bounded by the broker's Receive Maximum anyway. */
const drainConcurrency = 16

type Delivery = { readonly id: number; readonly outcome: "delivered" | "unavailable" | "rejected" }

const makeBufferedPublisher = Effect.fnUntraced(function* (
  settings: BufferSettings,
  options: BufferedPublisherOptions
) {
  const inner = yield* Publisher
  const outbox = yield* makeOutbox
  const batchSize = options.batchSize ?? 100
  const retryDelay = options.retryDelay ?? "5 seconds"

  // `pending` mirrors the row count. Deletes report what they removed, so it stays exact.
  let pending = yield* outbox.count
  const hasRows = yield* Latch.make(pending > 0)
  yield* Metric.update(bufferRows, pending)
  if (pending > 0)
    yield* Effect.logInfo("buffered messages waiting from a previous run").pipe(Effect.annotateLogs({ rows: pending }))

  const setPending = Effect.fnUntraced(function* (rows: number) {
    pending = rows
    yield* Metric.update(bufferRows, rows)
    if (rows > 0) yield* Latch.open(hasRows)
    else yield* Latch.close(hasRows)
  })

  const store = Effect.fnUntraced(function* (topic: string, payload: string, qos: 0 | 1) {
    yield* outbox.append(topic, payload, qos, yield* Clock.currentTimeMillis)
    yield* Metric.update(bufferWritten, 1)
    let rows = pending + 1
    if (rows > settings.maxRows) {
      const dropped = yield* outbox.dropOldest(rows - settings.maxRows)
      rows -= dropped
      yield* Metric.update(Metric.withAttributes(bufferDropped, { reason: "overflow" }), dropped)
    }
    yield* setPending(rows)
  })

  const deliver = (row: OutboxRow): Effect.Effect<Delivery> =>
    inner.publish(row.topic, row.payload, { qos: row.qos }).pipe(
      Effect.as<Delivery>({ id: row.id, outcome: "delivered" }),
      Effect.catchTag("PublishError", (error) => Effect.succeed<Delivery>({ id: row.id, outcome: error.reason }))
    )

  /** Deliver the oldest batch. Returns whether the broker was reachable for all of it. */
  const drainStep = Effect.gen(function* () {
    const rows = yield* outbox.oldest(batchSize)
    if (rows.length === 0) {
      yield* setPending(0)
      return true
    }
    const deliveries = yield* Effect.forEach(rows, deliver, { concurrency: drainConcurrency })
    const delivered = deliveries.filter((d) => d.outcome === "delivered")
    const rejected = deliveries.filter((d) => d.outcome === "rejected")
    const removed = yield* outbox.remove([...delivered, ...rejected].map((d) => d.id))
    yield* Metric.update(bufferDrained, delivered.length)
    if (rejected.length > 0) {
      yield* Metric.update(Metric.withAttributes(bufferDropped, { reason: "rejected" }), rejected.length)
      yield* Effect.logWarning("broker rejected buffered messages, dropped them").pipe(
        Effect.annotateLogs({ count: rejected.length })
      )
    }
    yield* setPending(Math.max(0, pending - removed))
    return deliveries.every((d) => d.outcome !== "unavailable")
  })

  const drainer = Effect.gen(function* () {
    while (true) {
      yield* hasRows.await
      const reachable = yield* drainStep.pipe(
        Effect.catchTags({
          SqlError: (error) =>
            Effect.logError("buffer read failed").pipe(Effect.annotateLogs({ error: error.message }), Effect.as(false)),
          SchemaError: (error) =>
            Effect.logError("buffer holds an unreadable row").pipe(
              Effect.annotateLogs({ error: error.message }),
              Effect.as(false)
            )
        })
      )
      if (!reachable) yield* Effect.sleep(retryDelay)
      else if (pending === 0) yield* Effect.logInfo("buffer drained")
    }
  })
  yield* Effect.forkScoped(drainer)

  /** Publish now, or store if the broker is unavailable or older messages are still waiting. */
  const publishOrStore = Effect.fnUntraced(function* (topic: string, payload: string, qos: 0 | 1) {
    // Behind waiting messages, so order is kept.
    if (pending > 0) return yield* store(topic, payload, qos)
    const sent = yield* Effect.result(inner.publish(topic, payload, { qos }))
    if (Result.isSuccess(sent)) return
    if (sent.failure.reason === "rejected") return yield* sent.failure
    yield* store(topic, payload, qos)
  })

  return Publisher.of({
    publish: (topic, payload, publishOptions) => {
      const qos = publishOptions?.qos
      // Retained state is restored by the pipeline and the MQTT publisher; QoS 2 is refused downstream.
      if (publishOptions?.retain === true || qos === 2) return inner.publish(topic, payload, publishOptions)
      const bufferFailed = (message: string) =>
        Effect.fail(new PublishError({ topic, reason: "unavailable", message: `buffer write failed: ${message}` }))
      return publishOrStore(topic, payload, qos === 0 ? 0 : 1).pipe(
        Effect.catchTags({
          SqlError: (error) => bufferFailed(error.message),
          SchemaError: (error) => bufferFailed(error.message)
        })
      )
    }
  })
})

/**
 * Wrap the provided `Publisher` with a SQLite outbox at `settings.path`
 * (its directory is created if missing).
 */
export const BufferedPublisher = (settings: BufferSettings, options: BufferedPublisherOptions = {}) => {
  const database = SqliteMigrator.layer({ loader: outboxMigrations }).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: settings.path })),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          yield* fs.makeDirectory(path.dirname(settings.path), { recursive: true })
        })
      )
    )
  )
  return Layer.effect(Publisher, makeBufferedPublisher(settings, options)).pipe(Layer.provide(database))
}
