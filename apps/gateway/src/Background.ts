/**
 * `ot-gateway start` and `ot-gateway stop`: the gateway of a folder as a background process on this machine,
 * for where Docker Compose is not the way (macOS and Windows, whose Docker Desktop reaches no device on the LAN).
 *
 *   start          checks the config, starts `ot-gateway run <config>` in a process of its own that outlives the
 *                  command, writes its pid to `.ot-gateway.pid` next to the config, then waits until every point
 *                  has a value, as `up` does
 *   stop           stops the process `.ot-gateway.pid` names, after checking that it is still this gateway (a pid
 *                  can be reused after a reboot), and removes the file
 *
 * It is not a service: it does not come back after a crash or a reboot. That is what `up` (Docker Compose) and the
 * systemd unit are for on Linux; the report says so. The log is in the gateway's memory (`ot-gateway logs`), since
 * a detached process has no terminal; a gateway that exits during the wait is reported with `run` in the
 * foreground as the next command, which prints why.
 *
 * Every failure is a `DeployFailed` with `code`, `hint` and `next`, as `up` reports them.
 */
import { type GatewayConfig, monotonicMillis } from "@ot-gateway/core"
import { Console, Context, Duration, Effect, FileSystem, Layer, Option, Schema, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { join, resolve } from "node:path"
import { DeployFailed, deployPaths, type FetchSnapshot, liveSnapshot, waitForValues } from "./Deploy.ts"
import { gatewayName, statusUrlOf } from "./GatewayTarget.ts"
import { loadConfig } from "./LoadConfig.ts"
import { shellArgument } from "./Output.ts"
import { plural } from "./Words.ts"

/** The file next to the config that names the background gateway's process. */
export const PID_FILE = ".ot-gateway.pid"

/** What `.ot-gateway.pid` holds: the process, the config it runs, and when it started (wall time, for people). */
export const PidRecord = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  config: Schema.String,
  started: Schema.Number
})
export type PidRecord = typeof PidRecord.Type

const PidRecordJson = Schema.fromJsonString(PidRecord)

/** A started background process: its pid, and its exit code once it has exited (while this command runs). */
export interface Launched {
  readonly pid: number
  readonly exited: Effect.Effect<number>
}

/** Starting, finding and stopping a process of this machine; tests script it. */
export class Processes extends Context.Service<
  Processes,
  {
    /** Starts `ot-gateway run <config>` in `cwd`, detached, in the caller's scope (closing it leaves it running). */
    readonly launch: (config: string, cwd: string) => Effect.Effect<Launched, DeployFailed, Scope.Scope>
    /** Whether a process with `pid` exists. */
    readonly alive: (pid: number) => Effect.Effect<boolean>
    /** The process's command line, when it can be read. */
    readonly commandLine: (pid: number) => Effect.Effect<Option.Option<string>>
    /** Sends `signal` to the process and its group. */
    readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => Effect.Effect<void>
  }
>()("@ot-gateway/gateway/Processes") {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Stream.mkString(Stream.decodeText(stream)).pipe(Effect.orElseSucceed(() => ""))

/** Whether a process with `pid` exists (signal 0 asks without sending one). */
const processAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM: it exists, under another user.
      return error instanceof Error && "code" in error && error.code === "EPERM"
    }
  })

/** `name` to the process's group, which the detached gateway leads, else to the process alone. */
const sendSignal = (pid: number, name: "SIGTERM" | "SIGKILL") =>
  Effect.sync(() => {
    try {
      // The group first: the detached gateway leads its own.
      process.kill(-pid, name)
    } catch {
      try {
        process.kill(pid, name)
      } catch {
        // Gone already: what stop wants.
      }
    }
  })

/**
 * This machine's processes. The gateway is started as this CLI was (`node` with its flags and script), so a checkout,
 * the npm package and the bundle each start their own. Only signalling goes through `process.kill`, which Effect's
 * process module does not offer for a process it did not start.
 */
export const processesLayer = Layer.effect(
  Processes,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const script = process.argv[1] ?? ""
    const launch = (config: string, cwd: string) =>
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [...process.execArgv, script, "run", config, "--verbose"], {
            cwd,
            detached: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore"
          })
        )
        // Unreferenced, the scope's end leaves it running and this command can exit.
        yield* Effect.asVoid(handle.unref)
        return {
          pid: Number(handle.pid),
          exited: handle.exitCode.pipe(
            Effect.map(Number),
            Effect.orElseSucceed(() => -1)
          )
        } satisfies Launched
      }).pipe(
        Effect.mapError(
          (error) =>
            new DeployFailed({
              code: "background-failed",
              message: `the gateway could not be started in the background: ${error.message}`,
              next: `ot-gateway run ${shellArgument(config)}`
            })
        )
      )
    const commandLine = (pid: number) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("ps", ["-o", "command=", "-p", String(pid)]))
          const [text, code] = yield* Effect.all([collect(handle.stdout), handle.exitCode], {
            concurrency: "unbounded"
          })
          return Number(code) === 0 && text.trim() !== "" ? Option.some(text.trim()) : Option.none<string>()
        })
      ).pipe(
        Effect.timeoutOption("5 seconds"),
        Effect.map(Option.flatten),
        Effect.orElseSucceed(() => Option.none<string>())
      )
    return Processes.of({ launch, alive: processAlive, commandLine, signal: sendSignal })
  })
)

