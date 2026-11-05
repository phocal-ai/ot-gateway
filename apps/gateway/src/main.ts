#!/usr/bin/env -S node --max-semi-space-size=4
/**
 * OT Gateway entry point: the `ot-gateway` command line (see Cli.ts).
 *
 *   node apps/gateway/src/main.ts demo
 *   node apps/gateway/src/main.ts run path/to/gateway.json
 *   node apps/gateway/src/main.ts check path/to/gateway.json
 *   node apps/gateway/src/main.ts discover path/to/gateway.json
 *   node apps/gateway/src/main.ts --help
 *
 * Run it with `--max-semi-space-size=4` (the shebang and `pnpm gateway` do):
 * V8's default young generation reserves about 40 MB more memory than the
 * gateway's allocation rate needs, at no measurable CPU cost.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Cause, Effect, Result } from "effect"
import { CliError } from "effect/cli"
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net"
import { runCli } from "./Cli.ts"
import { gatewayTeardown } from "./Shutdown.ts"

// A broker or device named by host name may have several addresses (localhost: 127.0.0.1 and ::1). Node tries
// them in turn and abandons each but the last after 250 ms, which a busy event loop (a loaded Pi, emulation)
// can pass before it has even seen the connection succeed; the gateway then never reaches a broker that
// listens on the first address. Two seconds per address, well inside the 10 s connect timeout.
setDefaultAutoSelectFamilyAttemptTimeout(2000)

/**
 * How a failed run ends. An expected failure (a config mistake, a port in use) is logged as its message and
 * nothing else: a stack trace into Effect's internals does not help anyone fix a config. A defect, which is a
 * bug, is logged with its whole cause. Both go through the logger, as the runtime's own report did, and the
 * exit code is 1 either way.
 */
const reportFailure = <E extends { readonly message: string }>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void
  const error = Cause.findError(cause)
  if (Result.isFailure(error) || Cause.hasDies(cause)) return Effect.logError(cause)
  // A usage mistake (an unknown flag, a missing argument): the CLI has printed it with the help already.
  if (CliError.isCliError(error.success)) return Effect.void
  return Effect.logError(error.success.message)
}

const program = runCli(process.argv.slice(2))

program.pipe(
  Effect.tapCause(reportFailure),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ teardown: gatewayTeardown, disableErrorReporting: true })
)
