/**
 * The gateway's recent log lines, kept in memory and served as `GET /api/logs`, so the warnings and errors behind
 * `status` and `events` (a decode problem, a refused write, why a config from the page did not start) can be read
 * without `docker logs`: `ot-gateway logs` prints them.
 *
 * An extra logger next to the stdout one (and OTLP's, when exported), never instead of it. It keeps the text the
 * stdout logger prints, or less: values are rendered as Effect's structured logger renders them (a `Redacted` is
 * `<redacted>`), the secrets the gateway knows (the broker password, `OT_GATEWAY_EDIT_TOKEN`) are replaced wherever
 * they appear, and long messages, causes and annotations are cut.
 *
 * Bounded twice over, for a Pi: warnings and errors in one ring, info lines in another, each with a line and a
 * byte budget, so a chatty start cannot push the warning that matters out. The gateway logs transitions, not states
 * (edge.md), so a few hundred lines are days of warnings. Debug and trace lines are not kept.
 */
import type { LogLevelFilter, LogLine, LogPage } from "@ot-gateway/api"
import type { GatewayConfig } from "@ot-gateway/core"
import { readBrokerPassword } from "@ot-gateway/mqtt"
import { Clock, Context, Effect, Layer, Logger, type LogLevel, Option, Redacted } from "effect"
import { editToken } from "./EditGuard.ts"

/** What one ring keeps at most. */
export interface RingLimits {
  readonly lines: number
  /** Bytes of text (string lengths, plus a fixed overhead per line), not the heap the objects take. */
  readonly bytes: number
}

export interface LogLimits {
  /** Warnings, errors and fatal lines. */
  readonly important: RingLimits
  readonly info: RingLimits
}

/**
 * 500 lines and 256 KB in all: 300 warnings and errors in 160 KB, 200 info lines in 96 KB. With the objects around
 * the text, well under half a megabyte of heap at its fullest.
 */
export const LOG_LIMITS: LogLimits = {
  important: { lines: 300, bytes: 160 * 1024 },
  info: { lines: 200, bytes: 96 * 1024 }
}

/** A message is cut after this many characters, a cause (its first lines) after `MAX_CAUSE`. */
export const MAX_MESSAGE = 1_000
export const MAX_CAUSE = 2_000
/** Annotations kept per line, and the characters of each value. */
export const MAX_ANNOTATIONS = 16
export const MAX_ANNOTATION = 200
/** Counted per line on top of its text: the id, time, level and the object around them. */
const LINE_OVERHEAD = 64

export const REDACTED = "<redacted>"

const kept: ReadonlySet<LogLevel.LogLevel> = new Set(["Info", "Warn", "Error", "Fatal"])

/** The levels each `?level=` lists. */
const levelsOf: Record<LogLevelFilter, ReadonlySet<string>> = {
  info: new Set(["INFO", "WARN", "ERROR", "FATAL"]),
  warn: new Set(["WARN", "ERROR", "FATAL"]),
  error: new Set(["ERROR", "FATAL"])
}

export interface LogQuery {
  readonly level?: LogLevelFilter | undefined
  /** Unix ms: only lines at or after it. */
  readonly since?: number | undefined
  /** A line id: only the lines after it. One this run never gave (the asker saw an earlier run): every line. */
  readonly after?: number | undefined
}

export interface GatewayLogsShape {
  /** The logger that fills the ring: add it to the current ones (`gatewayLogsLayer` does). */
  readonly logger: Logger.Logger<unknown, void>
  /** Secrets to replace wherever they appear in a line from now on; empty ones are ignored. */
  readonly addSecrets: (secrets: ReadonlyArray<Redacted.Redacted | string>) => void
  /** The lines kept, oldest first, filtered by `query`. */
  readonly page: (query?: LogQuery) => Effect.Effect<LogPage>
}

export class GatewayLogs extends Context.Service<GatewayLogs, GatewayLogsShape>()("@ot-gateway/gateway/GatewayLogs") {}

/** A value as text, never throwing: a logger must not fail the effect that logs. */
const textOf = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

interface Ring {
  readonly limits: RingLimits
  readonly lines: Array<LogLine>
  bytes: number
}

const sizeOf = (line: LogLine) => {
  let size = LINE_OVERHEAD + line.message.length + (line.cause?.length ?? 0)
  for (const [key, value] of Object.entries(line.annotations ?? {})) size += key.length + value.length
  return size
}

