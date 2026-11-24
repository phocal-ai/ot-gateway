/**
 * `ot-gateway logs`: the running gateway's recent log lines, from the ring it keeps in memory (`/api/logs`,
 * LogRing.ts), for an operator or an agent on the machine without access to `docker logs`. One line each: local
 * clock time, level, message and annotations, with the first lines of a failure's cause below it. `--follow` prints
 * what comes, as `events --follow` does. A gateway from before the ring says so, instead of a decode error.
 */
import { type LogLevelFilter, type LogLine, LogPage } from "@ot-gateway/api"
import { Console, Effect, type FileSystem, Option, Result, Schema } from "effect"
import type { HttpClientResponse } from "effect/http"
import { withoutControls } from "./Discover.ts"
import { checkIdentity, gatewayName, type GatewayTarget } from "./GatewayTarget.ts"
import { jsonLineWithLocalTimes, printJsonWithLocalTimes } from "./JsonTimes.ts"
import { localTime, printResult } from "./Output.ts"
import {
  askGateway,
  fetchGatewayStatus,
  FOLLOW_INTERVAL,
  type GatewayAnswerUnreadable,
  type GatewayUnreachable
} from "./StatusReport.ts"

/** The gateway answered, but it is older than the logs command: it serves no `/api/logs`. */
export class LogsUnsupported extends Schema.TaggedError<LogsUnsupported>()("LogsUnsupported", {
  url: Schema.String,
  message: Schema.String
}) {}

/** Lines of a cause printed under its line; `--json` has all the gateway kept. */
export const CAUSE_LINES = 4

/**
 * Whether an answer says the endpoint is not there: a 404, or a page that is not JSON (the status page's app, which
 * an older gateway serves for any path it does not know).
 */
export const notServed = (response: HttpClientResponse.HttpClientResponse) =>
  response.status === 404 || (response.status === 200 && !(response.headers["content-type"] ?? "").includes("json"))

const decodeLogPage = Schema.decodeUnknownEffect(LogPage)

/**
 * The lines the gateway at `url` keeps, filtered by `query`, within three seconds; none from a gateway older than
 * `/api/logs`. The answer is taken whole and decoded here, so an older gateway's 404 or app page is told apart from
 * a decode error.
 */
export const fetchGatewayLogs = (
  url: string,
  query: { readonly level?: LogLevelFilter; readonly since?: number; readonly after?: number } = {}
): Effect.Effect<Option.Option<LogPage>, GatewayUnreachable | GatewayAnswerUnreadable, FileSystem.FileSystem> =>
  askGateway(url, (client) =>
    Effect.gen(function* () {
      const response = yield* client.logs.logs({ query, responseMode: "response-only" })
      if (notServed(response)) return Option.none<LogPage>()
      return Option.some(yield* decodeLogPage(yield* response.json))
    })
  )

/** `device=energy-meter error="connection refused"`: a value with a space or a quote is quoted. */
const annotationText = (annotations: LogLine["annotations"]) =>
  Object.entries(annotations ?? {})
    .map(([key, value]) => `${key}=${/[\s"=]/.test(value) || value === "" ? JSON.stringify(value) : value}`)
    .join(" ")

/** One log line as printed: time, level, message, annotations; the cause's first lines under it. */
export const formatLogLine = (line: LogLine, now: number) => {
  const time = localTime(line.at, now)
  const annotations = annotationText(line.annotations)
  const head = withoutControls(
    `${time}  ${line.level.padEnd(5)}  ${line.message}${annotations === "" ? "" : `  ${annotations}`}`
  )
  if (line.cause === undefined) return head
  const indent = " ".repeat(time.length + 2)
  const causeLines = line.cause.split("\n").filter((text) => text.trim() !== "")
  const shown = causeLines.slice(0, CAUSE_LINES).map((text) => `${indent}${withoutControls(text)}`)
  const more =
    causeLines.length > CAUSE_LINES ? [`${indent}(${causeLines.length - CAUSE_LINES} more; --json has them)`] : []
  return [head, ...shown, ...more].join("\n")
}

const levelWords: Record<LogLevelFilter, string> = {
  info: "log lines",
  warn: "warnings and errors",
  error: "errors"
}

/** The lines of a page as `logs` prints them, with a note when the window reaches past what the gateway kept. */
export const formatLogs = (
  page: LogPage,
  options: { readonly since: string; readonly sinceMs: number; readonly level: LogLevelFilter }
) => {
  const window = options.since === "all" ? "everything it keeps" : `the last ${options.since}`
  if (page.lines.length === 0) return `  no ${levelWords[options.level]} in ${window}`
  const lines = page.lines.map((line) => formatLogLine(line, page.now))
  const oldest = page.lines[0]
  const reachesBack = oldest !== undefined && page.now - options.sinceMs < oldest.at
  return [
    ...(page.dropped > 0 && reachesBack
      ? [`(the gateway keeps its latest ${page.maxLines} lines; ${page.dropped} older ones were let go)`]
      : []),
    ...lines
  ].join("\n")
}

