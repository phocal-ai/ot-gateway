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
import { existsSync, realpathSync } from "node:fs"
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net"
import {
  commandPath,
  isLongRunning,
  runCli,
  takesJson,
  toCliArgs,
  withFirstRun,
  withJsonFromEnvironment
} from "./Cli.ts"
import { loadEnvFile } from "./EnvFile.ts"
import { hideSqliteExperimentalWarning } from "./NodeWarnings.ts"
import {
  AgentHints,
  isJsonMode,
  reportFailure,
  ResultConsole,
  runsUnderAgent,
  stderrConsole,
  stdoutClosed
} from "./Output.ts"
import { gatewayTeardown } from "./Shutdown.ts"
import { configFolder, updateCommand, updateNoticeWanted, withUpdateNotice } from "./UpdateNotice.ts"

// First: Node 22's notice that node:sqlite is experimental is queued by the imports above and printed on the
// next tick. It stays off stderr (NodeWarnings.ts); every other warning prints.
hideSqliteExperimentalWarning()

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

// A bare `ot-gateway` in a terminal, with no config here yet, is a first run: it starts init. OT_GATEWAY_JSON=1 adds
// --json to every command that takes it.
// The variable first: a first run's init stays the questions in a terminal.
const argv = withFirstRun(withJsonFromEnvironment(process.argv.slice(2), process.env), {
  terminal: process.stdin.isTTY && process.stdout.isTTY,
  configHere: existsSync("ot-gateway.json")
})
const json = isJsonMode(argv)
// Under a coding agent, help and failures say where --json and mcp are; the output itself stays the same.
const agentHints = !json && runsUnderAgent(process.env)
const takesJsonHere = takesJson(commandPath(toCliArgs(argv)))
// A globally installed CLI says once a day when a newer release is out (UpdateNotice.ts); never for --json or mcp.
// The script with symlinks resolved: bun and yarn link their bin folder to the install.
const script = (() => {
  try {
    return realpathSync(process.argv[1] ?? "")
  } catch {
    return process.argv[1] ?? ""
  }
})()
const notice = updateNoticeWanted(toCliArgs(argv), process.env, process.stderr.isTTY, script)

runCli(argv).pipe(
  notice
    ? withUpdateNotice({
        folder: configFolder(process.env),
        now: Date.now(),
        command: updateCommand(script)
      })
    : identity,
  // A reader that closes stdout (`watch | head`) ends a command as done, exit code 0: every streaming command.
  Effect.raceFirst(stdoutClosed(process.stdout)),
  Effect.tapCause(reportFailure({ json, longRunning: isLongRunning(argv), agentHint: agentHints && takesJsonHere })),
  // --json: stdout is the JSON result alone (Output.ts), so help, banners and progress go to stderr.
  json
    ? (effect) =>
        effect.pipe(
          Effect.updateService(Console.Console, stderrConsole),
          Effect.provideService(ResultConsole, globalThis.console)
        )
    : identity,
  Effect.provideService(AgentHints, agentHints),
  // Logs, a long-running command's final failure among them, go to stderr: stdout is for results, so `check --json | jq` gets JSON only.
  Effect.provideService(Logger.LogToStderr, true),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ teardown: gatewayTeardown, disableErrorReporting: true })
)
