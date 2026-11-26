/**
 * `ot-gateway up`, `down`, `restart` and `upgrade`: the gateway of a folder under Docker Compose, in one command
 * each, and done only when values flow.
 *
 *   up        checks the config, writes compose.yaml when the folder has none (as init does), runs
 *             `docker compose up -d`, then waits until every point has a value
 *   restart   the same, with the container recreated (`--force-recreate`): it reads the config and
 *             ot-gateway.env again
 *   down      `docker compose down`: the container stops; the outbox and history volume stay
 *   upgrade   finds the newest release (or `--to <tag>`), pulls it, checks the config with the new release's own
 *             `check`, writes its tag into compose.yaml, recreates the gateway and waits until the points that had a
 *             value before have one again from the new release; if they do not, it writes the old tag back,
 *             recreates the old gateway and says why. `--check` only says whether there is a newer release.
 *
 * Every failure is a `DeployFailed` with a `code`, a `hint` (what to check) and `next` (one command to run), as
 * `doctor`'s findings have them. Docker runs through the `Docker` service, so tests script it.
 *
 * Docker Desktop (macOS, Windows) runs containers in a VM that does not reach devices on the LAN and drops BACnet
 * broadcasts, so `up`, `restart` and `upgrade` refuse there unless `--force` (a simulated device, a test broker).
 */
import { type DeviceStatus, isDeviceLate } from "@ot-gateway/api"
import { type GatewayConfig, monotonicMillis } from "@ot-gateway/core"
import {
  Console,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  Schema,
  Stream
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { basename, dirname, join, resolve } from "node:path"
import { folderConfigName, composeTemplatePath } from "./Folder.ts"
import { gatewayVersionOf, parseRelease, versionName } from "./GatewayRelease.ts"
import { type ExpectedGateway, gatewayName, statusUrlOf } from "./GatewayTarget.ts"
import { dockerDesktopNote } from "./Init.ts"
import { loadConfig } from "./LoadConfig.ts"
import { shellArgument } from "./Output.ts"
import { fetchGatewayStatus, hintsFor, type GatewayAnswerUnreadable, type GatewayUnreachable } from "./StatusReport.ts"

// ---------------------------------------------------------------------------------------------------------------
// Errors

export const DeployCode = Schema.Literals([
  "docker-desktop",
  "compose-config-name",
  "no-compose",
  "docker-missing",
  "docker-permission",
  "docker-not-running",
  "compose-missing",
  "compose-failed",
  "docker-timeout",
  "gateway-not-answering",
  "wrong-gateway",
  "old-release",
  "device-failing",
  "values-missing",
  "no-status-page",
  "compose-no-tag",
  "tag-overridden",
  "release-lookup-failed",
  "pull-failed",
  "config-rejected",
  "upgrade-rolled-back",
  "rollback-failed"
])
export type DeployCode = typeof DeployCode.Type

/** Something kept the gateway from running, or from running with values, under Compose. */
export class DeployFailed extends Schema.TaggedError<DeployFailed>()("DeployFailed", {
  message: Schema.String,
  code: DeployCode,
  hint: Schema.optionalKey(Schema.String),
  next: Schema.optionalKey(Schema.String)
}) {}

// ---------------------------------------------------------------------------------------------------------------
// Docker

/** What one `docker` command did. */
export interface DockerResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** The `docker` command line: run with arguments, its output collected. */
export class Docker extends Context.Service<
  Docker,
  {
    /** Runs `docker <args>` until it exits, within `timeout`; a non-zero exit is a result, not a failure. */
    readonly run: (
      args: ReadonlyArray<string>,
      options: { readonly timeout: Duration.Input }
    ) => Effect.Effect<DockerResult, DeployFailed>
  }
>()("@ot-gateway/gateway/Docker") {}

const dockerMissing = (detail: string) =>
  new DeployFailed({
    code: "docker-missing",
    message: `docker could not be started: ${detail}`,
    hint: "Install Docker Engine with its Compose plugin (docs/raspberry-pi-install.md, step 5)",
    next: "curl -fsSL https://get.docker.com | sh"
  })

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Stream.mkString(Stream.decodeText(stream))

/** The `docker` on this machine's PATH. */
export const dockerLayer = Layer.effect(
  Docker,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const run = (args: ReadonlyArray<string>, options: { readonly timeout: Duration.Input }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("docker", args, { stdin: "ignore" }))
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
            { concurrency: "unbounded" }
          )
          return { exitCode: Number(exitCode), stdout, stderr } satisfies DockerResult
        })
      ).pipe(
        Effect.mapError((error) => dockerMissing(error.message)),
        Effect.timeoutOrElse({
          duration: options.timeout,
          orElse: () =>
            Effect.fail(
              new DeployFailed({
                code: "docker-timeout",
                message: `docker ${args.slice(0, 2).join(" ")} did not finish within ${Duration.format(Duration.fromInputUnsafe(options.timeout))}`,
                hint: "A pull over a slow uplink, or a Docker daemon that hangs: docker ps answers when the daemon works",
                next: "docker ps"
              })
            )
        })
      )
    return Docker.of({ run })
  })
)

