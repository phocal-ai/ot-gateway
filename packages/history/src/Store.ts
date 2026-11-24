/**
 * The history tables and their queries, on one open SQLite connection.
 *
 * - `readings`: every read, keyed by device, point and time, kept for a day (`RAW_MS`). Enough for a chart of the
 *   last hours at full resolution.
 * - `minutes`: per minute, the minimum, maximum, sum and count of a point's reads, kept for `retentionDays`. The
 *   average is the plain mean of the reads in the minute; at chart resolution that is the same line. `first` and
 *   `last` are the times of its first and last read (null in rows written before they were added), so a gap in
 *   the reads is known to the millisecond, not just to the minute.
 *
 * Both are `WITHOUT ROWID` tables clustered on their key, so one point's range is one contiguous read. Booleans are
 * stored as 0 and 1. Rows are decoded with Schema on the way out: SQLite is a boundary.
 */
import { Array as Arr, Effect, Schema } from "effect"
import { Migrator, SqlClient, SqlSchema } from "effect/sql"

/** How long every read is kept; older ones survive only in the per-minute rollups. */
export const RAW_MS = 86_400_000
export const MINUTE_MS = 60_000

/** One read, as the store takes it (a type, not an interface: `sql.insert` takes records). */
export type Row = {
  readonly device: string
  readonly point: string
  readonly ts: number
  readonly value: number
}

export const historyMigrations = Migrator.fromRecord({
  "0001_create_history": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE readings (
        device TEXT NOT NULL,
        point TEXT NOT NULL,
        ts INTEGER NOT NULL,
        value REAL NOT NULL,
        PRIMARY KEY (device, point, ts)
      ) WITHOUT ROWID
    `
    yield* sql`
      CREATE TABLE minutes (
        device TEXT NOT NULL,
        point TEXT NOT NULL,
        minute INTEGER NOT NULL,
        min REAL NOT NULL,
        max REAL NOT NULL,
        sum REAL NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (device, point, minute)
      ) WITHOUT ROWID
    `
  }),
  "0002_minutes_first_last": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE minutes ADD COLUMN first INTEGER`
    yield* sql`ALTER TABLE minutes ADD COLUMN last INTEGER`
  })
})

/** A bucket as a query returns it, before it is labelled with its time. */
const BucketRow = Schema.Struct({
  b: Schema.Int,
  min: Schema.Finite,
  max: Schema.Finite,
  avg: Schema.Finite,
  count: Schema.Int,
  /** The times of the bucket's first and last read; null from rollups written before they were kept. */
  first: Schema.NullOr(Schema.Finite),
  last: Schema.NullOr(Schema.Finite)
})

export interface BucketQuery {
  readonly device: string
  readonly point: string
  readonly from: number
  readonly to: number
  readonly stepMs: number
}

/** A read where a point's value changed, as the query returns it. */
const ChangeRow = Schema.Struct({ ts: Schema.Int, value: Schema.Finite })

/** Rows per statement: 4 or 9 bound values each, well under SQLite's limit of 32,766. */
const CHUNK = 500

/** The minute rollups of a batch of reads: one row per point and minute, to merge into what is stored. */
export const rollup = (rows: ReadonlyArray<Row>) => {
  const minutes = new Map<
    string,
    {
      device: string
      point: string
      minute: number
      min: number
      max: number
      sum: number
      count: number
      first: number
      last: number
    }
  >()
  for (const row of rows) {
    const minute = Math.floor(row.ts / MINUTE_MS) * MINUTE_MS
    const key = `${row.device}\u0000${row.point}\u0000${minute}`
    const current = minutes.get(key)
    if (current === undefined) {
      minutes.set(key, {
        device: row.device,
        point: row.point,
        minute,
        min: row.value,
        max: row.value,
        sum: row.value,
        count: 1,
        first: row.ts,
        last: row.ts
      })
    } else {
      current.min = Math.min(current.min, row.value)
      current.max = Math.max(current.max, row.value)
      current.sum += row.value
      current.count += 1
      current.first = Math.min(current.first, row.ts)
      current.last = Math.max(current.last, row.ts)
    }
  }
  return [...minutes.values()]
}

