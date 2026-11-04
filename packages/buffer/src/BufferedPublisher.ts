/**
 * Store-and-forward (VISION.md, "Northbound"): a `Publisher` that wraps the
 * real one and keeps values in a SQLite outbox while the broker is
 * unavailable, then delivers them once it is back. The outbox survives a
 * gateway restart.
 *
 * - Only values are buffered. Retained messages (`$meta`, health) pass
 *   straight through: the pipeline retries `$meta` and the MQTT publisher
 *   replays retained state after a reconnect. So do transient ones (command
 *   results), which would mislead if delivered late.
 * - Once anything is waiting, new values queue behind it, so delivery keeps
 *   the order values were read in. The drainer pipelines up to 16 messages
 *   at a time for throughput, starts no new ones after the first failure,
 *   and removes rows as they are acknowledged, so a shutdown mid-drain
 *   resends at most a handful. A message the broker refuses for now (quota
 *   exceeded) while later ones are already on their way is resent after
 *   them: it arrives at most 15 places late. Every message carries its own `ts`.
 * - `unavailable` failures are stored; `rejected` ones (too large, not
 *   authorized) are not, because retrying them cannot help. A rejected
 *   message already in the outbox is dropped and counted, so it never blocks
 *   the queue.
 * - A row that was in flight when the connection broke is suspect: it is
 *   sent on its own next time, and after three such failures in a row it is
 *   dropped and counted. A message that makes the broker disconnect (too
 *   large for a limit the broker never announced, say) cannot block the
 *   outbox.
 * - Past `maxRows` the oldest rows are dropped and counted, except rows the
 *   drainer is delivering right now, which would arrive anyway.
 * - A row that does not decode is dropped and counted, so it cannot stop
 *   forwarding either.
 * - When the disk is full or the file is locked: delivered rows that cannot
 *   be deleted are remembered and skipped, and a value that cannot be stored
 *   is published directly if the broker takes it. Each failure is counted;
 *   it is logged once when it starts and once when it ends.
 * - An unusable file is moved aside (see `Database.ts`). If no file can be
 *   opened, the gateway runs unbuffered, says so loudly and in
 *   `ot_gateway_buffer_disabled`, and tries again every `checkInterval`. The same
 *   check notices the file being deleted under the running gateway and
 *   restores it from the open connection.
 */
import {
  type BufferSettings,
  bufferBypassed,
  bufferDisabled,
  bufferDrained,
  bufferDropped,
  bufferFailures,
  bufferRows,
  bufferWritten,
  Publisher,
  PublishError
} from "@ot-gateway/core"
import { Clock, type Duration, Effect, Latch, Layer, Metric, Result, Schedule, Semaphore } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { fileIdentity, isCorrupt, openDatabase } from "./Database.ts"
import type { OutboxDatabase } from "./Database.ts"
import type { OutboxRow } from "./Outbox.ts"

export interface BufferedPublisherOptions {
  /** Rows read and delivered per drain step (default 100). */
  readonly batchSize?: number
  /** Pause after a drain step that could not reach the broker (default 5 s). */
  readonly retryDelay?: Duration.Input
  /**
   * How often the file is checked: still there and still the one opened, and
   * delivered rows finally deleted; or, while running unbuffered, opened
   * again (default 30 s).
   */
  readonly checkInterval?: Duration.Input
  /**
   * Opens the outbox file (default `openDatabase`). A simulation wraps the
   * real one to make the disk fill up or lock under a running gateway.
   */
  readonly openDatabase?: typeof openDatabase
}

/** Messages delivered concurrently while draining; bounded by the broker's Receive Maximum anyway. */
const drainConcurrency = 16

/** Deliveries in a row that failed with the row in flight before it is dropped as poison. */
const maxStrikes = 3

/** After a failed insert, values skip the outbox this long, so a locked file does not slow every publish. */
const storeBackoffMillis = 1_000