/** The ring, with lines that fit `limits`. */
export const makeGatewayLogs = (limits: LogLimits = LOG_LIMITS): GatewayLogsShape => {
  const important: Ring = { limits: limits.important, lines: [], bytes: 0 }
  const info: Ring = { limits: limits.info, lines: [], bytes: 0 }
  const secrets = new Set<string>()
  /** Lines recorded since start; also the id of the newest. */
  let total = 0
  let dropped = 0

  const scrub = (text: string) => {
    let clean = text
    for (const secret of secrets) clean = clean.replaceAll(secret, REDACTED)
    return clean
  }

  const add = (ring: Ring, line: LogLine) => {
    const size = sizeOf(line)
    ring.lines.push(line)
    ring.bytes += size
    while (ring.lines.length > ring.limits.lines || ring.bytes > ring.limits.bytes) {
      const oldest = ring.lines.shift()
      if (oldest === undefined) break
      ring.bytes -= sizeOf(oldest)
      dropped++
    }
  }

  const record = (options: Logger.Options<unknown>) => {
    if (!kept.has(options.logLevel)) return
    // As Effect's structured logger renders the line: a Redacted value is `<redacted>` here as on stdout.
    const structured = Logger.formatStructured.log(options)
    const message = Array.isArray(structured.message)
      ? structured.message.map(textOf).join(" ")
      : textOf(structured.message)
    let wasCut = false
    const take = (text: string, max: number) => {
      const clean = scrub(text)
      if (clean.length > max) wasCut = true
      return cut(clean, max)
    }
    const annotations: Record<string, string> = {}
    let annotationCount = 0
    for (const [key, value] of Object.entries(structured.annotations)) {
      if (annotationCount === MAX_ANNOTATIONS) {
        wasCut = true
        break
      }
      annotations[scrub(key).slice(0, MAX_ANNOTATION)] = take(textOf(value), MAX_ANNOTATION)
      annotationCount++
    }
    total++
    const line: LogLine = {
      id: total,
      at: options.date.getTime(),
      level: structured.level,
      message: take(message, MAX_MESSAGE),
      ...(annotationCount === 0 ? {} : { annotations }),
      ...(structured.cause === undefined ? {} : { cause: take(structured.cause, MAX_CAUSE) }),
      ...(wasCut ? { cut: true } : {})
    }
    add(options.logLevel === "Info" ? info : important, line)
  }

  return {
    logger: Logger.make((options) => {
      try {
        record(options)
      } catch {
        // A line that cannot be kept is still on stdout; the ring must never fail the effect that logs.
      }
    }),
    addSecrets: (values) => {
      for (const value of values) {
        const text = typeof value === "string" ? value : Redacted.value(value)
        if (text !== "") secrets.add(text)
      }
    },
    page: (query = {}) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const levels = levelsOf[query.level ?? "info"]
        const after = query.after !== undefined && query.after <= total ? query.after : undefined
        const matches = (line: LogLine) =>
          levels.has(line.level) &&
          (query.since === undefined || line.at >= query.since) &&
          (after === undefined || line.id > after)
        // Both rings are in id order: merge them.
        const lines: Array<LogLine> = []
        let left = 0
        let right = 0
        while (true) {
          const fromImportant = important.lines[left]
          const fromInfo = info.lines[right]
          if (fromImportant === undefined && fromInfo === undefined) break
          let next: LogLine | undefined
          if (fromInfo === undefined || (fromImportant !== undefined && fromImportant.id < fromInfo.id)) {
            next = fromImportant
            left++
          } else {
            next = fromInfo
            right++
          }
          if (next !== undefined && matches(next)) lines.push(next)
        }
        return {
          now,
          lines,
          maxLines: limits.important.lines + limits.info.lines,
          maxBytes: limits.important.bytes + limits.info.bytes,
          dropped
        }
      })
  }
}

/**
 * The ring as `GatewayLogs`, and its logger added to the loggers already in place (stdout, OTLP): provide it to the
 * gateway so every fiber it starts logs into the ring too.
 */
export const gatewayLogsLayer = (limits: LogLimits = LOG_LIMITS) =>
  Layer.provideMerge(
    Logger.layer(
      [
        Effect.gen(function* () {
          return (yield* GatewayLogs).logger
        })
      ],
      { mergeWithExisting: true }
    ),
    Layer.sync(GatewayLogs, () => makeGatewayLogs(limits))
  )

/**
 * The secrets a gateway running `config` knows: the broker password its `mqtt.passwordEnv` names and
 * `OT_GATEWAY_EDIT_TOKEN`, each when set. One that cannot be read is not known to the gateway either.
 */
export const knownSecrets = (config: GatewayConfig) =>
  Effect.gen(function* () {
    const password = yield* readBrokerPassword(config.mqtt).pipe(Effect.orElseSucceed(() => undefined))
    const token = yield* Effect.orElseSucceed(editToken, () => Option.none<Redacted.Redacted>())
    return [...(password === undefined ? [] : [password]), ...Option.toArray(token)]
  })
