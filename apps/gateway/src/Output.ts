/**
 * Where the CLI's output goes. A result goes to stdout. With `--json`, stdout carries the JSON result and nothing
 * else: `main.ts` sends the `Console` (help, progress, banners) to stderr and results to `ResultConsole`, so `ot-gateway check --json | jq` and an
 * agent reading stdout always get one parseable document, a usage mistake included.
 */
import { describeFailure } from "@ot-gateway/core"
import { Cause, Console, Context, Effect, Predicate, Result, Schema } from "effect"
import type { EventEmitter } from "node:events"
import { CliError } from "effect/cli"

/** `--json` anywhere on the command line, as the CLI's flags take it. */
export const isJsonMode = (argv: ReadonlyArray<string>) => argv.includes("--json")

/**
 * Where results go when that is not the `Console`: `--json` mode sets it to the process's console (stdout) and
 * points the `Console` at stderr. Unset, results are `Console.log` lines like everything else, as tests see them.
 */
export const ResultConsole = Context.Reference<Console.Console | undefined>("@ot-gateway/gateway/ResultConsole", {
  defaultValue: () => undefined
})

/** A result: on stdout, and with `--json` the only thing there. */
export const printResult = (text: string) =>
  Effect.flatMap(ResultConsole, (results) =>
    results === undefined
      ? Console.log(text)
      : Effect.sync(() => {
          results.log(text)
        })
  )

export const printJson = (value: unknown) => printResult(JSON.stringify(value, null, 2))

const twoDigits = (value: number) => String(value).padStart(2, "0")

/**
 * A moment as the CLI prints it, in this machine's time zone: `12:18:20` on the same day as `now`, with the date
 * before it (`2026-11-09 12:18:20`) otherwise. Never epoch milliseconds: people read these.
 */
export const localTime = (at: number | Date, now: number | Date = at) => {
  const moment = new Date(at)
  const today = new Date(now)
  const time = `${twoDigits(moment.getHours())}:${twoDigits(moment.getMinutes())}:${twoDigits(moment.getSeconds())}`
  if (moment.toDateString() === today.toDateString()) return time
  return `${moment.getFullYear()}-${twoDigits(moment.getMonth() + 1)}-${twoDigits(moment.getDate())} ${time}`
}

/**
 * A moment in this machine's time zone, as `--json` gives it next to the Unix ms: ISO 8601 with milliseconds and
 * the UTC offset of that moment (`2026-11-24T14:21:03.109+01:00`, `+00:00` rather than `Z`). The same clock as
 * `localTime`, so the JSON and the lines agree.
 */
export const localIsoTime = (at: number | Date) => {
  const moment = new Date(at)
  const offset = -moment.getTimezoneOffset()
  const sign = offset < 0 ? "-" : "+"
  const offsetText = `${sign}${twoDigits(Math.floor(Math.abs(offset) / 60))}:${twoDigits(Math.abs(offset) % 60)}`
  const date = `${String(moment.getFullYear()).padStart(4, "0")}-${twoDigits(moment.getMonth() + 1)}-${twoDigits(moment.getDate())}`
  const time = `${twoDigits(moment.getHours())}:${twoDigits(moment.getMinutes())}:${twoDigits(moment.getSeconds())}`
  return `${date}T${time}.${String(moment.getMilliseconds()).padStart(3, "0")}${offsetText}`
}

/** The IANA name of this machine's time zone (`Europe/Vienna`), the one `localTime` and `localIsoTime` use. */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The `Console` of `--json` mode: what it is asked to print goes to stderr; the rest is `base`'s own. */
export const stderrConsole = (base: Console.Console): Console.Console => ({
  assert: (condition, ...args) => base.assert(condition, ...args),
  clear: () => base.clear(),
  count: (label) => base.count(label),
  countReset: (label) => base.countReset(label),
  debug: (...args) => base.debug(...args),
  dir: (...args) => base.error(...args),
  dirxml: (...args) => base.error(...args),
  error: (...args) => base.error(...args),
  group: (...args) => base.group(...args),
  groupCollapsed: (...args) => base.groupCollapsed(...args),
  groupEnd: () => base.groupEnd(),
  info: (...args) => base.error(...args),
  log: (...args) => base.error(...args),
  table: (data) => base.error(data),
  time: (label) => base.time(label),
  timeEnd: (label) => base.timeEnd(label),
  timeLog: (label, ...args) => base.timeLog(label, ...args),
  trace: (...args) => base.trace(...args),
  warn: (...args) => base.warn(...args)
})

/** A usage mistake: an unknown command or flag, a missing or malformed argument. */
export const isUsageError = (error: CliError.CliError): error is CliError.ShowHelp =>
  error._tag === "ShowHelp" && error.errors.length > 0

/** Exit code of a usage mistake, as most command lines have it; every other failure exits with 1. */
export const USAGE_EXIT_CODE = 2

/**
 * A command run without what it needs to do its job, found before it does anything: `init` with no terminal to ask
 * and no answers given. Like a usage mistake it exits with 2, and its `--json` names the flags that are `missing`.
 */
