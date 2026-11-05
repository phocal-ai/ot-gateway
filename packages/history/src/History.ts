/**
 * The on-device history: every read the pipeline hands over, written in batches to a SQLite file of its own, and
 * read back as chart buckets for the status page.
 *
 * - Reads wait in memory and are written every `flushEveryMs` (5 s) in one transaction, so an SD card sees a few
 *   commits a minute, not one per read. At most `MAX_PENDING` wait: while the file cannot be written (disk full,
 *   say) the oldest are dropped and counted, and the gateway's memory stays bounded.
 * - Every hour, reads older than a day and rollups older than `retentionDays` are deleted.
 * - A file that cannot be opened (moved aside first when it is corrupt) leaves the gateway running without
 *   history, said once in the log and by `ot_gateway_history_disabled`. History never costs a read or a publish.
 *
 * Retention follows the wall clock, like the data's own timestamps: after NTP steps it forward, older reads go
 * sooner; after it steps back, newer ones stay until the clock catches up.
 */
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import type { HistorySeries } from "@ot-gateway/api"
import { HistoryUnavailable } from "@ot-gateway/api"
import {
  type HistorySettings,
  type HistorySink,
  historyDisabled,
  historyDropped,
  historyFailures,
  historyWritten
} from "@ot-gateway/core"
import { Clock, Context, Duration, Effect, FileSystem, Layer, Metric, Path, Result, Schedule, Scope } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { MINUTE_MS, RAW_MS, type Row, historyMigrations, makeStore, type Store } from "./Store.ts"

/** Reads waiting for the next write, at most; about 200 points read every second for a minute and a half. */
export const MAX_PENDING = 20_000
const DEFAULT_BUCKETS = 300
const MAX_BUCKETS = 2_000
const HOUR_MS = 3_600_000

export interface SeriesQuery {
  readonly device: string
  readonly point: string
  readonly from: number
  readonly to: number
  readonly buckets?: number
}

export interface History {
  readonly sink: HistorySink
  /** A point's reads between `from` and `to` in about `buckets` buckets: every read within the last day, else per minute. */
  readonly series: (query: SeriesQuery) => Effect.Effect<HistorySeries, HistoryUnavailable>
}

export interface HistoryOptions {
  /** How often waiting reads are written (default 5 s). */
  readonly flushEveryMs?: number
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
    })
  )