export interface LogsOptions {
  readonly since: string
  readonly sinceMs: number
  readonly level: LogLevelFilter
  readonly json?: boolean
  /** Go on printing new lines as they come, until interrupted (Ctrl-C) or for `seconds`. */
  readonly follow?: boolean
  readonly seconds?: number | undefined
}

/**
 * Prints the gateway's log lines of the last `since` (`10m`, `all`) at `level` or above, oldest first, after the
 * gateway's name; with `follow`, then each new one as it comes. With `json`, a document
 * `{ok, gateway, now, from, maxLines, maxBytes, dropped, lines}`, or with `follow` one line per line (NDJSON).
 */
export const logsReport = Effect.fn("logsReport")(function* (target: GatewayTarget, options: LogsOptions) {
  const status = yield* fetchGatewayStatus(target.url, "none")
  yield* checkIdentity(target, status)
  const gateway = { site: status.site, building: status.building, id: status.id }
  const since = Number.isFinite(options.sinceMs) ? status.now - options.sinceMs : undefined
  const answer = yield* fetchGatewayLogs(target.url, {
    level: options.level,
    ...(since === undefined ? {} : { since })
  })
  if (Option.isNone(answer)) {
    return yield* new LogsUnsupported({
      url: target.url,
      message: `this gateway is older than the logs command: ${gatewayName(gateway)} at ${target.url}${status.host === undefined ? "" : ` runs ${status.host.version} and`} keeps no log lines to ask for. Upgrade it (docs/operations.md, "Upgrade"), or read its log in its folder: docker compose logs gateway --since 10m`
    })
  }
  const page = answer.value
  if (options.json === true && options.follow !== true) {
    return yield* printJsonWithLocalTimes({
      ok: true,
      gateway,
      now: page.now,
      from: Math.max(page.now - options.sinceMs, status.since),
      maxLines: page.maxLines,
      maxBytes: page.maxBytes,
      dropped: page.dropped,
      lines: page.lines
    })
  }
  if (options.json === true) {
    for (const line of page.lines) yield* printResult(jsonLineWithLocalTimes(line))
  } else {
    const window =
      options.follow === true
        ? options.seconds === undefined
          ? "then what comes (Ctrl-C to stop)"
          : `then what comes for ${options.seconds} s`
        : ""
    yield* printResult(
      `${gatewayName(gateway)} at ${target.url}: ${levelWords[options.level]}${window === "" ? "" : `, ${window}`}`
    )
    yield* printResult(formatLogs(page, options))
  }
  if (options.follow !== true) return
  const follow = followLogs(
    (after) => fetchGatewayLogs(target.url, { level: options.level, after }),
    page.lines.at(-1)?.id ?? 0,
    { json: options.json === true }
  )
  if (options.seconds === undefined) return yield* follow
  yield* Effect.timeoutOrElse(follow, { duration: `${options.seconds} seconds`, orElse: () => Effect.void })
})

/**
 * Asks `fetchAfter` for the lines after `lastId` every `FOLLOW_INTERVAL` and prints each new one, until interrupted.
 * A gateway that stops answering, or one that answers without logs or in a form this CLI cannot read (replaced by
 * another version), is said once on
 * stderr, and once more when it is back; one that restarted counts its ids from 1 again, which the gateway answers
 * with everything it keeps, and that is said too.
 */
export const followLogs = Effect.fn("followLogs")(function* <R>(
  fetchAfter: (after: number) => Effect.Effect<Option.Option<LogPage>, GatewayUnreachable | GatewayAnswerUnreadable, R>,
  lastId: number,
  options: { readonly json: boolean }
) {
  let last = lastId
  let away = false
  while (true) {
    yield* Effect.sleep(FOLLOW_INTERVAL)
    const asked = yield* fetchAfter(last).pipe(
      Effect.map(
        Option.match({
          onNone: () => Result.fail("the gateway at that address serves no logs now (an older version?)"),
          onSome: (page) => Result.succeed(page)
        })
      ),
      Effect.catchTags({
        GatewayUnreachable: (error) => Effect.succeed(Result.fail(error.message)),
        GatewayAnswerUnreadable: (error) => Effect.succeed(Result.fail(error.message))
      })
    )
    if (Result.isFailure(asked)) {
      if (!away) yield* Console.error(`lost the gateway, asking again: ${asked.failure}`)
      away = true
      continue
    }
    const answer = asked.success
    if (away) yield* Console.error("the gateway answers again")
    away = false
    const first = answer.lines[0]
    if (first !== undefined && first.id <= last) yield* Console.error("the gateway restarted: its log starts over")
    for (const line of answer.lines) {
      yield* printResult(options.json ? jsonLineWithLocalTimes(line) : formatLogLine(line, answer.now))
    }
    last = answer.lines.at(-1)?.id ?? last
  }
})