/** Where the pid file of the config at `config` is. */
const pidPath = (folder: string) => join(folder, PID_FILE)

/** The pid file's record, when there is a readable one. */
const readPid = Effect.fn("readPid")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(pidPath(folder)).pipe(Effect.option)
  if (Option.isNone(text)) return Option.none<PidRecord>()
  return yield* Schema.decodeUnknownEffect(PidRecordJson)(text.value).pipe(Effect.option)
})

/** Whether `line` is `ot-gateway run` of `config`: the pid still names the gateway it was written for. */
export const isGatewayOf = (line: string, config: string) => / run /.test(` ${line} `) && line.includes(config)

/** The record's process, when it still runs the gateway of `config`. */
const runningGateway = Effect.fn("runningGateway")(function* (record: PidRecord) {
  const processes = yield* Processes
  if (!(yield* processes.alive(record.pid))) return false
  const line = yield* processes.commandLine(record.pid)
  // Without ps, the pid alone: alive and written by start.
  return Option.isNone(line) || isGatewayOf(line.value, record.config)
})

export interface BackgroundOptions {
  /** `process.platform`: Windows has no detached process that outlives its console here. */
  readonly platform: string
  /** How the user runs the CLI (`ot-gateway`, `npx ot-gateway`), for `next`. */
  readonly cli: string
  /** The working directory, for how commands in `next` name the config. */
  readonly cwd: string
  readonly timeout: Duration.Input
  /** Wait for values (default true). */
  readonly wait?: boolean | undefined
  readonly fetchSnapshot?: FetchSnapshot | undefined
}

export interface StartReport {
  readonly ok: true
  readonly action: "start"
  readonly config: string
  readonly pid: number
  readonly pidFile: string
  readonly gateway: string
  readonly url: string | null
  readonly values: { readonly points: number; readonly ms: number } | null
  readonly warnings: ReadonlyArray<string>
  readonly next: string
}

/** How a command names the config: nothing in its folder when it is ot-gateway.json, else its path. */
const configArgument = (config: string, cwd: string) =>
  resolve(cwd, config) === resolve(cwd, "ot-gateway.json") ? "" : ` ${shellArgument(config)}`

const notAService =
  "It runs until stop, a crash or a reboot: on a machine that must keep it running, use up (Docker Compose) on Linux"

