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
import { Console, Effect, Logger } from "effect"
import { identity } from "effect/Function"
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net"
import { isLongRunning, runCli } from "./Cli.ts"
import { loadEnvFile } from "./EnvFile.ts"
import { isJsonMode, reportFailure, ResultConsole, stderrConsole, stdoutClosed } from "./Output.ts"
import { gatewayTeardown } from "./Shutdown.ts"

// A broker or device named by host name may have several addresses (localhost: 127.0.0.1 and ::1). Node tries
// them in turn and abandons each but the last after 250 ms, which a busy event loop (a loaded Pi, emulation)
// can pass before it has even seen the connection succeed; the gateway then never reaches a broker that
// listens on the first address. Two seconds per address, well inside the 10 s connect timeout.
setDefaultAutoSelectFamilyAttemptTimeout(2000)

// Before anything reads process.env: the broker password and OTEL_* variables of the folder's ot-gateway.env,
// then of the file OT_GATEWAY_ENV_FILE names (the image names /etc/ot-gateway/gateway.env, the layout before
// the folder), each only when it is there.
loadEnvFile()
const extraEnvFile = process.env["OT_GATEWAY_ENV_FILE"]
if (extraEnvFile !== undefined && extraEnvFile !== "") loadEnvFile(extraEnvFile)

const argv = process.argv.slice(2)
const json = isJsonMode(argv)

runCli(argv).pipe(
  // A reader that closes stdout (`watch | head`) ends a command as done, exit code 0: every streaming command.
  Effect.raceFirst(stdoutClosed(process.stdout)),
  Effect.tapCause(reportFailure({ json, longRunning: isLongRunning(argv) })),
  // --json: stdout is the JSON result alone (Output.ts), so help, banners and progress go to stderr.
  json
    ? (effect) =>
        effect.pipe(
          Effect.updateService(Console.Console, stderrConsole),
          Effect.provideService(ResultConsole, globalThis.console)
        )
    : identity,
  // Logs, a long-running command's final failure among them, go to stderr: stdout is for results, so `check --json | jq` gets JSON only.
  Effect.provideService(Logger.LogToStderr, true),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ teardown: gatewayTeardown, disableErrorReporting: true })
)
