/**
 * The outbox table: northbound messages waiting for the broker, oldest first.
 * Rows are decoded with Schema on the way out (SQLite is a boundary), one by
 * one, so a row that does not decode is reported by id instead of failing
 * its whole batch. Deletes return the ids they removed.
 */
import { Effect, Result, Schema } from "effect"
import { Migrator, SqlClient, SqlSchema } from "effect/sql"

export const OutboxRow = Schema.Struct({
  id: Schema.Int,
  topic: Schema.String,
  payload: Schema.String,
  qos: Schema.Literals([0, 1])
})
export type OutboxRow = typeof OutboxRow.Type

const RemovedRow = Schema.Struct({ id: Schema.Int })
const decodeRow = Schema.decodeUnknownResult(OutboxRow)
const decodeId = Schema.decodeUnknownResult(RemovedRow)

/** The oldest rows after some id: the ones that decode, the ids of those that do not, and every id read, in order. */
export interface OldestRows {
  readonly rows: ReadonlyArray<OutboxRow>
  readonly unreadable: ReadonlyArray<number>
  readonly ids: ReadonlyArray<number>
}
const CountRow = Schema.Struct({ n: Schema.Int })

/** Schema migrations, run once each, in order, when the buffer opens. */
export const outboxMigrations = Migrator.fromRecord({
  "0001_create_outbox": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        payload TEXT NOT NULL,
        qos INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `
  })
})

/** Queries on the outbox of one open database. */
export const makeOutbox = (sql: SqlClient.SqlClient) => {
  const countRows = SqlSchema.findAll({
    Request: Schema.Int,
    Result: CountRow,
    execute: (after) => sql`SELECT COUNT(*) AS n FROM outbox WHERE id > ${after}`
  })
  const removeRows = SqlSchema.findAll({
    Request: Schema.Array(Schema.Int),
    Result: RemovedRow,
    execute: (ids) => sql`DELETE FROM outbox WHERE ${sql.in("id", ids)} RETURNING id`
  })
  const dropOldestRows = SqlSchema.findAll({
    Request: Schema.Struct({ count: Schema.Int, after: Schema.Int }),
    Result: RemovedRow,
    execute: ({ count, after }) =>
      sql`DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE id > ${after} ORDER BY id LIMIT ${count}) RETURNING id`
  })

  const oldest = (limit: number, after: number) =>
    Effect.map(
      sql`SELECT id, topic, payload, qos FROM outbox WHERE id > ${after} ORDER BY id LIMIT ${limit}`,
      (raw): OldestRows => {
        const rows: Array<OutboxRow> = []
        const unreadable: Array<number> = []
        const ids: Array<number> = []
        for (const row of raw) {
          const decoded = decodeRow(row)
          if (Result.isSuccess(decoded)) {
            rows.push(decoded.success)
            ids.push(decoded.success.id)
          } else {
            // `id` is the INTEGER PRIMARY KEY, so it always decodes; anything else would be skipped forever.
            const id = decodeId(row)
            if (Result.isSuccess(id)) {
              unreadable.push(id.success.id)
              ids.push(id.success.id)
            }
          }
        }
        return { rows, unreadable, ids }
      }
    )

  return {
    /** Rows with an id above `after` (0 for all of them). */
    count: (after = 0) => Effect.map(countRows(after), (rows) => rows[0]?.n ?? 0),
    append: (topic: string, payload: string, qos: 0 | 1, createdAt: number) =>
      sql`INSERT INTO outbox (topic, payload, qos, created_at) VALUES (${topic}, ${payload}, ${qos}, ${createdAt})`.pipe(
        Effect.asVoid
      ),
    /** The `limit` oldest rows with an id above `after`. */
    oldest,
    /** Delete the given rows; returns how many were still there. */
    remove: (ids: ReadonlyArray<number>) =>
      ids.length === 0 ? Effect.succeed(0) : Effect.map(removeRows(ids), (rows) => rows.length),
    /** Delete every row up to and including `id`. */
    removeThrough: (id: number) => sql`DELETE FROM outbox WHERE id <= ${id}`.pipe(Effect.asVoid),
    /** Delete the `count` oldest rows with an id above `after`; returns how many were deleted. */
    dropOldest: (count: number, after: number) => Effect.map(dropOldestRows({ count, after }), (rows) => rows.length),
    /** Return free pages to the file system (new files use `auto_vacuum = INCREMENTAL`; elsewhere a no-op). */
    vacuum: sql`PRAGMA incremental_vacuum`.pipe(Effect.asVoid)
  }
}

export type Outbox = ReturnType<typeof makeOutbox>