/** The last line Docker wrote on stderr (else stdout): its reason, in its words. */
export const lastLine = (result: DockerResult) =>
  (result.stderr.trim() === "" ? result.stdout : result.stderr)
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "") ?? `exit code ${result.exitCode}`

/**
 * A failed docker command as a finding: Docker not reachable (permission, daemon not running), Compose missing,
 * or else the command's own failure (`code`).
 */
export const dockerFailure = (result: DockerResult, code: DeployCode, what: string, next: string) => {
  const reason = lastLine(result)
  const all = `${result.stderr}\n${result.stdout}`
  if (/permission denied/i.test(all) && /docker\.sock|docker API|daemon/i.test(all)) {
    return new DeployFailed({
      code: "docker-permission",
      message: `Docker refused access: ${reason}`,
      hint: 'Add yourself to the docker group: sudo usermod -aG docker "$USER", then log out and in again',
      next: "newgrp docker"
    })
  }
  if (
    /Cannot connect to the Docker daemon|failed to connect to the docker API|Is the docker daemon running/i.test(all)
  ) {
    return new DeployFailed({
      code: "docker-not-running",
      message: `Docker is not running: ${reason}`,
      hint: "Start the Docker daemon, and enable it so it starts at boot",
      next: "sudo systemctl enable --now docker"
    })
  }
  if (/'compose' is not a docker command|unknown command "compose"|unknown shorthand flag: 'f'/i.test(all)) {
    return new DeployFailed({
      code: "compose-missing",
      message: `docker has no compose command: ${reason}`,
      hint: "Install the Docker Compose plugin (docker compose, not the old docker-compose)",
      next: "sudo apt-get install -y docker-compose-plugin"
    })
  }
  return new DeployFailed({ code, message: `${what}: ${reason}`, next })
}

// ---------------------------------------------------------------------------------------------------------------
// The folder

export interface DeployPaths {
  /** The config, as named (or the folder's ot-gateway.json). */
  readonly config: string
  /** The folder, absolute: Compose sends absolute paths to the daemon. */
  readonly folder: string
  readonly compose: string
}

/** The config and compose.yaml for `target`: a config file, or a folder holding ot-gateway.json. */
export const deployPaths = Effect.fn("deployPaths")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem
  const info = yield* fs.stat(target).pipe(Effect.option)
  const config = Option.isSome(info) && info.value.type === "Directory" ? join(target, folderConfigName) : target
  const folder = dirname(resolve(config))
  return { config, folder, compose: join(folder, "compose.yaml") } satisfies DeployPaths
})

/** The `docker compose` arguments for the folder's compose.yaml. */
const composeArgs = (paths: DeployPaths, ...args: ReadonlyArray<string>) => [
  "compose",
  "-f",
  paths.compose,
  "--project-directory",
  paths.folder,
  ...args
]

/** How a person runs Compose for the folder: `docker compose`, with `-f` when it is not the working directory. */
export const composeCommand = (paths: DeployPaths, cwd: string, args: string) =>
  resolve(cwd) === paths.folder ? `docker compose ${args}` : `docker compose -f ${shellArgument(paths.compose)} ${args}`

const tagPattern = /(\$\{OT_GATEWAY_TAG:-)([^}]*)(\})/

/** The release compose.yaml runs: the default of `${OT_GATEWAY_TAG:-…}`. */
export const composeTag = (text: string) => tagPattern.exec(text)?.[2]

/** compose.yaml with its release set to `tag`. */
export const withComposeTag = (text: string, tag: string) => text.replace(tagPattern, `$1${tag}$3`)