export class UsageMistake extends Schema.TaggedError<UsageMistake>()("UsageMistake", {
  message: Schema.String,
  code: Schema.String,
  missing: Schema.Array(Schema.String),
  hint: Schema.String
}) {}

/** Whether a failure exits with 2: a usage mistake the CLI found, or one a command found (`UsageMistake`). */
export const exitsAsUsage = (error: unknown) =>
  (CliError.isCliError(error) && isUsageError(error)) || Predicate.isTagged(error, "UsageMistake")

/**
 * What `--json` prints for an expected failure besides `ok` and `error`: the fields an agent acts on when the
 * failure has them, `code` (what kind of failure), `issues` (each mistake on its own, with where it is),
 * `missing` (the flags to add), `hint` (what to run) and `url` (the address it asked).
 */
export const failureFields = (error: unknown): Readonly<Record<string, unknown>> => {
  if (!Predicate.isObject(error)) return {}
  const fields: Record<string, unknown> = {}
  if (Predicate.hasProperty(error, "code") && typeof error.code === "string") fields["code"] = error.code
  if (Predicate.hasProperty(error, "issues") && Array.isArray(error.issues) && error.issues.length > 0) {
    fields["issues"] = error.issues
  }
  if (Predicate.hasProperty(error, "missing") && Array.isArray(error.missing)) fields["missing"] = error.missing
  if (Predicate.hasProperty(error, "hint") && typeof error.hint === "string") fields["hint"] = error.hint
  // The address a command asked (the status page's), when the error knows it.
  if (Predicate.hasProperty(error, "url") && typeof error.url === "string") fields["url"] = error.url
  return fields
}

/** What `--json` prints for a usage mistake. */
export const usageFailure = (error: CliError.ShowHelp) => ({
  ok: false,
  code: "usage",
  error: error.errors.map((each) => each.message).join("; "),
  hint: `ot-gateway ${[...error.commandPath.slice(1), "--help"].join(" ")} lists the commands and flags`
})

/**
 * How a failed command ends. A one-shot command (check, discover, import, …) prints an expected failure (a
 * config mistake, nothing found) as one plain line on stderr, `error: <message>`: it is the command's answer,
 * not a log line, so it carries no timestamp or fiber id. A defect, which is a bug, is printed with its whole
 * cause, to report it. The long-running ones (run, demo) log both instead, as everything else they say, so a
 * failed start reads like the rest of the gateway's log under Compose or systemd. With --json, the command has
 * printed an expected failure as JSON on stdout already, and a usage mistake is printed so here; neither is
 * printed a second time. The CLI has shown a usage mistake with the help already. The exit code is 2 for a
 * usage mistake (Shutdown.ts) and 1 for the rest.
 */
export const reportFailure =
  (options: { readonly json: boolean; readonly longRunning: boolean }) =>
  <E extends { readonly message: string }>(cause: Cause.Cause<E>) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.void
    const error = Cause.findError(cause)
    if (Result.isFailure(error) || Cause.hasDies(cause)) {
      return options.longRunning
        ? Effect.logError(cause)
        : Console.error(
            `error: an unexpected failure, a bug in ot-gateway; please report it with this:\n${Cause.pretty(cause)}`
          )
    }
    if (CliError.isCliError(error.success)) {
      return options.json && isUsageError(error.success) ? printJson(usageFailure(error.success)) : Effect.void
    }
    if (options.json) return Effect.void
    return options.longRunning
      ? Effect.logError(describeFailure(error.success))
      : Console.error(withHint(failureLine(describeFailure(error.success)), failureFields(error.success)["hint"]))
  }

/** A failure's line with its hint, what to check next, on the line below, as `--json` has it in `hint`. */
export const withHint = (line: string, hint: unknown) => (typeof hint === "string" ? `${line}\n  ${hint}` : line)

/** An expected failure of a one-shot command, as stderr shows it. */
export const failureLine = (message: string) => `error: ${message}`

/** A path or word as one argument of a printed command line: as it is when that is safe, else in single quotes. */
export const shellArgument = (value: string) =>
  /^[\w./:@%+=,-]+$/.test(value) && !value.startsWith("-") ? value : `'${value.replaceAll("'", `'\\''`)}'`

/** What later write errors on a pipe already found closed go to: nowhere, and no uncaught error. */
const ignore = () => {}

/**
 * Succeeds when `stream` (stdout) is closed by its reader: `ot-gateway watch | head` closes the pipe after a few
 * lines, and the next write fails with EPIPE. Raced against a command, that ends it as finished, exit code 0, with
 * its scopes closed (the broker connection too), instead of an uncaught error and exit code 1. Any other error on
 * the stream is a defect, as it would have been without this listener.
 */
export const stdoutClosed = (stream: Pick<EventEmitter, "on" | "off">) =>
  Effect.callback<void>((resume) => {
    const onError = (error: unknown) => {
      // Later writes to the closed pipe fail too; nobody reads them, and the race is decided by this first one.
      stream.off("error", onError)
      stream.on("error", ignore)
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
      resume(code === "EPIPE" ? Effect.void : Effect.die(error))
    }
    stream.on("error", onError)
    return Effect.sync(() => {
      stream.off("error", onError)
    })
  })
