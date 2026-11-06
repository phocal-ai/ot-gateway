/**
 * Where the CLI's output goes. A result goes to stdout. With `--json`, stdout carries the JSON result and nothing
 * else: `main.ts` sends the `Console` (help, progress, banners) to stderr and results to `ResultConsole`, so `ot-gateway check --json | jq` and an
 * agent reading stdout always get one parseable document, a usage mistake included.
 */
import { Console, Context, Effect } from "effect"
import type { CliError } from "effect/cli"

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