/** The image compose.yaml runs, without its tag: `ghcr.io/phocal-ai/ot-gateway`. */
export const composeImage = (text: string) => /image:\s*["']?([^\s"'$]+):\$\{OT_GATEWAY_TAG/.exec(text)?.[1]

/** A tag as given: `0.16.0` is `v0.16.0`; anything else as it is. */
export const tagName = (tag: string) => (/^\d+\.\d+\.\d+/.test(tag) ? `v${tag}` : tag)

/** Whether `tag` is a Docker tag (so it can go into compose.yaml as it is). */
export const isDockerTag = (tag: string) => /^[\w][\w.-]{0,127}$/.test(tag)

// ---------------------------------------------------------------------------------------------------------------
// Waiting for values

/** What the wait needs of the gateway's status. */
export interface GatewaySnapshot {
  readonly site: string
  readonly building: string
  readonly id: string
  /** The release it says it runs (`host.version`); absent before its first host sample. */
  readonly version: string | undefined
  readonly devices: ReadonlyArray<DeviceStatus>
  readonly now: number
}

export type FetchSnapshot = (
  url: string
) => Effect.Effect<GatewaySnapshot, GatewayUnreachable | GatewayAnswerUnreadable, FileSystem.FileSystem>

/** The status of the gateway at `url`, with every point's value. */
export const liveSnapshot: FetchSnapshot = (url) =>
  fetchGatewayStatus(url, "all").pipe(
    Effect.map((status) => ({
      site: status.site,
      building: status.building,
      id: status.id,
      version: gatewayVersionOf(status),
      devices: status.devices,
      now: status.now
    }))
  )

/** `device/point`, the key of a point. */
const pointKey = (device: string, point: string) => `${device}/${point}`

/** The points of `snapshot` that have a value. */
export const pointsWithValue = (snapshot: Pick<GatewaySnapshot, "devices">) =>
  new Set(
    snapshot.devices.flatMap((device) =>
      device.points.filter((point) => point.value !== undefined).map((point) => pointKey(device.id, point.id))
    )
  )

/** Values flow: every point asked for has a value. */
export interface ValuesFlowing {
  /** Points waited for. */
  readonly points: number
  /** Milliseconds from the start of the wait. */
  readonly ms: number
  /** The release that answered. */
  readonly version: string | null
}

type Observation =
  | { readonly _tag: "Flowing"; readonly points: number; readonly version: string | undefined }
  | { readonly _tag: "Unreachable"; readonly message: string }
  | { readonly _tag: "Other"; readonly found: string }
  | { readonly _tag: "OldRelease"; readonly version: string | undefined }
  | {
      readonly _tag: "Partial"
      readonly withValue: number
      readonly total: number
      readonly missing: ReadonlyArray<string>
      readonly failing: ReadonlyArray<DeviceStatus>
      readonly late: ReadonlyArray<DeviceStatus>
      readonly devices: number
    }

/** What one status answer says: values flow, or what is missing. */
export const observe = (
  snapshot: GatewaySnapshot,
  expected: ExpectedGateway,
  options: { readonly version?: string | undefined; readonly required?: ReadonlySet<string> | undefined }
): Observation => {
  if (snapshot.site !== expected.site || snapshot.building !== expected.building || snapshot.id !== expected.id) {
    return { _tag: "Other", found: gatewayName(snapshot) }
  }
  // The whole tag, so a release candidate still answering is not taken for the release.
  if (
    options.version !== undefined &&
    (snapshot.version === undefined || versionName(snapshot.version) !== versionName(options.version))
  ) {
    return { _tag: "OldRelease", version: snapshot.version }
  }
  const all = snapshot.devices.flatMap((device) => device.points.map((point) => pointKey(device.id, point.id)))
  // A point the config no longer has is not waited for.
  const required = options.required === undefined ? all : all.filter((key) => options.required?.has(key) === true)
  const valued = pointsWithValue(snapshot)
  const missing = required.filter((key) => !valued.has(key))
  if (missing.length === 0) return { _tag: "Flowing", points: required.length, version: snapshot.version }
  return {
    _tag: "Partial",
    withValue: required.length - missing.length,
    total: required.length,
    missing,
    failing: snapshot.devices.filter((device) => device.status === "failing"),
    late: snapshot.devices.filter((device) => isDeviceLate(device, snapshot.now)),
    devices: snapshot.devices.length
  }
}

/** How often the wait asks the status page. */
export const WAIT_INTERVAL: Duration.Input = "1 second"

export interface WaitOptions {
  readonly url: string
  readonly expected: ExpectedGateway
  readonly timeout: Duration.Input
  /** The release that must answer (an upgrade): an older one still answering is not done. */
  readonly version?: string | undefined
  /** The points to wait for (`device/point`); every point when absent. */
  readonly required?: ReadonlySet<string> | undefined
  readonly fetchSnapshot: FetchSnapshot
  /** For the commands in `next`: how the user runs the CLI, and Compose's logs. */
  readonly cli: string
  readonly logs: string
}

const listed = (keys: ReadonlyArray<string>, most = 5) =>
  keys.length <= most ? keys.join(", ") : `${keys.slice(0, most).join(", ")} and ${keys.length - most} more`

/** Why the wait ended without values, from what the gateway said last. */
export const waitFailure = (last: Observation, options: WaitOptions): DeployFailed => {
  const within = `within ${Duration.format(Duration.fromInputUnsafe(options.timeout))}`
  switch (last._tag) {
    case "Flowing":
    case "Unreachable":
      return new DeployFailed({
        code: "gateway-not-answering",
        message: `the gateway did not answer ${within}: ${last._tag === "Unreachable" ? last.message : "no answer"}`,
        hint: "Its container may be restarting after a failed start: its log says why",
        next: options.logs
      })
    case "Other":
      return new DeployFailed({
        code: "wrong-gateway",
        message: `${options.url} answers as ${last.found}, not ${gatewayName(options.expected)}`,
        hint: "Another gateway uses this status port: stop it, or give this config's status block another port",
        next: "docker ps"
      })
    case "OldRelease":
      return new DeployFailed({
        code: "old-release",
        message: `${options.url} still answers as ${last.version === undefined ? "a release that does not say" : versionName(last.version)}, not ${versionName(options.version ?? "")}, ${within}`,
        hint: "The new container did not take over the status port: its log says why",
        next: options.logs
      })
    case "Partial": {
      const first = last.failing[0]
      if (first !== undefined) {
        return new DeployFailed({
          code: "device-failing",
          message: `the gateway runs, but ${last.failing.length} of ${last.devices} device(s) failing, ${last.withValue} of ${last.total} point(s) with a value ${within}; ${first.id}: ${first.lastError ?? first.reason ?? "no reason given"}`,
          hint: hintsFor(first).checks[0] ?? "Check the device's address and that it answers",
          next: `${options.cli} status`
        })
      }
      return new DeployFailed({
        code: "values-missing",
        message: `the gateway runs, but ${last.withValue} of ${last.total} point(s) with a value ${within}; none yet for ${listed(last.missing)}`,
        hint:
          last.late.length > 0
            ? `${listed(last.late.map((device) => device.id))} answer slowly: a polling cycle is stuck, or its interval is long`
            : "A point may not exist on its device, or its device answers slowly: status shows each device",
        next: `${options.cli} status`
      })
    }
  }
}

/** Waits until the gateway at `url` has a value for every point asked for, or fails with what is missing. */
export const waitForValues = Effect.fn("waitForValues")(function* (options: WaitOptions) {
  const started = yield* monotonicMillis
  let last: Observation = { _tag: "Unreachable", message: "no answer yet" }
  const poll = Effect.gen(function* () {
    for (;;) {
      const answer = yield* Effect.result(options.fetchSnapshot(options.url))
      last =
        answer._tag === "Success"
          ? observe(answer.success, options.expected, options)
          : { _tag: "Unreachable", message: answer.failure.message }
      if (last._tag === "Flowing") return last
      yield* Effect.sleep(WAIT_INTERVAL)
    }
  })
  const flowing = yield* poll.pipe(Effect.timeoutOption(options.timeout))
  if (Option.isNone(flowing)) return yield* waitFailure(last, options)
  return {
    points: flowing.value.points,
    ms: (yield* monotonicMillis) - started,
    version: flowing.value.version ?? null
  } satisfies ValuesFlowing
})

// ---------------------------------------------------------------------------------------------------------------
// up, restart, down

export interface DeployOptions {
  /** `process.platform`: Docker Desktop on darwin and win32. */
  readonly platform: string
  /** How the user runs the CLI (`ot-gateway`, `npx ot-gateway`), for `next`. */
  readonly cli: string
  /** The working directory, for how commands in `next` name compose.yaml. */
  readonly cwd: string
  /** Go ahead on Docker Desktop. */
  readonly force?: boolean | undefined
  /** How long to wait for values; no wait when `wait` is false. */
  readonly timeout: Duration.Input
  readonly wait?: boolean | undefined
  readonly fetchSnapshot?: FetchSnapshot | undefined
}

/** Long enough for Compose to pull a release over a slow uplink. */
const COMPOSE_TIMEOUT: Duration.Input = "15 minutes"

const refuseDockerDesktop = (options: DeployOptions, config: string) =>
  (options.platform === "darwin" || options.platform === "win32") && options.force !== true
    ? Effect.fail(
        new DeployFailed({
          code: "docker-desktop",
          message: dockerDesktopNote,
          hint: "--force starts it anyway: for simulated devices or a broker on this machine",
          next: `${options.cli} run ${shellArgument(config)}`
        })
      )
    : Effect.void

/** The config, checked: compose.yaml runs `./ot-gateway.json`, so the config must be named so. */
const checkedConfig = Effect.fn("checkedConfig")(function* (paths: DeployPaths, options: DeployOptions) {
  yield* refuseDockerDesktop(options, paths.config)
  const config = yield* loadConfig(paths.config)
  if (basename(paths.config) !== folderConfigName) {
    return yield* new DeployFailed({
      code: "compose-config-name",
      message: `compose.yaml runs ./${folderConfigName}; this config is ${basename(paths.config)}`,
      hint: `Rename it to ${folderConfigName}, in a folder of its own`,
      next: `mv ${shellArgument(paths.config)} ${shellArgument(join(dirname(paths.config), folderConfigName))}`
    })
  }
  const points = config.devices.reduce((sum, device) => sum + device.points.length, 0)
  yield* Console.log(
    `✓ ${paths.config} is valid: ${gatewayName(config)}, ${config.devices.length} device(s), ${points} point(s)`
  )
  return config
})

/** compose.yaml from the release's template when the folder has none (never replaced: it may be edited). */
const ensureCompose = Effect.fn("ensureCompose")(function* (paths: DeployPaths) {
  const fs = yield* FileSystem.FileSystem
  if (yield* fs.exists(paths.compose)) return false
  yield* fs.writeFileString(paths.compose, yield* fs.readFileString(composeTemplatePath), { flag: "wx", mode: 0o644 })
  yield* Console.log(`✓ wrote ${paths.compose}`)
  return true
})

const readCompose = Effect.fn("readCompose")(function* (paths: DeployPaths, options: DeployOptions) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(paths.compose))) {
    return yield* new DeployFailed({
      code: "no-compose",
      message: `no compose.yaml in ${paths.folder}`,
      hint: "up writes it, as init does",
      next: `${options.cli} up ${shellArgument(paths.config)}`
    })
  }
  return yield* fs.readFileString(paths.compose)
})

