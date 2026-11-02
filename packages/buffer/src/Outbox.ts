/**
 * The outbox table: northbound messages waiting for the broker, oldest first.
 * Rows are decoded with Schema on the way out (SQLite is a boundary), and
 * deletes return the ids they removed, so the caller's row count stays exact
 * even when overflow and draining delete concurrently.
 */
import { Effect, Schema } from "effect"
import { Migrator, SqlClient, SqlSchema } from "effect/sql"

export const OutboxRow = Schema.Struct({
  id: Schema.Int,
  topic: Schema.String,
  payload: Schema.String,
  qos: Schema.Literals([0, 1])
})
export type OutboxRow = typeof OutboxRow.Type

const RemovedRow = Schema.Struct({ id: Schema.Int })
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
  const oldestRows = SqlSchema.findAll({
    Request: Schema.Int,
    Result: OutboxRow,
    execute: (limit) => sql`SELECT id, topic, payload, qos FROM outbox ORDER BY id LIMIT ${limit}`
  })
  const removeRows = SqlSchema.findAll({
    Request: Schema.Array(Schema.Int),
    Result: RemovedRow,
    execute: (ids) => sql`DELETE FROM outbox WHERE ${sql.in("id", ids)} RETURNING id`
  })
  const dropOldestRows = SqlSchema.findAll({
    Request: Schema.Int,
    Result: RemovedRow,
    execute: (count) =>
      sql`DELETE FROM outbox WHERE id IN (SELECT id FROM outbox ORDER BY id LIMIT ${count}) RETURNING id`
  })

  return {
    count: Effect.map(countRows(undefined), (rows) => rows[0]?.n ?? 0),
    append: (topic: string, payload: string, qos: 0 | 1, createdAt: number) =>
      sql`INSERT INTO outbox (topic, payload, qos, created_at) VALUES (${topic}, ${payload}, ${qos}, ${createdAt})`.pipe(
        Effect.asVoid
      ),
    oldest: oldestRows,
    /** Delete the given rows; returns how many were still there. */
    remove: (ids: ReadonlyArray<number>) =>
      ids.length === 0 ? Effect.succeed(0) : Effect.map(removeRows(ids), (rows) => rows.length),
    /** Delete the `count` oldest rows; returns how many were deleted. */
    dropOldest: (count: number) => Effect.map(dropOldestRows(count), (rows) => rows.length)
  }
})

export type Outbox = Effect.Success<typeof makeOutbox>