/** The store at `path`, a corrupt file moved aside first; the reason when there is none. */
const open = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const scope = yield* Effect.scope
  const made = yield* fs.makeDirectory(paths.dirname(path), { recursive: true }).pipe(Effect.result)
  if (Result.isFailure(made)) return { reason: `cannot create the directory: ${made.failure.message}` } as const
  const first = yield* openStore(path, yield* Scope.fork(scope)).pipe(Effect.result)
  if (Result.isSuccess(first)) return { store: first.success } as const
  if (!first.failure.corrupt) return { reason: first.failure.message } as const
  const stamp = new Date(yield* Clock.currentTimeMillis).toISOString().replace(/[:.]/g, "-")
  const aside = `${path}.corrupt-${stamp}`
  for (const suffix of ["", "-wal", "-shm"]) {
    const moved = yield* Effect.result(
      Effect.flatMap(fs.exists(path + suffix), (exists) =>
        exists ? fs.rename(path + suffix, aside + suffix) : Effect.void
      )
    )
    if (Result.isFailure(moved)) {
      return { reason: `${first.failure.message}; moving it aside failed: ${moved.failure.message}` } as const
    }
  }
  yield* Effect.logError("history file was unusable, moved it aside and started a new one").pipe(
    Effect.annotateLogs({ path, movedTo: aside, error: first.failure.message })
  )
  const again = yield* openStore(path, yield* Scope.fork(scope)).pipe(Effect.result)
  return Result.isSuccess(again) ? ({ store: again.success } as const) : ({ reason: again.failure.message } as const)
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
    const opened = yield* open(settings.path)
    if (!("store" in opened)) {
      yield* Metric.update(historyDisabled, 1)
      yield* Effect.logError("history not kept: its file could not be opened").pipe(
        Effect.annotateLogs({ path: settings.path, error: opened.reason })
      )
      return disabled(opened.reason)
    }
    yield* Metric.update(historyDisabled, 0)
    const store: Store = opened.store
    let pending: Array<Row> = []
    let dropped = 0
    let failing = false

    const keepAtMost = (rows: Array<Row>) => {
      if (rows.length <= MAX_PENDING) return rows
      dropped += rows.length - MAX_PENDING
      return rows.slice(rows.length - MAX_PENDING)
    }

    const flush = Effect.gen(function* () {
      if (dropped > 0) {
        yield* Metric.update(historyDropped, dropped)
        dropped = 0
      }
      if (pending.length === 0) return
      const batch = pending
      pending = []
      const written = yield* Effect.result(store.write(batch))
      if (Result.isSuccess(written)) {
        yield* Metric.update(historyWritten, batch.length)
        if (failing) {
          failing = false
          yield* Effect.logInfo("history writes again").pipe(Effect.annotateLogs({ path: settings.path }))
        }
        return
      }
      yield* Metric.update(Metric.withAttributes(historyFailures, { operation: "write" }), 1)
      // Kept for the next try, oldest dropped past the cap: a full disk must not grow the gateway's memory.
      pending = keepAtMost([...batch, ...pending])
      if (!failing) {
        failing = true
        yield* Effect.logWarning("history cannot write; keeping the latest reads in memory until it can").pipe(
          Effect.annotateLogs({ path: settings.path, error: written.failure.message })
        )
      }
    })

    const prune = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const pruned = yield* Effect.result(store.prune(now - RAW_MS, now - settings.retentionDays * 86_400_000))
      if (Result.isFailure(pruned)) {
        yield* Metric.update(Metric.withAttributes(historyFailures, { operation: "prune" }), 1)
        yield* Effect.logWarning("history could not delete old reads").pipe(
          Effect.annotateLogs({ path: settings.path, error: pruned.failure.message })
        )
      }
    })

    const flushEvery = Duration.millis(options.flushEveryMs ?? 5_000)
    yield* flush.pipe(Effect.repeat(Schedule.spaced(flushEvery)), Effect.delay(flushEvery), Effect.forkScoped)
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
          pending.push({ device, point, ts, value: typeof value === "boolean" ? (value ? 1 : 0) : value })
          if (pending.length > MAX_PENDING + MAX_PENDING / 10) pending = keepAtMost(pending)
        }
      },
      series: (query) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          // Every read while the range is within the last day, the rollups beyond.
          const raw = query.from >= now - RAW_MS
          const stepMs = stepFor(query.from, query.to, query.buckets ?? DEFAULT_BUCKETS, raw ? 1_000 : MINUTE_MS)
          const from = raw ? query.from : Math.floor(query.from / MINUTE_MS) * MINUTE_MS
          const rows = yield* store.buckets(raw ? "readings" : "minutes", { ...query, from, stepMs }).pipe(
            Effect.tapError(() => Metric.update(Metric.withAttributes(historyFailures, { operation: "read" }), 1)),
            Effect.catchTags({
              SqlError: (error) => unavailable(`history could not be read: ${error.message}`),
              SchemaError: (error) => unavailable(`history holds rows it cannot read: ${error.message}`)
            })
          )
          return {
            device: query.device,
            point: query.point,
            from,
            to: query.to,
            stepMs,
            resolution: raw ? "read" : "minute",
            buckets: rows.map((row) => ({
              t: from + row.b * stepMs,
              min: row.min,
              max: row.max,
              avg: row.avg,
              count: row.count
            }))
          } satisfies HistorySeries
        })
    }
  })