type DropReason = "rejected" | "unreadable" | "undeliverable" | "lost"
type Operation = "insert" | "delete" | "read" | "open"

/** One open outbox and what the drainer knows about it. Replaced as a whole when the file is reopened. */
interface Store {
  readonly database: OutboxDatabase
  /** Rows waiting for delivery; rows delivered but not yet deleted are not counted. */
  pending: number
  /** Every row up to this id is handled: delivered or dropped. The drainer reads after it. */
  floor: number
  /** Whether rows up to `floor` may still be in the table because a delete failed. */
  floorDirty: boolean
  /** Handled rows above `floor` whose delete failed; skipped until a delete works. */
  readonly stale: Set<number>
  /** Rows up to this id are being delivered; overflow leaves them alone. */
  inFlightThrough: number
  /** The row that was in flight when the connection last broke, and how many times in a row that happened. */
  suspect: { readonly id: number; readonly strikes: number } | undefined
}

const makeStore = (database: OutboxDatabase, pending: number): Store => ({
  database,
  pending,
  floor: 0,
  floorDirty: false,
  stale: new Set(),
  inFlightThrough: 0,
  suspect: undefined
})

type Outcome = "delivered" | "rejected" | { readonly inFlight: boolean }

const monotonicMillis = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1_000_000n))

const cannotOpen =
  "buffer file cannot be opened: running WITHOUT store-and-forward, values are lost while the broker is down"