/** `start`: the gateway of `target` in the background, until every point has a value. */
export const startBackground = Effect.fn("startBackground")(function* (target: string, options: BackgroundOptions) {
  const paths = yield* deployPaths(target)
  const argument = configArgument(paths.config, options.cwd)
  if (options.platform === "win32") {
    return yield* new DeployFailed({
      code: "background-unsupported",
      message: "start is not available on Windows",
      hint: "Run the gateway in a terminal of its own, or under Docker on a Linux machine",
      next: `${options.cli} run${argument}`
    })
  }
  const config: GatewayConfig = yield* loadConfig(paths.config)
  const fs = yield* FileSystem.FileSystem
  const processes = yield* Processes
  const before = yield* readPid(paths.folder)
  if (Option.isSome(before) && (yield* runningGateway(before.value))) {
    return yield* new DeployFailed({
      code: "already-running",
      message: `the gateway of ${paths.config} runs in the background already (pid ${before.value.pid})`,
      hint: "Stop it first to start it again, for a changed config",
      next: `${options.cli} stop${argument}`
    })
  }
  const absolute = resolve(paths.config)
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const launched = yield* processes.launch(absolute, paths.folder)
      const record: PidRecord = { pid: launched.pid, config: absolute, started: Date.now() }
      yield* fs.writeFileString(pidPath(paths.folder), `${JSON.stringify(record)}\n`)
      yield* Console.log(`✓ started ${gatewayName(config)} in the background (pid ${launched.pid})`)
      const url = config.status === undefined ? null : statusUrlOf(config.status)
      const warnings = [
        notAService,
        ...(config.status === undefined
          ? [`${paths.config} has no status block, so whether values flow is not checked: add "status": {} to it`]
          : [])
      ]
      const report = (values: StartReport["values"]): StartReport => ({
        ok: true,
        action: "start",
        config: paths.config,
        pid: launched.pid,
        pidFile: pidPath(paths.folder),
        gateway: gatewayName(config),
        url,
        values,
        warnings,
        next: `${options.cli} status${argument}`
      })
      if (options.wait === false || config.status === undefined) return report(null)
      const port = config.status.port
      const seconds = Math.round(Duration.toSeconds(Duration.fromInputUnsafe(options.timeout)))
      yield* Console.log(`… waiting for every point to have a value (up to ${seconds} s)`)
      const exited = launched.exited.pipe(
        Effect.flatMap((code) =>
          Effect.fail(
            new DeployFailed({
              code: "gateway-exited",
              message: `the gateway exited with code ${code} before every point had a value`,
              hint: "Run it in the foreground once: it prints why it stopped",
              next: `${options.cli} run${argument}`
            })
          )
        )
      )
      const values = yield* Effect.raceFirst(
        waitForValues({
          url: statusUrlOf(config.status),
          expected: { path: paths.config, site: config.site, building: config.building, id: config.id },
          timeout: options.timeout,
          fetchSnapshot: options.fetchSnapshot ?? liveSnapshot,
          cli: options.cli,
          logs: `${options.cli} logs${argument} --level warn`
        }),
        exited
      ).pipe(
        Effect.catchTag("DeployFailed", (failure) =>
          Effect.gen(function* () {
            // Without its status page this gateway cannot be watched or told apart: stop it, and say why.
            if (failure.code !== "wrong-gateway" && failure.code !== "gateway-not-answering") return yield* failure
            yield* processes.signal(launched.pid, "SIGTERM")
            yield* fs.remove(pidPath(paths.folder)).pipe(Effect.ignore)
            return yield* new DeployFailed({
              code: failure.code,
              message: `${failure.message}; stopped it again`,
              hint:
                failure.code === "wrong-gateway"
                  ? `Another gateway has the status port ${port}: stop it, or give this config another port (config set status.port ${port + 1})`
                  : "Run it in the foreground once: it prints why it does not answer",
              next:
                failure.code === "wrong-gateway"
                  ? `lsof -nP -iTCP:${port} -sTCP:LISTEN`
                  : `${options.cli} run${argument}`
            })
          })
        ),
        // A gateway that exited leaves no pid file behind; one that runs without values keeps it, for stop.
        Effect.onError(() =>
          Effect.flatMap(processes.alive(launched.pid), (alive) =>
            alive ? Effect.void : fs.remove(pidPath(paths.folder)).pipe(Effect.ignore)
          )
        )
      )
      yield* Console.log(
        `✓ values flow: ${plural(values.points, "point")} with a value after ${Math.round(values.ms / 1000)} s`
      )
      return report({ points: values.points, ms: values.ms })
    })
  )
})

export interface StopReport {
  readonly ok: true
  readonly action: "stop"
  readonly config: string
  /** Whether a background gateway was running and is stopped now. */
  readonly stopped: boolean
  readonly pid: number | null
  readonly next: string
}

/** How long stop waits for the gateway to close its connections (the broker's offline message) before SIGKILL. */
const STOP_GRACE = 10_000

/** `stop`: the background gateway of `target` stops; nothing to do when none runs. */
export const stopBackground = Effect.fn("stopBackground")(function* (
  target: string,
  options: Pick<BackgroundOptions, "cli" | "cwd">
) {
  const paths = yield* deployPaths(target)
  const argument = configArgument(paths.config, options.cwd)
  const fs = yield* FileSystem.FileSystem
  const processes = yield* Processes
  const record = yield* readPid(paths.folder)
  const report = (stopped: boolean, pid: number | null): StopReport => ({
    ok: true,
    action: "stop",
    config: paths.config,
    stopped,
    pid,
    next: `${options.cli} start${argument}`
  })
  if (Option.isNone(record) || !(yield* processes.alive(record.value.pid))) {
    yield* fs.remove(pidPath(paths.folder)).pipe(Effect.ignore)
    yield* Console.log(`no gateway of ${paths.config} runs in the background (ot-gateway start starts one)`)
    return report(false, null)
  }
  const { pid } = record.value
  if (!(yield* runningGateway(record.value))) {
    yield* fs.remove(pidPath(paths.folder)).pipe(Effect.ignore)
    yield* Console.log(`pid ${pid} is no longer the gateway of ${paths.config} (a reboot reuses pids); left it alone`)
    return report(false, null)
  }
  yield* processes.signal(pid, "SIGTERM")
  const started = yield* monotonicMillis
  while ((yield* processes.alive(pid)) && (yield* monotonicMillis) - started < STOP_GRACE) {
    yield* Effect.sleep("200 millis")
  }
  if (yield* processes.alive(pid)) yield* processes.signal(pid, "SIGKILL")
  yield* fs.remove(pidPath(paths.folder)).pipe(Effect.ignore)
  yield* Console.log(`✓ stopped the gateway of ${paths.config} (pid ${pid})`)
  return report(true, pid)
})
