/**
 * The on-device history: every read the pipeline hands over, written in batches to a SQLite file of its own, and
 * read back as chart buckets for the status page.
 *
 * - Reads wait in memory and are written every `flushEveryMs` (30 s) in one transaction, sooner when half of
 *   `MAX_PENDING` is waiting. A write rewrites a page per point it touches, so fewer writes spare the SD card; the
 *   cost is that a chart can be up to 30 s behind, and a crash or power cut loses at most that much of it. At most
 *   `MAX_PENDING` wait: while the file cannot be written (disk full, say) the oldest are dropped and counted, and the
 *   gateway's memory stays bounded. A failed write is tried again after the same interval.
 * - Every hour, reads older than a day and rollups older than `retentionDays` are deleted.
 * - A file that cannot be opened (moved aside first when it is corrupt) leaves the gateway running without
 *   history, said once in the log and by `ot_gateway_history_disabled`. History never costs a read or a publish.
 * - A file that goes corrupt while running is closed, moved aside and replaced by a new one, which gets the reads
 *   still waiting; at most once an hour on the monotonic clock, so a failing card does not fill up with copies.
 *   If no new file can be opened, the history is off until restart, again said once and by the gauge.
 *
 * Retention follows the wall clock, like the data's own timestamps: after NTP steps it forward, older reads go
 * sooner; after it steps back, newer ones stay until the clock catches up.
 */
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import type { HistorySeries } from "@ot-gateway/api"
import { HISTORY_CHANGES_MAX, HistoryUnavailable } from "@ot-gateway/api"
import {
  type HistorySettings,
  type HistorySink,
  historyDisabled,
  historyDropped,
  historyFailures,
  historyWritten,
  monotonicMillis
} from "@ot-gateway/core"
import {
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Metric,
  Path,
  Result,
  Schedule,
  Scope,
  Semaphore
} from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { MINUTE_MS, RAW_MS, type Row, historyMigrations, makeStore, type Store, withoutSpans } from "./Store.ts"

/** Reads waiting for the next write, at most; about 200 points read every second for a minute and a half. */
export const MAX_PENDING = 20_000
const DEFAULT_BUCKETS = 300
const MAX_BUCKETS = 2_000
const HOUR_MS = 3_600_000
/** How often waiting reads are written by default. */
const DEFAULT_FLUSH_EVERY_MS = 30_000
/** How often the writer checks whether a write is due. */
const TICK_MS = 5_000

export interface SeriesQuery {
  readonly device: string
  readonly point: string
  readonly from: number
  readonly to: number
  readonly buckets?: number
  /** Also list when the value changed, from every read; only for a range that starts within the last day. */
  readonly changes?: boolean
}

export interface History {
  readonly sink: HistorySink
  /** A point's reads between `from` and `to` in about `buckets` buckets: from every read for buckets under a minute, or a range of an hour or less, that starts within the last day; else per minute. */
  readonly series: (query: SeriesQuery) => Effect.Effect<HistorySeries, HistoryUnavailable>
}

export interface HistoryOptions {
  /** How often waiting reads are written (default 30 s), sooner when half of `MAX_PENDING` is waiting. */
  readonly flushEveryMs?: number
  /**
   * Test only: wraps every store the history opens, the replacements too, so that a test can make a write fail as
   * a corrupt file does. Leave it unset in the gateway.
   */
  readonly wrapStore?: (store: Store) => Store
}

/** SQLITE_CORRUPT (11) or SQLITE_NOTADB (26), read from the `node:sqlite` error. */
const isCorrupt = (error: SqlError): boolean => {
  const cause: unknown = error.reason.cause
  if (typeof cause !== "object" || cause === null || !("errcode" in cause) || typeof cause.errcode !== "number") {
    return false
  }
  const code = cause.errcode & 0xff
  return code === 11 || code === 26
}

/** The step for about `buckets` buckets over `[from, to)`: whole seconds, and whole minutes from the rollups. */
export const stepFor = (from: number, to: number, buckets: number, minimum: number) =>
  Math.max(
    minimum,
    Math.ceil((to - from) / Math.min(MAX_BUCKETS, Math.max(1, Math.round(buckets))) / minimum) * minimum
  )