/**
 * Runs `effect` without trace spans. Effect's SQL client opens a span for every statement and transaction, and the
 * history's run every few seconds on every gateway, from fibers that no poll cycle samples, so they would reach the
 * trace exporter whatever the sampler says. Their failures are counted in `ot_gateway_history_failures` instead. A
 * span the caller opened around them is kept. Every statement on the history's file goes through this.
 */
export const withoutSpans = Effect.withTracerEnabled(false)

export const makeStore = (sql: SqlClient.SqlClient) => {
  const bucketsOf = (table: "readings" | "minutes", query: BucketQuery) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: BucketRow,
      execute: () =>
        table === "readings"
          ? sql`
              SELECT CAST((ts - ${query.from}) / ${query.stepMs} AS INTEGER) AS b,
                MIN(value) AS min, MAX(value) AS max, AVG(value) AS avg, COUNT(*) AS count,
                MIN(ts) AS first, MAX(ts) AS last
              FROM readings
              WHERE device = ${query.device} AND point = ${query.point} AND ts >= ${query.from} AND ts < ${query.to}
              GROUP BY b ORDER BY b`
          : sql`
              SELECT CAST((minute - ${query.from}) / ${query.stepMs} AS INTEGER) AS b,
                MIN(min) AS min, MAX(max) AS max, SUM(sum) / SUM(count) AS avg, SUM(count) AS count,
                MIN(first) AS first, MAX(last) AS last
              FROM minutes
              WHERE device = ${query.device} AND point = ${query.point} AND minute >= ${query.from} AND minute < ${query.to}
              GROUP BY b ORDER BY b`
    })(undefined).pipe(withoutSpans)

  /**
   * The first read of `[from, to)` and every read whose value differs from the one before it, oldest first, at most
   * `limit`: when a state (a switch, an alarm) changed. From every read, so only within the last day.
   */
  const changesOf = (query: Omit<BucketQuery, "stepMs"> & { readonly limit: number }) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: ChangeRow,
      execute: () => sql`
        SELECT ts, value FROM (
          SELECT ts, value, LAG(value) OVER (ORDER BY ts) AS previous
          FROM readings
          WHERE device = ${query.device} AND point = ${query.point} AND ts >= ${query.from} AND ts < ${query.to}
        )
        WHERE previous IS NULL OR value != previous
        ORDER BY ts LIMIT ${query.limit}`
    })(undefined).pipe(withoutSpans)

  return {
    /** Store a batch of reads and merge them into the minute rollups, in one transaction. */
    write: (rows: ReadonlyArray<Row>) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (!Arr.isReadonlyArrayNonEmpty(rows)) return
            for (const chunk of Arr.chunksOf(rows, CHUNK)) {
              yield* sql`INSERT OR REPLACE INTO readings ${sql.insert(chunk)}`
            }
            const minutes = rollup(rows)
            if (!Arr.isReadonlyArrayNonEmpty(minutes)) return
            for (const chunk of Arr.chunksOf(minutes, CHUNK)) {
              // A row from before `first` and `last` were kept stays without them (SQLite's MIN and MAX of a
              // NULL are NULL): a time known only for the later reads of a minute would be wrong.
              yield* sql`
              INSERT INTO minutes ${sql.insert(chunk)}
              ON CONFLICT (device, point, minute) DO UPDATE SET
                min = MIN(minutes.min, excluded.min),
                max = MAX(minutes.max, excluded.max),
                sum = minutes.sum + excluded.sum,
                count = minutes.count + excluded.count,
                first = MIN(minutes.first, excluded.first),
                last = MAX(minutes.last, excluded.last)`
            }
          })
        )
        .pipe(withoutSpans),
    /** One point's buckets from every read (`readings`) or from the rollups (`minutes`). */
    buckets: bucketsOf,
    /** One point's changes of value from every read: the first read, then each read that differs from the last. */
    changes: changesOf,
    /** Delete reads older than `rawBefore` and rollups older than `minutesBefore` (Unix ms). */
    prune: (rawBefore: number, minutesBefore: number) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM readings WHERE ts < ${rawBefore}`
        yield* sql`DELETE FROM minutes WHERE minute < ${minutesBefore}`
        yield* sql`PRAGMA incremental_vacuum`
      }).pipe(withoutSpans)
  }
}

export type Store = ReturnType<typeof makeStore>
