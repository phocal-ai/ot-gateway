/**
 * Where the CLI's output goes. A result goes to stdout. With `--json`, stdout carries the JSON result and nothing
 * else: `main.ts` sends the `Console` (help, progress, banners) to stderr and results to `ResultConsole`, so `ot-gateway check --json | jq` and an
 * agent reading stdout always get one parseable document, a usage mistake included.
 */
import { Cause, Console, Context, Effect, Result } from "effect"
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
      ? Effect.logError(error.success.message)
      : Console.error(failureLine(error.success.message))
  }

/** An expected failure of a one-shot command, as stderr shows it. */
export const failureLine = (message: string) => `error: ${message}`