/** Open and migrate the file at `path` in `scope`; `corrupt` when moving it aside could help. */
const openStore = (path: string, scope: Scope.Scope) =>
  Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(
      Layer.fresh(SqliteClient.layer({ filename: path, busyTimeout: "200 millis", disableWAL: true })),
      scope
    )
    const sql = Context.get(context, SqliteClient.SqliteClient)
    const [pages] = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`
    if (pages?.page_count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL`
    yield* sql`PRAGMA journal_mode = WAL`
    yield* sql`PRAGMA synchronous = NORMAL`
    yield* SqliteMigrator.run({ loader: historyMigrations }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
    return makeStore(sql)
  }).pipe(
    Effect.catchTags({
      SqlError: (error) => Effect.fail({ corrupt: isCorrupt(error), message: error.message }),
      MigrationError: (error) => Effect.fail({ corrupt: true, message: `migrations failed: ${error.message}` })
    }),
    withoutSpans
  )

/** A store and what closes it, so that it can be replaced before the history's own scope ends. */
interface Opened {
  readonly store: Store
  readonly close: Effect.Effect<void>
}

/** Rename the file at `path` and its WAL files to `<path>.corrupt-<time>`; returns the new name. */
const moveAside = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const stamp = new Date(yield* Clock.currentTimeMillis).toISOString().replace(/[:.]/g, "-")
  const aside = `${path}.corrupt-${stamp}`
  for (const suffix of ["", "-wal", "-shm"]) {
    if (yield* fs.exists(path + suffix)) yield* fs.rename(path + suffix, aside + suffix)
  }
  return aside
})

/** Open the file at `path` in a scope of its own, forked from `scope` and closed again when opening fails. */
const openIn = Effect.fnUntraced(function* (path: string, scope: Scope.Scope) {
  const own = yield* Scope.fork(scope)
  const close = Scope.close(own, Exit.void)
  const store = yield* openStore(path, own).pipe(Effect.tapError(() => close))
  return { store, close } satisfies Opened
})

/** The store at `path`, a corrupt file moved aside first; the reason when there is none. */
const open = Effect.fnUntraced(function* (path: string, scope: Scope.Scope) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const made = yield* fs.makeDirectory(paths.dirname(path), { recursive: true }).pipe(Effect.result)
  if (Result.isFailure(made)) return { reason: `cannot create the directory: ${made.failure.message}` } as const
  const first = yield* openIn(path, scope).pipe(Effect.result)
  if (Result.isSuccess(first)) return { opened: first.success } as const
  if (!first.failure.corrupt) return { reason: first.failure.message } as const
  const moved = yield* Effect.result(moveAside(path))
  if (Result.isFailure(moved)) {
    return { reason: `${first.failure.message}; moving it aside failed: ${moved.failure.message}` } as const
  }
  yield* Effect.logError("history file was unusable, moved it aside and started a new one").pipe(
    Effect.annotateLogs({ path, movedTo: moved.success, error: first.failure.message })
  )
  const again = yield* openIn(path, scope).pipe(Effect.result)
  return Result.isSuccess(again) ? ({ opened: again.success } as const) : ({ reason: again.failure.message } as const)
})

const unavailable = (message: string) => Effect.fail(new HistoryUnavailable({ message }))

/** Without a file: reads are not kept, and asking for them says why. */
const disabled = (reason: string): History => ({
  sink: { record: () => {} },
  series: () => unavailable(`the gateway keeps no history: ${reason}`)
})

