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

/** The oldest rows: the ones that decode, and the ids of those that do not. */
export interface OldestRows {
  readonly rows: ReadonlyArray<OutboxRow>
  readonly unreadable: ReadonlyArray<number>
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

export const makeOutbox = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const countRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CountRow,
    execute: () => sql`SELECT COUNT(*) AS n FROM outbox`
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

  const oldest = (limit: number) =>
    Effect.map(sql`SELECT id, topic, payload, qos FROM outbox ORDER BY id LIMIT ${limit}`, (raw): OldestRows => {
      const rows: Array<OutboxRow> = []
      const unreadable: Array<number> = []
      for (const row of raw) {
        const decoded = decodeRow(row)
        if (Result.isSuccess(decoded)) rows.push(decoded.success)
        else {
          // `id` is the INTEGER PRIMARY KEY, so it always decodes; anything else would be skipped forever.
          const id = decodeId(row)
          if (Result.isSuccess(id)) unreadable.push(id.success.id)
        }
      }
      return { rows, unreadable }
    })

  return {
    count: Effect.map(countRows(undefined), (rows) => rows[0]?.n ?? 0),
    append: (topic: string, payload: string, qos: 0 | 1, createdAt: number) =>
      sql`INSERT INTO outbox (topic, payload, qos, created_at) VALUES (${topic}, ${payload}, ${qos}, ${createdAt})`.pipe(
        Effect.asVoid
      ),
    oldest,
    /** Delete the given rows; returns how many were still there. */
    remove: (ids: ReadonlyArray<number>) =>
      ids.length === 0 ? Effect.succeed(0) : Effect.map(removeRows(ids), (rows) => rows.length),
    /** Delete the `count` oldest rows with an id above `after`; returns how many were deleted. */
    dropOldest: (count: number, after: number) => Effect.map(dropOldestRows({ count, after }), (rows) => rows.length)
  }
})

export type Outbox = Effect.Success<typeof makeOutbox>