const makeBufferedPublisher = Effect.fnUntraced(function* (
  settings: BufferSettings,
  options: BufferedPublisherOptions
) {
  const inner = yield* Publisher
  const batchSize = options.batchSize ?? 100
  const retryDelay = options.retryDelay ?? "5 seconds"
  const checkInterval = options.checkInterval ?? "30 seconds"
  const open = options.openDatabase ?? openDatabase

  // Every change to the table, to `current` and to its counters happens under
  // `bookkeeping`, as a delta of what the statement reported; `pending` is
  // re-read from the table whenever the drainer sees the end of it.
  const bookkeeping = yield* Semaphore.make(1)
  const hasRows = yield* Latch.make(false)
  let current: Store | undefined

  // Failures are counted every time, and logged when they start and when they end.
  const failing = new Set<Operation>()
  const failed = Effect.fnUntraced(function* (operation: Operation, message: string, error: string) {
    yield* Metric.update(Metric.withAttributes(bufferFailures, { operation }), 1)
    if (failing.has(operation)) return
    failing.add(operation)
    yield* Effect.logError(message).pipe(Effect.annotateLogs({ error }))
  })
  const recovered = Effect.fnUntraced(function* (operation: Operation, message: string) {
    if (failing.delete(operation)) yield* Effect.logInfo(message)
  })

  const setPending = Effect.fnUntraced(function* (target: Store, rows: number) {
    target.pending = Math.max(0, rows)
    if (target !== current) return
    yield* Metric.update(bufferRows, target.pending)
    if (target.pending > 0) yield* Latch.open(hasRows)
    else yield* Latch.close(hasRows)
  })

  /** Make `database` the outbox, or run unbuffered when it is `undefined`. */
  const install = Effect.fnUntraced(function* (database: OutboxDatabase | undefined) {
    if (database === undefined) {
      current = undefined
      yield* Metric.update(bufferDisabled, 1)
      yield* Metric.update(bufferRows, 0)
      return yield* Latch.close(hasRows)
    }
    const target = makeStore(database, yield* database.outbox.count())
    current = target
    yield* Metric.update(bufferDisabled, 0)
    yield* setPending(target, target.pending)
    if (target.pending > 0) {
      yield* Effect.logInfo("buffered messages waiting from a previous run").pipe(
        Effect.annotateLogs({ rows: target.pending })
      )
    }
  })

  // ---------------------------------------------------------------------------
  // Removing rows (always under `bookkeeping`)

  /** Remove handled rows and count them; if the delete fails, remember them so they are not sent again. */
  const discard = Effect.fnUntraced(function* (
    target: Store,
    ids: ReadonlyArray<number>,
    reason: "delivered" | DropReason
  ) {
    if (ids.length === 0) return
    const removed = yield* Effect.result(target.database.outbox.remove(ids))
    let count = ids.length
    if (Result.isSuccess(removed)) {
      count = removed.success
      yield* recovered("delete", "buffer deletes rows again")
    } else {
      for (const id of ids) target.stale.add(id)
      yield* failed(
        "delete",
        "buffer cannot delete delivered rows; skipping them until it can",
        removed.failure.message
      )
    }
    yield* setPending(target, target.pending - count)
    if (reason === "delivered") yield* Metric.update(bufferDrained, count)
    else yield* Metric.update(Metric.withAttributes(bufferDropped, { reason }), count)
  })

  /** Try again to delete rows whose delete failed. */
  const retryStale = Effect.fnUntraced(function* (target: Store) {
    if (!target.floorDirty && target.stale.size === 0) return
    const outbox = target.database.outbox
    const removed = yield* Effect.result(
      Effect.gen(function* () {
        if (target.floorDirty) yield* outbox.removeThrough(target.floor)
        yield* outbox.remove([...target.stale])
      })
    )
    if (Result.isFailure(removed)) {
      return yield* Metric.update(Metric.withAttributes(bufferFailures, { operation: "delete" }), 1)
    }
    target.floorDirty = false
    target.stale.clear()
    yield* recovered("delete", "buffer deletes rows again")
  })

  /** Move `floor` past the leading rows of a batch that are handled, folding their stale ids into it. */
  const advanceFloor = (target: Store, ids: ReadonlyArray<number>, handled: ReadonlySet<number>) => {
    for (const id of ids) {
      if (!handled.has(id) && !target.stale.has(id)) break
      if (target.stale.delete(id)) target.floorDirty = true
      target.floor = id
    }
  }

  // ---------------------------------------------------------------------------
  // Storing

  let storeRetryAt = 0

  /** Append a message; false when it could not be stored (counted and logged here). */
  /**
   * Append a message to the file in use, or report that it cannot. The file
   * is looked up under the permit, never passed in: a restore or replace
   * holds the permit while it swaps files, so a store waiting behind it
   * writes to the new file, not the old one it closed.
   */
  const store = Effect.fnUntraced(function* (topic: string, payload: string, qos: 0 | 1) {
    const target = current
    if (target === undefined) return false
    if ((yield* monotonicMillis) < storeRetryAt) {
      yield* Metric.update(Metric.withAttributes(bufferFailures, { operation: "insert" }), 1)
      return false
    }
    const createdAt = yield* Clock.currentTimeMillis
    const appended = yield* Effect.result(target.database.outbox.append(topic, payload, qos, createdAt))
    if (Result.isFailure(appended)) {
      storeRetryAt = (yield* monotonicMillis) + storeBackoffMillis
      yield* failed(
        "insert",
        "buffer cannot store messages; publishing directly while the broker takes them",
        appended.failure.message
      )
      return false
    }
    yield* recovered("insert", "buffer stores messages again")
    yield* Metric.update(bufferWritten, 1)
    yield* setPending(target, target.pending + 1)
    if (target.pending > settings.maxRows) {
      const protectedThrough = Math.max(target.inFlightThrough, target.floor, ...target.stale)
      const dropped = yield* target.database.outbox
        .dropOldest(target.pending - settings.maxRows, protectedThrough)
        .pipe(
          Effect.catchTags({
            SqlError: (error) => Effect.as(failed("delete", "buffer cannot drop overflowing rows", error.message), 0),
            SchemaError: (error) =>
              Effect.as(failed("delete", "buffer returned an unexpected result", error.message), 0)
          })
        )
      yield* setPending(target, target.pending - dropped)
      yield* Metric.update(Metric.withAttributes(bufferDropped, { reason: "overflow" }), dropped)
    }
    return true
  }, Semaphore.withPermit(bookkeeping))

  // ---------------------------------------------------------------------------
  // Draining

  const deliver = (row: OutboxRow): Effect.Effect<Outcome> =>
    inner.publish(row.topic, row.payload, { qos: row.qos }).pipe(
      Effect.as<Outcome>("delivered"),
      Effect.catchTag("PublishError", (error) =>
        Effect.succeed<Outcome>(error.reason === "rejected" ? "rejected" : { inFlight: error.inFlight === true })
      )
    )

  /** Read the next batch after the floor, dropping rows that no longer decode. */
  const readBatch = Effect.gen(function* () {
    const target = current
    if (target === undefined) return undefined
    yield* retryStale(target)
    const oldest = yield* target.database.outbox.oldest(batchSize, target.floor)
    // The end of the table is in this batch: true up the count, cheaply, since few rows are left.
    if (oldest.ids.length < batchSize) {
      yield* setPending(target, (yield* target.database.outbox.count(target.floor)) - target.stale.size)
    }
    const last = oldest.ids.at(-1)
    if (last !== undefined) target.inFlightThrough = last
    if (oldest.unreadable.length > 0) {
      yield* discard(target, oldest.unreadable, "unreadable")
      yield* Effect.logError("buffer held unreadable rows, dropped them").pipe(
        Effect.annotateLogs({ count: oldest.unreadable.length })
      )
    }
    yield* recovered("read", "buffer reads again")
    return { target, ids: oldest.ids, rows: oldest.rows.filter((row) => !target.stale.has(row.id)) }
  }).pipe(Semaphore.withPermit(bookkeeping))

  /** Deliver the oldest batch. Returns whether the broker took all of it. */
  const drainStep = Effect.gen(function* () {
    const batch = yield* readBatch
    if (batch === undefined) return true
    const { target, ids, rows } = batch
    const sending = new Set(rows.map((row) => row.id))
    // Rows that are already settled: unreadable ones, dropped above, and stale ones.
    const handled = new Set(ids.filter((id) => !sending.has(id)))

    // Rows the broker answered, removed in small groups as the answers come in.
    let delivered: Array<number> = []
    let rejected: Array<number> = []
    const flush = Effect.gen(function* () {
      const deliveredNow = delivered
      const rejectedNow = rejected
      delivered = []
      rejected = []
      // Rows of a file replaced meanwhile are no business of the new one.
      if (target !== current) return
      yield* discard(target, deliveredNow, "delivered")
      yield* discard(target, rejectedNow, "rejected")
      if (rejectedNow.length > 0) {
        yield* Effect.logWarning("broker rejected buffered messages, dropped them").pipe(
          Effect.annotateLogs({ count: rejectedNow.length })
        )
      }
    }).pipe(Semaphore.withPermit(bookkeeping))

    // Rows that could not be delivered; the first in order is the likely culprit if the connection broke.
    const failures: Array<{ readonly id: number; readonly inFlight: boolean }> = []
    const deliverRow = Effect.fnUntraced(function* (row: OutboxRow) {
      // Nothing new starts after a failure, so order holds as far as pipelining allows.
      if (failures.length > 0) return
      const outcome = yield* deliver(row)
      if (outcome === "delivered" || outcome === "rejected") {
        handled.add(row.id)
        if (outcome === "delivered") delivered.push(row.id)
        else rejected.push(row.id)
        if (target.suspect?.id === row.id) target.suspect = undefined
        if (delivered.length + rejected.length >= drainConcurrency) yield* flush
      } else {
        failures.push({ id: row.id, inFlight: outcome.inFlight })
      }
    })

    const [head, ...rest] = rows
    yield* Effect.gen(function* () {
      if (head === undefined) return
      // A suspect goes alone, so a message that breaks the connection takes nothing else down with it.
      if (target.suspect?.id === head.id) {
        yield* deliverRow(head)
        yield* Effect.forEach(rest, deliverRow, { concurrency: drainConcurrency, discard: true })
      } else {
        yield* Effect.forEach(rows, deliverRow, { concurrency: drainConcurrency, discard: true })
      }
    }).pipe(Effect.ensuring(flush))

    yield* Effect.gen(function* () {
      target.inFlightThrough = 0
      if (target !== current) return
      const failure = failures.reduce<(typeof failures)[number] | undefined>(
        (first, next) => (first === undefined || next.id < first.id ? next : first),
        undefined
      )
      if (failure?.inFlight === true) {
        const strikes = target.suspect?.id === failure.id ? target.suspect.strikes + 1 : 1
        target.suspect = strikes >= maxStrikes ? undefined : { id: failure.id, strikes }
        if (strikes >= maxStrikes) {
          handled.add(failure.id)
          yield* discard(target, [failure.id], "undeliverable")
          yield* Effect.logError("a buffered message broke the broker connection every time, dropped it").pipe(
            Effect.annotateLogs({ attempts: strikes })
          )
        }
      }
      advanceFloor(target, ids, handled)
    }).pipe(Semaphore.withPermit(bookkeeping))
    return failures.length === 0
  })

  // ---------------------------------------------------------------------------
  // Opening, and watching the file

  /** Open the file (moving an unusable one aside); on failure run unbuffered. Logs only when the state changes. */
  const reopen = Effect.gen(function* () {
    const opened = yield* Effect.result(open(settings.path))
    if (Result.isSuccess(opened)) {
      yield* install(opened.success)
      return yield* recovered("open", "buffer file open again, buffering resumed")
    }
    yield* install(undefined)
    yield* failed("open", cannotOpen, opened.failure.message)
  })

  /** Give up on the current file: count its rows as lost unless they were saved, close it and open the path again. */
  const replace = Effect.fnUntraced(function* (target: Store, rowsLost: number) {
    yield* Metric.update(Metric.withAttributes(bufferDropped, { reason: "lost" }), rowsLost)
    yield* target.database.close
    yield* install(undefined)
    yield* reopen
  })

  const replaceCorrupt = Effect.fnUntraced(function* (error: SqlError) {
    const target = current
    if (target === undefined) return
    yield* Effect.logError("buffer file is corrupt, replacing it").pipe(
      Effect.annotateLogs({ error: error.message, rowsLost: target.pending })
    )
    yield* replace(target, target.pending)
  }, Semaphore.withPermit(bookkeeping))

  /** Notice the file being deleted or replaced under us, retry failed deletes, or retry opening. */
  const check = Effect.gen(function* () {
    const target = current
    if (target === undefined) return yield* reopen
    yield* retryStale(target)
    const identity = yield* fileIdentity(settings.path)
    if (identity === target.database.identity) return
    if (identity === undefined) {
      // Deleted while open: the connection still reads the old file, so write it back from there.
      yield* Effect.logError("buffer file was deleted while the gateway ran, restoring it").pipe(
        Effect.annotateLogs({ path: settings.path, rows: target.pending })
      )
      const restored = yield* Effect.result(target.database.backup(settings.path))
      if (Result.isSuccess(restored)) return yield* replace(target, 0)
      yield* Effect.logError("restoring the buffer file failed, its rows are lost").pipe(
        Effect.annotateLogs({ error: restored.failure.message })
      )
      return yield* replace(target, target.pending)
    }
    yield* Effect.logError("buffer file was replaced while the gateway ran, switching to the new one").pipe(
      Effect.annotateLogs({ path: settings.path, rowsLost: target.pending })
    )
    yield* replace(target, target.pending)
  }).pipe(
    Effect.catchTags({
      SqlError: (error) => failed("read", "buffer check failed", error.message),
      SchemaError: (error) => failed("read", "buffer returned an unexpected result", error.message)
    }),
    Semaphore.withPermit(bookkeeping)
  )

  const drainer = Effect.gen(function* () {
    while (true) {
      yield* hasRows.await
      const reachable = yield* drainStep.pipe(
        Effect.catchTags({
          SqlError: (error) =>
            Effect.as(
              isCorrupt(error) ? replaceCorrupt(error) : failed("read", "buffer read failed", error.message),
              false
            ),
          // Only the ids returned by a delete are decoded here; a failure means SQLite answered nonsense.
          SchemaError: (error) =>
            Effect.as(failed("read", "buffer returned an unexpected result", error.message), false)
        })
      )
      const target = current
      if (!reachable) yield* Effect.sleep(retryDelay)
      else if (target !== undefined && target.pending === 0) {
        yield* Effect.logInfo("buffer drained")
        // Give the space back to the SD card: the file can be large after a long outage.
        yield* target.database.outbox.vacuum.pipe(
          Effect.catchTag("SqlError", (error) =>
            Effect.logWarning("buffer could not shrink its file").pipe(Effect.annotateLogs({ error: error.message }))
          ),
          Semaphore.withPermit(bookkeeping)
        )
      }
    }
  })

  // A second gateway on the same file fails here, at startup, with `BufferLocked`.
  const opened = yield* open(settings.path).pipe(
    Effect.map((database): OutboxDatabase | undefined => database),
    Effect.catchTag("BufferOpenFailed", (error) => Effect.as(failed("open", cannotOpen, error.message), undefined))
  )
  yield* install(opened)
  yield* Effect.addFinalizer(() => Effect.suspend(() => (current === undefined ? Effect.void : current.database.close)))
  yield* Effect.forkScoped(drainer)
  yield* Effect.forkScoped(Effect.repeat(Effect.delay(check, checkInterval), Schedule.forever))

  // ---------------------------------------------------------------------------
  // Publishing

  /** Publish now, or store if the broker is unavailable or older messages are still waiting. */
  const publishOrStore = Effect.fnUntraced(function* (topic: string, payload: string, qos: 0 | 1) {
    // No file: running unbuffered, or a restore or replace is swapping files right now. Waiting for the
    // permit tells the two apart; publishing straight away would lose the message if the broker is down.
    const target = current ?? (yield* Effect.sync(() => current).pipe(Semaphore.withPermit(bookkeeping)))
    if (target === undefined) return yield* inner.publish(topic, payload, { qos })
    // Behind waiting messages, so order is kept; ahead of them if the outbox cannot take it right now.
    if (target.pending > 0) {
      if (yield* store(topic, payload, qos)) return
      yield* inner.publish(topic, payload, { qos })
      return yield* Metric.update(bufferBypassed, 1)
    }
    const sent = yield* Effect.result(inner.publish(topic, payload, { qos }))
    if (Result.isSuccess(sent)) return
    if (sent.failure.reason === "rejected") return yield* sent.failure
    if (yield* store(topic, payload, qos)) return
    return yield* new PublishError({
      topic,
      reason: "unavailable",
      message: `${sent.failure.message}, and the buffer cannot store it`
    })
  })

  return Publisher.of({
    publish: (topic, payload, publishOptions) => {
      const qos = publishOptions?.qos
      // Retained state is restored by the pipeline and the MQTT publisher; QoS 2 is refused downstream.
      // Retained and transient messages are not stored: see the module comment.
      if (publishOptions?.retain === true || publishOptions?.transient === true || qos === 2) {
        return inner.publish(topic, payload, publishOptions)
      }
      return publishOrStore(topic, payload, qos === 0 ? 0 : 1)
    }
  })
})

/**
 * Wrap the provided `Publisher` with a SQLite outbox at `settings.path`
 * (its directory is created if missing). Fails with `BufferLocked` when
 * another process holds the file.
 */
export const BufferedPublisher = (settings: BufferSettings, options: BufferedPublisherOptions = {}) =>
  Layer.effect(Publisher, makeBufferedPublisher(settings, options))