/** The history in `settings.path` for as long as the scope is open, with its writer and pruner running. */
export const openHistory = (
  settings: HistorySettings,
  options: HistoryOptions = {}
): Effect.Effect<History, never, Scope.Scope | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    // Every file this history opens, the replacements too, lives in this scope. It is forked before the final
    // flush is registered below, so it closes after that flush has written what was waiting.
    const files = yield* Scope.fork(yield* Effect.scope)
    const opened = yield* open(settings.path, files)
    if (!("opened" in opened)) {
      yield* Metric.update(historyDisabled, 1)
      yield* Effect.logError("history not kept: its file could not be opened").pipe(
        Effect.annotateLogs({ path: settings.path, error: opened.reason })
      )
      return disabled(opened.reason)
    }
    yield* Metric.update(historyDisabled, 0)
    const wrap = options.wrapStore ?? ((store: Store) => store)
    // The open file, replaced as a whole when it goes corrupt; undefined once the history is off. Every statement
    // on it runs under `permit`, so the flusher, the pruner and a reader never use a store while it is being closed.
    let current: Opened | undefined = { store: wrap(opened.opened.store), close: opened.opened.close }
    // Why the history is off, once a corrupt file could not be replaced.
    let off: string | undefined
    // When the file was last replaced, on the monotonic clock.
    let replacedAt: number | undefined
    const permit = yield* Semaphore.make(1)
    let pending: Array<Row> = []
    let dropped = 0
    let failing = false

    const keepAtMost = (rows: Array<Row>) => {
      if (rows.length <= MAX_PENDING) return rows
      dropped += rows.length - MAX_PENDING
      return rows.slice(rows.length - MAX_PENDING)
    }

    /** No file from now on: nothing is kept, and the gauge and the log say why. */
    const turnOff = Effect.fnUntraced(function* (reason: string) {
      current = undefined
      off = reason
      pending = []
      yield* Metric.update(historyDisabled, 1)
      yield* Effect.logError("history turned off: its corrupt file could not be replaced").pipe(
        Effect.annotateLogs({ path: settings.path, error: reason })
      )
    })

    /**
     * Close a file that went corrupt while running, move it aside and open a new one; at most once an hour, so a
     * card that corrupts every file neither fills up with copies nor renames files on every flush. True when the
     * file was replaced or the history turned off. Runs under `permit`, from the flusher or the pruner only.
     */
    const replaceCorrupt = Effect.fnUntraced(function* (target: Opened, error: SqlError) {
      const now = yield* monotonicMillis
      if (replacedAt !== undefined && now - replacedAt < HOUR_MS) return false
      replacedAt = now
      current = undefined
      yield* target.close
      const moved = yield* Effect.result(moveAside(settings.path))
      if (Result.isFailure(moved)) {
        yield* turnOff(`${error.message}; moving it aside failed: ${moved.failure.message}`)
        return true
      }
      const reopened = yield* open(settings.path, files)
      if (!("opened" in reopened)) {
        yield* turnOff(reopened.reason)
        return true
      }
      current = { store: wrap(reopened.opened.store), close: reopened.opened.close }
      yield* Effect.logError(
        "history file went corrupt while the gateway ran, moved it aside and started a new one"
      ).pipe(Effect.annotateLogs({ path: settings.path, movedTo: moved.success, error: error.message }))
      return true
    })

    const flush = Effect.gen(function* () {
      if (dropped > 0) {
        yield* Metric.update(historyDropped, dropped)
        dropped = 0
      }
      const target = current
      if (target === undefined || pending.length === 0) return
      const batch = pending
      pending = []
      const written = yield* Effect.result(target.store.write(batch))
      if (Result.isSuccess(written)) {
        yield* Metric.update(historyWritten, batch.length)
        if (failing) {
          failing = false
          yield* Effect.logInfo("history writes again").pipe(Effect.annotateLogs({ path: settings.path }))
        }
        return
      }
      yield* Metric.update(Metric.withAttributes(historyFailures, { operation: "write" }), 1)
      // Kept for the next try, oldest dropped past the cap: a full disk must not grow the gateway's memory. After
      // a replacement they go to the new file on the next flush.
      pending = keepAtMost([...batch, ...pending])
      if (isCorrupt(written.failure) && (yield* replaceCorrupt(target, written.failure))) return
      if (!failing) {
        failing = true
        yield* Effect.logWarning("history cannot write; keeping the latest reads in memory until it can").pipe(
          Effect.annotateLogs({ path: settings.path, error: written.failure.message })
        )
      }
    }).pipe(Semaphore.withPermit(permit))

    const prune = Effect.gen(function* () {
      const target = current
      if (target === undefined) return
      const now = yield* Clock.currentTimeMillis
      const pruned = yield* Effect.result(target.store.prune(now - RAW_MS, now - settings.retentionDays * 86_400_000))
      if (Result.isFailure(pruned)) {
        yield* Metric.update(Metric.withAttributes(historyFailures, { operation: "prune" }), 1)
        if (isCorrupt(pruned.failure) && (yield* replaceCorrupt(target, pruned.failure))) return
        yield* Effect.logWarning("history could not delete old reads").pipe(
          Effect.annotateLogs({ path: settings.path, error: pruned.failure.message })
        )
      }
    }).pipe(Semaphore.withPermit(permit))

    // A write rewrites one page per point it touches, however few rows it holds, so writing less often writes
    // less to the card. A cheap tick checks whether a write is due: once the interval has passed since the last
    // attempt (on the monotonic clock, failed attempts too), or sooner when half the cap is waiting, so a busy
    // gateway drops nothing on a healthy disk. A tick that is not due does no I/O.
    const flushEveryMs = options.flushEveryMs ?? DEFAULT_FLUSH_EVERY_MS
    const tickEvery = Duration.millis(Math.min(TICK_MS, flushEveryMs))
    let attemptedAt = yield* monotonicMillis
    const tick = Effect.gen(function* () {
      const now = yield* monotonicMillis
      if (now - attemptedAt < flushEveryMs && pending.length < MAX_PENDING / 2) return
      attemptedAt = now
      yield* flush
    })
    yield* tick.pipe(Effect.repeat(Schedule.spaced(tickEvery)), Effect.delay(tickEvery), Effect.forkScoped)
    yield* prune.pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(HOUR_MS))),
      Effect.delay("1 minute"),
      Effect.forkScoped
    )
    // What is still waiting goes to the file when the gateway stops.
    yield* Effect.addFinalizer(() => flush.pipe(Effect.timeout("5 seconds"), Effect.ignore))

    return {
      sink: {
        record: (device, point, value, ts) => {
          if (off !== undefined) return
          pending.push({ device, point, ts, value: typeof value === "boolean" ? (value ? 1 : 0) : value })
          if (pending.length > MAX_PENDING + MAX_PENDING / 10) pending = keepAtMost(pending)
        }
      },
      series: (query) =>
        Effect.gen(function* () {
          // Buckets of a minute or more on a range longer than an hour come from the rollups, whatever the range's
          // age: a 24 h chart (360 s buckets) must not let a browser's clock a few milliseconds off the gateway's
          // pick the table, nor aggregate up to a day of reads per point for buckets the rollups draw the same.
          // Finer buckets, and any range of an hour or less, come from every read while the range starts within
          // the last day (reads are kept that long), else from the rollups at a minute step. So `history --since
          // 10m` in ten buckets ends its buckets at now, not at the last whole minute. The status page's ranges
          // (15 min, 1 h, 24 h) are far from that boundary. Rollups are merged in the same transaction as the reads,
          // so they hold everything flushed (every 30 s); the newest bucket can lag by one flush, as the raw one does.
          const buckets = query.buckets ?? DEFAULT_BUCKETS
          const fineMs = stepFor(query.from, query.to, buckets, 1_000)
          const now = yield* Clock.currentTimeMillis
          const recent = query.from >= now - RAW_MS
          const raw = recent && (fineMs < MINUTE_MS || query.to - query.from <= HOUR_MS)
          const stepMs = raw ? fineMs : stepFor(query.from, query.to, buckets, MINUTE_MS)
          const from = raw ? query.from : Math.floor(query.from / MINUTE_MS) * MINUTE_MS
          // A corrupt file only fails this request; the flusher or the pruner replaces it, never a reader.
          const rows = yield* Effect.gen(function* () {
            const target = current
            if (target === undefined) return yield* unavailable(`the gateway keeps no history: ${off ?? "it is off"}`)
            return yield* Effect.gen(function* () {
              const buckets = yield* target.store.buckets(raw ? "readings" : "minutes", { ...query, from, stepMs })
              // One more than shown, to tell whether there were more.
              const changes =
                query.changes === true && recent
                  ? yield* target.store.changes({ ...query, limit: HISTORY_CHANGES_MAX + 1 })
                  : undefined
              return { buckets, changes }
            }).pipe(
              Effect.tapError(() => Metric.update(Metric.withAttributes(historyFailures, { operation: "read" }), 1)),
              Effect.catchTags({
                SqlError: (error) => unavailable(`history could not be read: ${error.message}`),
                SchemaError: (error) => unavailable(`history holds rows it cannot read: ${error.message}`)
              })
            )
          }).pipe(
            Semaphore.withPermit(permit),
            // The wait for a long write counts too: the status page gets an answer, not a hung request.
            Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => unavailable("history is busy, try again") })
          )
          return {
            device: query.device,
            point: query.point,
            from,
            to: query.to,
            stepMs,
            resolution: raw ? "read" : "minute",
            buckets: rows.buckets.map((row) => ({
              t: from + row.b * stepMs,
              min: row.min,
              max: row.max,
              avg: row.avg,
              count: row.count
            })),
            ...(rows.changes === undefined
              ? {}
              : {
                  changes: {
                    list: rows.changes.slice(0, HISTORY_CHANGES_MAX).map((row) => ({ t: row.ts, value: row.value })),
                    truncated: rows.changes.length > HISTORY_CHANGES_MAX
                  }
                })
          } satisfies HistorySeries
        })
    }
  })
