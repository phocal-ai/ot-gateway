/**
 * `GET /api/logs`: the gateway's recent log lines, from a small ring it keeps in memory, so an operator (or an agent
 * over SSH without the Docker socket) can read the warnings and errors behind `status` and `events` without
 * `docker logs`. The ring holds the same text the gateway writes to stdout, or less: secrets redacted, long lines cut.
 */
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

/** The levels a line can have, from least to most severe, as Effect's logger names them. */
export const LOG_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const

/** The least severe level `?level=` asks for: `warn` is warnings and errors. */
export const LogLevelFilter = Schema.Literals(["info", "warn", "error"])
export type LogLevelFilter = typeof LogLevelFilter.Type

/** One line the gateway logged. */
export const LogLine = Schema.Struct({
  /** Counts from 1 since the gateway started: `?after=` takes it. */
  id: Schema.Number,
  /** Unix ms on the gateway's wall clock. */
  at: Schema.Number,
  /** `INFO`, `WARN`, `ERROR`, ... (a string, so a level added later still decodes). */
  level: Schema.String,
  message: Schema.String,
  /** The line's annotations (`device`, `error`, ...), each value as text. */
  annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** The failure behind the line, when it carried one: its first lines. */
  cause: Schema.optionalKey(Schema.String),
  /** The ring cut the message, the cause or an annotation (stdout has it whole). */
  cut: Schema.optionalKey(Schema.Boolean)
})
export type LogLine = typeof LogLine.Type

/**
 * The lines the gateway keeps, oldest first, filtered by the query. The ring keeps warnings and errors apart from
 * info lines, each with its own budget, so a chatty start cannot push a warning out; `dropped` counts the lines it
 * let go since it started, so a gap is visible.
 */
export const LogPage = Schema.Struct({
  /** Unix ms on the gateway's clock when the answer was made. */
  now: Schema.Number,
  lines: Schema.Array(LogLine),
  /** At most this many lines are kept (warnings and errors, and info, together). */
  maxLines: Schema.Number,
  /** And at most about this many bytes of text. */
  maxBytes: Schema.Number,
  dropped: Schema.Number
})
export type LogPage = typeof LogPage.Type

export class LogsGroup extends HttpApiGroup.make("logs").add(
  HttpApiEndpoint.get("logs", "/api/logs", {
    query: {
      /** The least severe level to list: `info` (everything kept), `warn` or `error`. */
      level: Schema.optional(LogLevelFilter),
      /** Unix ms: only lines at or after it. */
      since: Schema.optional(Schema.FiniteFromString),
      /**
       * A line id: only the lines after it, for a client that follows. An id the gateway has not given yet means it
       * restarted (its ids start over at 1): then every line it keeps.
       */
      after: Schema.optional(Schema.FiniteFromString)
    },
    success: LogPage
  })
) {}