const logsCommand = (paths: DeployPaths, options: DeployOptions) =>
  composeCommand(paths, options.cwd, "logs --tail 50 gateway")

/** `docker compose up -d`, the container recreated when `recreate`. */
const composeUp = Effect.fn("composeUp")(function* (paths: DeployPaths, options: DeployOptions, recreate: boolean) {
  const docker = yield* Docker
  const result = yield* docker.run(composeArgs(paths, "up", "-d", ...(recreate ? ["--force-recreate"] : [])), {
    timeout: COMPOSE_TIMEOUT
  })
  if (result.exitCode !== 0) {
    return yield* dockerFailure(result, "compose-failed", "docker compose up failed", logsCommand(paths, options))
  }
})

/** The wait for values, when the config has a status page; `null` (and a warning) when it has none. */
const valuesFor = Effect.fn("valuesFor")(function* (
  paths: DeployPaths,
  config: GatewayConfig,
  options: DeployOptions,
  extra: { readonly version?: string | undefined; readonly required?: ReadonlySet<string> | undefined } = {}
) {
  if (config.status === undefined) return null
  const seconds = Math.round(Duration.toSeconds(Duration.fromInputUnsafe(options.timeout)))
  yield* Console.log(
    extra.required === undefined
      ? `… waiting for every point to have a value (up to ${seconds} s)`
      : extra.required.size === 0
        ? `… waiting for ${versionName(extra.version ?? "the gateway")} to answer (up to ${seconds} s)`
        : `… waiting for the ${extra.required.size} point(s) that had one to have a value (up to ${seconds} s)`
  )
  const values = yield* waitForValues({
    url: statusUrlOf(config.status),
    expected: { path: paths.config, site: config.site, building: config.building, id: config.id },
    timeout: options.timeout,
    version: extra.version,
    required: extra.required,
    fetchSnapshot: options.fetchSnapshot ?? liveSnapshot,
    cli: options.cli,
    logs: logsCommand(paths, options)
  })
  yield* Console.log(`✓ values flow: ${values.points} point(s) with a value after ${Math.round(values.ms / 1000)} s`)
  return values
})

