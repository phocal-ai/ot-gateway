/**
 * Opening the outbox file. The connection is configured for an SD card on a
 * Pi that one gateway owns:
 *
 * - `locking_mode = EXCLUSIVE`: the first write takes the file's lock and
 *   keeps it until the connection closes, so a second gateway on the same
 *   config cannot drain the same outbox. It fails to open with
 *   `BufferLocked` instead.
 * - `busy_timeout` 200 ms: `node:sqlite` is synchronous, so a busy wait
 *   blocks the event loop. A lock is either ours for good or someone else's,
 *   so waiting longer does not help.
 * - WAL with `synchronous = NORMAL`: commits do not wait for an fsync, only
 *   checkpoints do. Safe against the gateway crashing; a power cut can lose
 *   the last commits before a checkpoint, which is the price for not
 *   stalling an SD card with one fsync per buffered value.
 * - `auto_vacuum = INCREMENTAL` on new files, so the file shrinks again after
 *   an outage. Existing files keep their mode: converting needs a full VACUUM.
 *
 * A file SQLite reports as corrupt, or whose schema the migrations cannot
 * handle, is moved aside under a timestamped name and a fresh one is opened.
 */
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Clock, Context, Effect, Exit, FileSystem, Layer, Option, Path, Schema, Scope } from "effect"
import { SqlClient } from "effect/sql"
import type { MigrationError } from "effect/sql/Migrator"
import type { SqlError } from "effect/sql/SqlError"
import { makeOutbox, outboxMigrations } from "./Outbox.ts"
import type { Outbox } from "./Outbox.ts"

/** Another process (a second gateway on the same config, say) holds the outbox file. */
export class BufferLocked extends Schema.TaggedError<BufferLocked>()("BufferLocked", {
  path: Schema.String,
  message: Schema.String
}) {}

/** The file is damaged or has a schema the migrations cannot handle; moving it aside helps. */
export class BufferUnusable extends Schema.TaggedError<BufferUnusable>()("BufferUnusable", {
  path: Schema.String,
  message: Schema.String
}) {}

/** The outbox could not be opened for another reason (a read-only directory, say). */
export class BufferOpenFailed extends Schema.TaggedError<BufferOpenFailed>()("BufferOpenFailed", {
  path: Schema.String,
  message: Schema.String
}) {}

export interface OutboxDatabase {
  readonly outbox: Outbox
  /** Write a consistent copy of the database to `destination`, from this connection. */
  readonly backup: (destination: string) => Effect.Effect<void, SqlError>
  /** Device and inode of the file when it was opened; `undefined` if they could not be read. */
  readonly identity: string | undefined
  readonly close: Effect.Effect<void>
}

const busyTimeout = "200 millis"

/** SQLite's primary result code behind a failed statement, read from the `node:sqlite` error. */
const sqliteResultCode = (error: SqlError): number | undefined => {
  const cause: unknown = error.reason.cause
  if (typeof cause !== "object" || cause === null || !("errcode" in cause)) return undefined
  return typeof cause.errcode === "number" ? cause.errcode & 0xff : undefined
}

/** SQLITE_CORRUPT (11) or SQLITE_NOTADB (26): the file is damaged, or not a database at all. */
export const isCorrupt = (error: SqlError): boolean => {
  const code = sqliteResultCode(error)
  return code === 11 || code === 26
}

/** Device and inode of `path`, or `undefined` when it does not exist (or the platform has no inodes). */
export const fileIdentity = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const info = yield* Effect.option(fs.stat(path))
  return Option.match(info, {
    onNone: () => undefined,
    onSome: (stat) => Option.match(stat.ino, { onNone: () => undefined, onSome: (ino) => `${stat.dev}:${ino}` })
  })
})

const configure = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  // Before anything touches the file, so the lock and the vacuum mode apply from the start.
  yield* sql`PRAGMA locking_mode = EXCLUSIVE`
  const [pages] = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`
  if (pages?.page_count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL`
  yield* sql`PRAGMA journal_mode = WAL`
  yield* sql`PRAGMA synchronous = NORMAL`
  // A write takes the exclusive lock now rather than at the first buffered value.
  yield* sql.withTransaction(Effect.void)
})

/** Open, configure and migrate the database at `path`, once. */
const openOnce = (
  path: string
): Effect.Effect<OutboxDatabase, BufferLocked | BufferUnusable | BufferOpenFailed, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const opened = Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(
        // Fresh: a reopen must get a new connection, not the memoized one.
        Layer.fresh(SqliteClient.layer({ filename: path, busyTimeout, disableWAL: true })),
        scope
      )
      const sql = Context.get(context, SqliteClient.SqliteClient)
      yield* configure(sql)
      yield* SqliteMigrator.run({ loader: outboxMigrations }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
      return sql
    }).pipe(
      Effect.catchTags({
        SqlError: (error) => {
          if (error.reason._tag === "LockTimeoutError") {
            return Effect.fail(
              new BufferLocked({
                path,
                message: `buffer file ${path} is locked by another process (a second gateway on the same config?)`
              })
            )
          }
          return Effect.fail(
            isCorrupt(error)
              ? new BufferUnusable({ path, message: error.message })
              : new BufferOpenFailed({ path, message: error.message })
          )
        },
        MigrationError: (error: MigrationError) =>
          Effect.fail(new BufferUnusable({ path, message: `migrations failed (${error.kind}): ${error.message}` }))
      }),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void))
    )
    const sql = yield* opened
    return {
      outbox: makeOutbox(sql),
      backup: (destination: string) => Effect.asVoid(sql.backup(destination)),
      identity: yield* fileIdentity(path),
      close: Scope.close(scope, Exit.void)
    }
  })

/** Rename the database and its WAL files to `<path>.corrupt-<timestamp>`; returns the new name. */
const moveAside = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const stamp = new Date(yield* Clock.currentTimeMillis).toISOString().replace(/[:.]/g, "-")
  const aside = `${path}.corrupt-${stamp}`
  for (const suffix of ["", "-wal", "-shm"]) {
    if (yield* fs.exists(path + suffix)) yield* fs.rename(path + suffix, aside + suffix)
  }
  return aside
})

/**
 * Open the outbox at `path`, creating its directory. An unusable file is
 * moved aside and replaced by a fresh one. Fails with the reason when even
 * that does not work, so the caller can run without a buffer.
 */
export const openDatabase = (
  path: string
): Effect.Effect<OutboxDatabase, BufferLocked | BufferOpenFailed, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    yield* fs
      .makeDirectory(paths.dirname(path), { recursive: true })
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(new BufferOpenFailed({ path, message: `cannot create the directory: ${error.message}` }))
        )
      )
    return yield* openOnce(path).pipe(
      Effect.catchTag("BufferUnusable", (unusable) =>
        Effect.gen(function* () {
          const aside = yield* moveAside(path).pipe(
            Effect.catchTag("PlatformError", (error) =>
              Effect.fail(
                new BufferOpenFailed({ path, message: `${unusable.message}; moving it aside failed: ${error.message}` })
              )
            )
          )
          yield* Effect.logError("buffer file was unusable, moved it aside and started a new one").pipe(
            Effect.annotateLogs({ path, movedTo: aside, error: unusable.message })
          )
          return yield* openOnce(path).pipe(
            Effect.catchTag("BufferUnusable", (again) =>
              Effect.fail(new BufferOpenFailed({ path, message: again.message }))
            )
          )
        })
      )
    )
  })
