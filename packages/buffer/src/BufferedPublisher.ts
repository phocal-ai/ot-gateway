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
 * - Past `maxRows` the oldest rows are dropped and counted, except rows the
 *   drainer is delivering right now, which would arrive anyway.
 * - A row that does not decode is dropped and counted, so it cannot stop
 *   forwarding either.
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
import { Clock, type Duration, Effect, FileSystem, Latch, Layer, Metric, Path, Result, Semaphore } from "effect"
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

  // `pending` mirrors the row count. Every change to the table and to `pending`
  // happens under `bookkeeping`, as a delta of what the statement reported, and
  // it is re-read from the table whenever the drainer sees the end of it.
  const bookkeeping = yield* Semaphore.make(1)
  let pending = yield* outbox.count
  // Rows up to this id are being delivered; overflow leaves them alone.
  let inFlightThrough = 0
  const hasRows = yield* Latch.make(pending > 0)
  yield* Metric.update(bufferRows, pending)
  if (pending > 0)
    yield* Effect.logInfo("buffered messages waiting from a previous run").pipe(Effect.annotateLogs({ rows: pending }))

  const setPending = Effect.fnUntraced(function* (rows: number) {
    pending = Math.max(0, rows)
    yield* Metric.update(bufferRows, pending)
    if (pending > 0) yield* Latch.open(hasRows)
    else yield* Latch.close(hasRows)
  })

  const store = Effect.fnUntraced(function* (topic: string, payload: string, qos: 0 | 1) {
    yield* outbox.append(topic, payload, qos, yield* Clock.currentTimeMillis)
    yield* Metric.update(bufferWritten, 1)
    yield* setPending(pending + 1)
    if (pending > settings.maxRows) {
      const dropped = yield* outbox.dropOldest(pending - settings.maxRows, inFlightThrough)
      yield* setPending(pending - dropped)
      yield* Metric.update(Metric.withAttributes(bufferDropped, { reason: "overflow" }), dropped)
    }
  }, Semaphore.withPermit(bookkeeping))

  const deliver = (row: OutboxRow): Effect.Effect<Delivery> =>
    inner.publish(row.topic, row.payload, { qos: row.qos }).pipe(
      Effect.as<Delivery>({ id: row.id, outcome: "delivered" }),
      Effect.catchTag("PublishError", (error) => Effect.succeed<Delivery>({ id: row.id, outcome: error.reason }))
    )

  /** Remove `ids` and count them as `reason`; returns how many were still there. */
  const removeRows = Effect.fnUntraced(function* (
    ids: ReadonlyArray<number>,
    reason: "delivered" | "rejected" | "unreadable"
  ) {
    const removed = yield* outbox.remove(ids)
    yield* setPending(pending - removed)
    if (reason === "delivered") yield* Metric.update(bufferDrained, removed)
    else yield* Metric.update(Metric.withAttributes(bufferDropped, { reason }), removed)
    return removed
  })

  /** Deliver the oldest batch. Returns whether the broker was reachable for all of it. */
  const drainStep = Effect.gen(function* () {
    const batch = yield* Semaphore.withPermit(
      bookkeeping,
      Effect.gen(function* () {
        const read = yield* outbox.oldest(batchSize)
        // The end of the table is in this batch: true up the count, cheaply, since few rows are left.
        if (read.rows.length + read.unreadable.length < batchSize) yield* setPending(yield* outbox.count)
        const last = read.rows.at(-1)
        if (last !== undefined) inFlightThrough = last.id
        if (read.unreadable.length > 0) {
          const dropped = yield* removeRows(read.unreadable, "unreadable")
          yield* Effect.logError("buffer held unreadable rows, dropped them").pipe(
            Effect.annotateLogs({ count: dropped })
          )
        }
        return read.rows
      })
    )
    if (batch.length === 0) return true
    const deliveries = yield* Effect.forEach(batch, deliver, { concurrency: drainConcurrency })
    const done = (outcome: Delivery["outcome"]) => deliveries.filter((d) => d.outcome === outcome).map((d) => d.id)
    const rejected = yield* Semaphore.withPermit(
      bookkeeping,
      Effect.gen(function* () {
        inFlightThrough = 0
        yield* removeRows(done("delivered"), "delivered")
        return yield* removeRows(done("rejected"), "rejected")
      })
    )
    if (rejected > 0) {
      yield* Effect.logWarning("broker rejected buffered messages, dropped them").pipe(
        Effect.annotateLogs({ count: rejected })
      )
    }
    return deliveries.every((d) => d.outcome !== "unavailable")
  })

  const drainer = Effect.gen(function* () {
    while (true) {
      yield* hasRows.await
      const reachable = yield* drainStep.pipe(
        Effect.catchTags({
          SqlError: (error) =>
            Effect.logError("buffer read failed").pipe(Effect.annotateLogs({ error: error.message }), Effect.as(false)),
          // Only the ids returned by a delete are decoded here; a failure means SQLite answered nonsense.
          SchemaError: (error) =>
            Effect.logError("buffer returned an unexpected result").pipe(
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