export interface UpReport {
  readonly ok: true
  readonly action: "up" | "restart"
  readonly config: string
  readonly compose: string
  /** Whether up wrote compose.yaml (the folder had none). */
  readonly composeWritten: boolean
  /** The image and tag compose.yaml runs. */
  readonly image: string | null
  readonly gateway: string
  /** The status page, as this machine reaches it; null without one. */
  readonly url: string | null
  /** What the wait found; null when it did not wait (`--no-wait`, or no status page). */
  readonly values: ValuesFlowing | null
  readonly warnings: ReadonlyArray<string>
  readonly next: string
}

/** `up` (or `restart`, which recreates the container): the folder's gateway under Compose, until values flow. */
export const up = Effect.fn("up")(function* (target: string, options: DeployOptions & { readonly recreate: boolean }) {
  const paths = yield* deployPaths(target)
  const config = yield* checkedConfig(paths, options)
  const composeWritten = yield* ensureCompose(paths)
  const text = yield* readCompose(paths, options)
  const tag = composeTag(text)
  const image = composeImage(text)
  const imageName = image === undefined || tag === undefined ? null : `${image}:${tag}`
  yield* composeUp(paths, options, options.recreate)
  yield* Console.log(
    `✓ ${options.recreate ? "recreated" : "started"} ${imageName ?? "the gateway"} with Docker Compose (restarts after a crash or a reboot)`
  )
  const values = options.wait === false ? null : yield* valuesFor(paths, config, options)
  const warnings =
    config.status === undefined
      ? [`${paths.config} has no status block, so whether values flow is not checked: add "status": {} to it`]
      : []
  return {
    ok: true,
    action: options.recreate ? "restart" : "up",
    config: paths.config,
    compose: paths.compose,
    composeWritten,
    image: imageName,
    gateway: gatewayName(config),
    url: config.status === undefined ? null : statusUrlOf(config.status),
    values,
    warnings,
    next: `${options.cli} status`
  } satisfies UpReport
})

export interface DownReport {
  readonly ok: true
  readonly action: "down"
  readonly compose: string
  readonly next: string
}

