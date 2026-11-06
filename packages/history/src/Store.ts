/**
 * The history tables and their queries, on one open SQLite connection.
 *
 * - `readings`: every read, keyed by device, point and time, kept for a day (`RAW_MS`). Enough for a chart of the
 *   last hours at full resolution.
 * - `minutes`: per minute, the minimum, maximum, sum and count of a point's reads, kept for `retentionDays`. The
 *   average is the plain mean of the reads in the minute; at chart resolution that is the same line.
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
  })
})

/** A bucket as a query returns it, before it is labelled with its time. */
const BucketRow = Schema.Struct({
  b: Schema.Int,
  min: Schema.Finite,
  max: Schema.Finite,
  avg: Schema.Finite,
  count: Schema.Int
})

export interface BucketQuery {
  readonly device: string
  readonly point: string
  readonly from: number
  readonly to: number
  readonly stepMs: number
}

/** Rows per statement: 4 or 7 bound values each, well under SQLite's limit of 32,766. */
const CHUNK = 500

/** The minute rollups of a batch of reads: one row per point and minute, to merge into what is stored. */
export const rollup = (rows: ReadonlyArray<Row>) => {
  const minutes = new Map<
    string,
    { device: string; point: string; minute: number; min: number; max: number; sum: number; count: number }
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
        count: 1
      })
    } else {
      current.min = Math.min(current.min, row.value)
      current.max = Math.max(current.max, row.value)
      current.sum += row.value
      current.count += 1
    }
  }
  return [...minutes.values()]
}

export const makeStore = (sql: SqlClient.SqlClient) => {
  const bucketsOf = (table: "readings" | "minutes", query: BucketQuery) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: BucketRow,
      execute: () =>
        table === "readings"
          ? sql`
              SELECT CAST((ts - ${query.from}) / ${query.stepMs} AS INTEGER) AS b,
                MIN(value) AS min, MAX(value) AS max, AVG(value) AS avg, COUNT(*) AS count
              FROM readings
              WHERE device = ${query.device} AND point = ${query.point} AND ts >= ${query.from} AND ts < ${query.to}
              GROUP BY b ORDER BY b`
          : sql`
              SELECT CAST((minute - ${query.from}) / ${query.stepMs} AS INTEGER) AS b,
                MIN(min) AS min, MAX(max) AS max, SUM(sum) / SUM(count) AS avg, SUM(count) AS count
              FROM minutes
              WHERE device = ${query.device} AND point = ${query.point} AND minute >= ${query.from} AND minute < ${query.to}
              GROUP BY b ORDER BY b`
    })(undefined)

  return {
    /** Store a batch of reads and merge them into the minute rollups, in one transaction. */
    write: (rows: ReadonlyArray<Row>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!Arr.isReadonlyArrayNonEmpty(rows)) return
          for (const chunk of Arr.chunksOf(rows, CHUNK)) {
            yield* sql`INSERT OR REPLACE INTO readings ${sql.insert(chunk)}`
          }
          const minutes = rollup(rows)
          if (!Arr.isReadonlyArrayNonEmpty(minutes)) return
          for (const chunk of Arr.chunksOf(minutes, CHUNK)) {
            yield* sql`
              INSERT INTO minutes ${sql.insert(chunk)}
              ON CONFLICT (device, point, minute) DO UPDATE SET
                min = MIN(minutes.min, excluded.min),
                max = MAX(minutes.max, excluded.max),
                sum = minutes.sum + excluded.sum,
                count = minutes.count + excluded.count`
          }
        })
      ),
    /** One point's buckets from every read (`readings`) or from the rollups (`minutes`). */
    buckets: bucketsOf,
    /** Delete reads older than `rawBefore` and rollups older than `minutesBefore` (Unix ms). */
    prune: (rawBefore: number, minutesBefore: number) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM readings WHERE ts < ${rawBefore}`
        yield* sql`DELETE FROM minutes WHERE minute < ${minutesBefore}`
        yield* sql`PRAGMA incremental_vacuum`
      })
  }
}

export type Store = ReturnType<typeof makeStore>
