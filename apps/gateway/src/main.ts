#!/usr/bin/env -S node --max-semi-space-size=4
/**
 * OT Gateway entry point: the `ot-gateway` command line (see Cli.ts).
 *
 *   node apps/gateway/src/main.ts demo
 *   node apps/gateway/src/main.ts run path/to/gateway.json
 *   node apps/gateway/src/main.ts check path/to/gateway.json
 *   node apps/gateway/src/main.ts discover path/to/gateway.json
 *   node apps/gateway/src/main.ts init | watch | status
 *   node apps/gateway/src/main.ts --help
 *
 * Run it with `--max-semi-space-size=4` (the shebang and `pnpm gateway` do):
 * V8's default young generation reserves about 40 MB more memory than the
 * gateway's allocation rate needs, at no measurable CPU cost.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Cause, Console, Effect, Logger, Result } from "effect"
import { identity } from "effect/Function"
import { CliError } from "effect/cli"
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net"
import { runCli } from "./Cli.ts"
import { loadEnvFile } from "./EnvFile.ts"
import { isJsonMode, isUsageError, printJson, ResultConsole, stderrConsole, usageFailure } from "./Output.ts"
import { gatewayTeardown } from "./Shutdown.ts"

// A broker or device named by host name may have several addresses (localhost: 127.0.0.1 and ::1). Node tries
// them in turn and abandons each but the last after 250 ms, which a busy event loop (a loaded Pi, emulation)
// can pass before it has even seen the connection succeed; the gateway then never reaches a broker that
// listens on the first address. Two seconds per address, well inside the 10 s connect timeout.
setDefaultAutoSelectFamilyAttemptTimeout(2000)

/**
 * How a failed run ends. An expected failure (a config mistake, a port in use) is logged as its message and
 * nothing else: a stack trace into Effect's internals does not help anyone fix a config. A defect, which is a
 * bug, is logged with its whole cause. Both go through the logger, as the runtime's own report did. With --json,
 * the command has printed an expected failure as JSON on stdout already, and a usage mistake is printed so here;
 * neither is logged a second time. The exit code is 2 for a usage mistake (Shutdown.ts) and 1 for the rest.
 */
const reportFailure = <E extends { readonly message: string }>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void
  const error = Cause.findError(cause)
  if (Result.isFailure(error) || Cause.hasDies(cause)) return Effect.logError(cause)
  if (CliError.isCliError(error.success)) {
    // The CLI has printed the mistake with the help already (to stderr with --json).
    return json && isUsageError(error.success) ? printJson(usageFailure(error.success)) : Effect.void
  }
  return json ? Effect.void : Effect.logError(error.success.message)
}

// Before anything reads process.env: the broker password and OTEL_* variables of the folder's ot-gateway.env,
// then of the file OT_GATEWAY_ENV_FILE names (the image names /etc/ot-gateway/gateway.env, the layout before
// the folder), each only when it is there.
loadEnvFile()
const extraEnvFile = process.env["OT_GATEWAY_ENV_FILE"]
if (extraEnvFile !== undefined && extraEnvFile !== "") loadEnvFile(extraEnvFile)

const argv = process.argv.slice(2)
const json = isJsonMode(argv)

runCli(argv).pipe(
  Effect.tapCause(reportFailure),
  // --json: stdout is the JSON result alone (Output.ts), so help, banners and progress go to stderr.
  json
    ? (effect) =>
        effect.pipe(
          Effect.updateService(Console.Console, stderrConsole),
          Effect.provideService(ResultConsole, globalThis.console)
        )
    : identity,
  // Logs, the final failure among them, go to stderr: stdout is for results, so `check --json | jq` gets JSON only.
  Effect.provideService(Logger.LogToStderr, true),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ teardown: gatewayTeardown, disableErrorReporting: true })
)