/** `down`: the container stops and is removed; the volume with the outbox and history stays. */
export const down = Effect.fn("down")(function* (target: string, options: Pick<DeployOptions, "cli" | "cwd">) {
  const paths = yield* deployPaths(target)
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(paths.compose))) {
    return yield* new DeployFailed({
      code: "no-compose",
      message: `no compose.yaml in ${paths.folder}, so no gateway runs from there under Compose`,
      hint: "Name the folder the gateway runs from; docker ps lists what runs",
      next: "docker ps"
    })
  }
  const docker = yield* Docker
  const result = yield* docker.run(composeArgs(paths, "down"), { timeout: "2 minutes" })
  if (result.exitCode !== 0)
    return yield* dockerFailure(result, "compose-failed", "docker compose down failed", "docker ps")
  yield* Console.log(`✓ stopped the gateway of ${paths.compose} (its outbox and history stay in the volume)`)
  return {
    ok: true,
    action: "down",
    compose: paths.compose,
    next: `${options.cli} up${resolve(options.cwd) === paths.folder ? "" : ` ${shellArgument(paths.config)}`}`
  } satisfies DownReport
})

// ---------------------------------------------------------------------------------------------------------------
// upgrade

/** A release on GitHub. */
export interface ReleaseInfo {
  readonly tag: string
  readonly url: string
}

export const RELEASES_URL = "https://api.github.com/repos/phocal-ai/ot-gateway/releases/latest"

const ReleaseAnswer = Schema.Struct({ tag_name: Schema.String, html_url: Schema.String })

/** The newest release (not a pre-release), from GitHub. */
export const latestRelease: Effect.Effect<ReleaseInfo, DeployFailed> = Effect.gen(function* () {
  const response = yield* HttpClient.get(RELEASES_URL, { headers: { accept: "application/vnd.github+json" } })
  const ok = yield* HttpClientResponse.filterStatusOk(response)
  const answer = yield* Effect.flatMap(ok.json, Schema.decodeUnknownEffect(ReleaseAnswer))
  return { tag: answer.tag_name, url: answer.html_url }
}).pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.timeout("10 seconds"),
  // Every failure here means one thing: the newest release is not known.
  Effect.mapError(
    (error) =>
      new DeployFailed({
        code: "release-lookup-failed",
        message: `could not ask GitHub for the newest release: ${error.message}`,
        hint: "No internet from this machine, or GitHub's rate limit: name the release with --to",
        next: "ot-gateway upgrade --to <tag>"
      })
  )
)

export interface UpgradeOptions extends DeployOptions {
  /** Only report whether a newer release exists. */
  readonly check: boolean
  /** The release to move to; the newest when absent. */
  readonly to?: string | undefined
  /** `OT_GATEWAY_TAG` in this environment: Compose would run it instead of compose.yaml's tag. */
  readonly envTag?: string | undefined
  readonly latest?: Effect.Effect<ReleaseInfo, DeployFailed> | undefined
}

export interface UpgradeCheckReport {
  readonly ok: true
  readonly action: "upgrade-check"
  readonly compose: string
  readonly current: string
  readonly latest: string
  readonly available: boolean
  readonly notes: string | null
  readonly next: string | null
}

export interface UpgradeReport {
  readonly ok: true
  readonly action: "upgrade"
  readonly compose: string
  readonly from: string
  readonly to: string
  /** False when it runs `to` already. */
  readonly upgraded: boolean
  readonly values: ValuesFlowing | null
  readonly next: string | null
}

const compareTags = (left: string, right: string) => {
  const a = parseRelease(left)
  const b = parseRelease(right)
  if (a === undefined || b === undefined) return left === right ? 0 : undefined
  const numbers = a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  if (numbers !== 0 || left === right) return numbers
  // The same numbers: a pre-release (`v0.16.0-rc.1`) comes before the release (`v0.16.0`).
  const preLeft = /^v?\d+\.\d+\.\d+-/.test(left)
  const preRight = /^v?\d+\.\d+\.\d+-/.test(right)
  if (preLeft !== preRight) return preLeft ? -1 : 1
  return left < right ? -1 : 1
}

/** Writes `text` to `path` through a new file renamed over it, so a cut-off write leaves the old file whole. */
const replaceFile = Effect.fn("replaceFile")(function* (path: string, text: string) {
  const fs = yield* FileSystem.FileSystem
  // A symlinked compose.yaml stays a link: the file it names changes. Its mode stays as it was.
  const target = yield* fs.realPath(path)
  const mode = (yield* fs.stat(target)).mode & 0o777
  const temporary = `${target}.upgrade`
  yield* fs.writeFileString(temporary, text, { mode })
  yield* fs.chmod(temporary, mode)
  yield* fs.rename(temporary, target).pipe(Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore)))
})

/** The tag Compose would run instead of compose.yaml's: `OT_GATEWAY_TAG` in the environment or the folder's .env. */
const overridingTag = Effect.fn("overridingTag")(function* (paths: DeployPaths, envTag: string | undefined) {
  if (envTag !== undefined && envTag !== "") return `OT_GATEWAY_TAG=${envTag} in this shell`
  const fs = yield* FileSystem.FileSystem
  const dotEnv = join(paths.folder, ".env")
  const text = yield* fs.readFileString(dotEnv).pipe(Effect.orElseSucceed(() => ""))
  return /^\s*OT_GATEWAY_TAG\s*=/m.test(text) ? `OT_GATEWAY_TAG in ${dotEnv}` : undefined
})

/**
 * `upgrade`: to the newest release (or `--to`), checked before and after; on a failure after the switch, the old
 * release is put back. `--check` only compares.
 */
export const upgrade = Effect.fn("upgrade")(function* (target: string, options: UpgradeOptions) {
  const paths = yield* deployPaths(target)
  const text = yield* readCompose(paths, options)
  const current = composeTag(text)
  const image = composeImage(text)
  if (current === undefined || image === undefined) {
    return yield* new DeployFailed({
      code: "compose-no-tag",
      message: `${paths.compose} names no image:\${OT_GATEWAY_TAG:-<tag>}, so upgrade does not know where the release is set`,
      hint: "Edit its image line by hand, or start from the release's compose.yaml (move yours aside, then up writes one)"
    })
  }
  const release: ReleaseInfo =
    options.to === undefined
      ? yield* (options.latest ?? latestRelease).pipe(
          Effect.mapError(
            (error) =>
              new DeployFailed({
                code: error.code,
                message: error.message,
                ...(error.hint === undefined ? {} : { hint: error.hint }),
                next: `${options.cli} upgrade${resolve(options.cwd) === paths.folder ? "" : ` ${shellArgument(paths.config)}`} --to <tag>`
              })
          )
        )
      : { tag: tagName(options.to), url: `https://github.com/phocal-ai/ot-gateway/releases/tag/${tagName(options.to)}` }
  const order = compareTags(release.tag, current)
  const newer = order === undefined ? release.tag !== current : order > 0
  const next = options.to === undefined ? newer : release.tag !== current

  if (options.check) {
    yield* Console.log(
      newer
        ? `${versionName(release.tag)} is out; this folder runs ${versionName(current)}. Notes: ${release.url}`
        : `✓ ${versionName(current)} is the newest release`
    )
    return {
      ok: true,
      action: "upgrade-check",
      compose: paths.compose,
      current,
      latest: release.tag,
      available: newer,
      notes: newer ? release.url : null,
      next: newer
        ? `${options.cli} upgrade${resolve(options.cwd) === paths.folder ? "" : ` ${shellArgument(paths.config)}`}`
        : null
    } satisfies UpgradeCheckReport
  }
  if (!next) {
    yield* Console.log(
      `✓ ${versionName(current)} is the ${options.to === undefined ? "newest release" : "release named"}; nothing to do`
    )
    return {
      ok: true,
      action: "upgrade",
      compose: paths.compose,
      from: current,
      to: current,
      upgraded: false,
      values: null,
      next: null
    } satisfies UpgradeReport
  }

  const overridden = yield* overridingTag(paths, options.envTag)
  if (overridden !== undefined) {
    return yield* new DeployFailed({
      code: "tag-overridden",
      message: `${overridden} sets the release instead of compose.yaml, so writing a tag there changes nothing`,
      hint: "Remove OT_GATEWAY_TAG, then upgrade again",
      next: "unset OT_GATEWAY_TAG"
    })
  }

  const config = yield* checkedConfig(paths, options)
  if (config.status === undefined) {
    return yield* new DeployFailed({
      code: "no-status-page",
      message: `${paths.config} has no status block, so upgrade cannot see whether values flow on the new release, and would not know to go back`,
      hint: 'Add "status": {} to it and restart the gateway, then upgrade',
      next: `${options.cli} restart${resolve(options.cwd) === paths.folder ? "" : ` ${shellArgument(paths.config)}`}`
    })
  }
  const docker = yield* Docker
  const fetchSnapshot = options.fetchSnapshot ?? liveSnapshot

  // What flows now: the new release has to bring back at least these, and only these when devices are down today.
  const before = yield* Effect.result(fetchSnapshot(statusUrlOf(config.status)))
  const required =
    before._tag === "Success" &&
    before.success.id === config.id &&
    before.success.site === config.site &&
    before.success.building === config.building
      ? pointsWithValue(before.success)
      : undefined

  const newImage = `${image}:${release.tag}`
  yield* Console.log(`… pulling ${newImage}`)
  const pulled = yield* docker.run(["pull", "-q", newImage], { timeout: COMPOSE_TIMEOUT })
  if (pulled.exitCode === 0) {
    yield* Console.log(`✓ pulled ${newImage}`)
  } else {
    // A site without internet may have loaded the image by hand (docker load): the copy here does.
    const local = yield* docker.run(["image", "inspect", "--format", "{{.Id}}", newImage], { timeout: "1 minute" })
    if (local.exitCode !== 0) {
      return yield* dockerFailure(pulled, "pull-failed", `could not pull ${newImage}`, `docker pull ${newImage}`)
    }
    yield* Console.log(`! could not pull ${newImage} (${lastLine(pulled)}); using the copy on this machine`)
  }

  // The new release's own check, on this folder, read-only and without a network: a key it no longer takes, or one
  // it needs, shows here, before anything changes.
  const checked = yield* docker.run(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${paths.folder}:/etc/ot-gateway:ro`,
      newImage,
      "check",
      `/etc/ot-gateway/${folderConfigName}`
    ],
    { timeout: "2 minutes" }
  )
  if (checked.exitCode !== 0) {
    return yield* new DeployFailed({
      code: "config-rejected",
      message: `${versionName(release.tag)} does not take ${paths.config}: ${lastLine(checked).replace(/^error:\s*/, "")}`,
      hint: `Nothing changed; ${versionName(current)} still runs. The release notes say what changed in the config: ${release.url}`,
      next: `docker run --rm -v ${shellArgument(`${paths.folder}:/etc/ot-gateway:ro`)} ${newImage} check /etc/ot-gateway/${folderConfigName}`
    })
  }
  yield* Console.log(`✓ ${versionName(release.tag)} takes ${paths.config}`)

  const rollback = (why: DeployFailed) =>
    Effect.gen(function* () {
      yield* Console.log(`✗ ${why.message}`)
      // The failed release's last words, before its container is replaced and its log with it.
      const logs = yield* docker.run(composeArgs(paths, "logs", "--no-log-prefix", "--tail", "20", "gateway"), {
        timeout: "30 seconds"
      })
      const lastWords = logs.exitCode === 0 && `${logs.stdout}${logs.stderr}`.trim() !== "" ? lastLine(logs) : undefined
      yield* Console.log(`… going back to ${versionName(current)}`)
      // compose.yaml back first: without it, the next boot starts the failed release again.
      yield* replaceFile(paths.compose, text).pipe(
        Effect.mapError(
          (error) =>
            new DeployFailed({
              code: "rollback-failed",
              message: `${versionName(release.tag)} failed (${why.message}), and compose.yaml could not be written back: ${error.message}`,
              hint: `Write ${current} back into compose.yaml's image line by hand, then start it`,
              next: `sed -i 's/OT_GATEWAY_TAG:-[^}]*/OT_GATEWAY_TAG:-${current}/' ${shellArgument(paths.compose)} && ${composeCommand(paths, options.cwd, "up -d")}`
            })
        )
      )
      // With no values to compare to (the gateway did not answer before), the old release answering is enough.
      const back = yield* Effect.result(
        Effect.andThen(
          composeUp(paths, options, false),
          valuesFor(paths, config, options, { version: current, required: required ?? new Set() })
        )
      )
      if (back._tag === "Failure") {
        return yield* new DeployFailed({
          code: "rollback-failed",
          message: `${versionName(release.tag)} failed (${why.message}), and ${versionName(current)} did not come back either: ${back.failure.message}`,
          hint: back.failure.hint ?? "Its log says why",
          next: back.failure.next ?? logsCommand(paths, options)
        })
      }
      return yield* new DeployFailed({
        code: "upgrade-rolled-back",
        message: `${versionName(release.tag)} failed, so ${versionName(current)} runs again: ${why.message}${lastWords === undefined ? "" : `. Its log ended with: ${lastWords}`}`,
        hint: `Nothing else changed. The release notes may say what changed: ${release.url}`,
        next: `${options.cli} status`
      })
    })

  yield* replaceFile(paths.compose, withComposeTag(text, release.tag))
  const values = yield* Effect.gen(function* () {
    yield* composeUp(paths, options, false)
    yield* Console.log(`✓ started ${newImage}`)
    return yield* valuesFor(paths, config, options, { version: release.tag, required })
  }).pipe(
    Effect.catchTag("DeployFailed", rollback),
    // Stopped halfway (Ctrl-C): compose.yaml and the running gateway go back to the release they had.
    Effect.onInterrupt(() =>
      Effect.andThen(replaceFile(paths.compose, text), composeUp(paths, options, false)).pipe(
        Effect.catch((error) => Console.error(`could not go back to ${versionName(current)}: ${error.message}`))
      )
    )
  )
  yield* Console.log(`✓ upgraded ${versionName(current)} → ${versionName(release.tag)}`)
  return {
    ok: true,
    action: "upgrade",
    compose: paths.compose,
    from: current,
    to: release.tag,
    upgraded: true,
    values,
    next: `${options.cli} status`
  } satisfies UpgradeReport
})

/** The last lines of a report for a person: the command to run next. */
export const nextLine = (next: string | null) => (next === null ? [] : [`next: ${next}`])
