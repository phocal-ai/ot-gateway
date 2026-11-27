/**
 * The line a globally installed CLI prints when a newer release is out, as the Vercel and npm CLIs do:
 *
 *   Update available: v0.16.3 → v0.17.0. Run npm i -g ot-gateway@latest
 *
 * The command is the one for the package manager that installed it, and for pnpm it names the release
 * (`pnpm add -g ot-gateway@0.17.0`): under pnpm's minimumReleaseAge, `@latest` quietly installs an older release
 * while the new one is younger than the minimum, and the exact version says why it waits.
 *
 * At most once a day the CLI asks the npm registry for the newest version, next to the command and never in its way:
 * the question has a short deadline, the answer is kept in `~/.config/ot-gateway/update-check.json`, and a command
 * that ends first prints from what the last question found. Nothing is asked or printed for `--json`, the commands
 * that run until stopped (`run`, `demo`, `simulate`) and `mcp`, without a terminal on stderr, in CI, in the container
 * image, for a build that is not a release (a checkout reports `dev`), or with `OT_GATEWAY_NO_UPDATE_CHECK=1`.
 * Every failure here only means no notice: it never changes what the command does or its exit code.
 */
import { Console, Effect, Fiber, FileSystem, Option, Path, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { homedir } from "node:os"
import { compareReleases, parseRelease } from "./GatewayRelease.ts"
import { readVersion } from "./Version.ts"

export const REGISTRY_URL = "https://registry.npmjs.org/ot-gateway/latest"

/** How often the registry is asked, at most. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** How long the registry question may take; it runs next to the command. */
const FETCH_TIMEOUT = "2 seconds"

/** How long a command that ended waits for a question still running before it prints from the saved answer. */
const JOIN_GRACE = "1 second"

/** Commands that get no notice: they run until stopped (Ctrl-C would cut the line off), or speak a protocol on stdout. */
const quietCommands = new Set(["run", "demo", "simulate", "mcp", "watch"])

/** npx, pnpm dlx, bunx and yarn dlx run from a cache: there is no install to update. */
const runsFromCache =
  /[\\/]_npx[\\/]|[\\/]pnpm[^\\/]*[\\/]dlx[\\/]|[\\/]\.bun[\\/]install[\\/]cache[\\/]|[\\/]dlx-[^\\/]+[\\/]/

/** Whether to check and print a notice at all, for these arguments in this environment. */
export const updateNoticeWanted = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  stderrIsTerminal: boolean,
  /** The script that runs (`process.argv[1]`, symlinks resolved): one in npx's cache is not an install to update. */
  script = ""
) => {
  const [command] = args
  if (runsFromCache.test(script)) return false
  if (command === undefined || quietCommands.has(command)) return false
  if (args.some((arg) => arg === "--json" || arg === "--follow" || arg === "--version" || arg === "-v")) return false
  const set = (name: string) => (env[name] ?? "") !== "" && env[name] !== "0"
  return stderrIsTerminal && !set("OT_GATEWAY_NO_UPDATE_CHECK") && !set("CI")
}

/** Whether `latest` is a newer release than `current`; never for a build that names no release. */
export const isNewer = (latest: string, current: string) => {
  const next = parseRelease(latest)
  const now = parseRelease(current)
  if (next === undefined || now === undefined) return false
  return compareReleases(next, now) > 0
}

const withV = (version: string) => (version.startsWith("v") ? version : `v${version}`)

/**
 * The command that updates a global install, for the package manager that made it, told by where the script lies once
 * symlinks are resolved: pnpm keeps global packages under `<PNPM_HOME>/global/<n>/`, yarn under `yarn/global` (`Yarn\Data\global`
 * on Windows), bun under `.bun/install/global`, and anything else is npm's. The user agent is not asked: a script run by
 * pnpm passes it on to an `ot-gateway` that npm installed.
 */
export const updateCommand = (script: string) => {
  if (/[\\/]global[\\/]\d+[\\/]/.test(script)) return "pnpm add -g ot-gateway@latest"
  if (/[\\/]yarn[\\/](data[\\/])?global[\\/]/i.test(script)) return "yarn global add ot-gateway@latest"
  if (/[\\/]\.bun[\\/]install[\\/]global[\\/]/.test(script)) return "bun add -g ot-gateway@latest"
  return "npm i -g ot-gateway@latest"
}

/** The line; pnpm's command names the release (see the top of this file). */
export const noticeLine = (current: string, latest: string, command = "npm i -g ot-gateway@latest") =>
  `Update available: ${withV(current)} → ${withV(latest)}. Run ${command.startsWith("pnpm ") ? command.replace("@latest", `@${withV(latest).slice(1)}`) : command}`

/** What the last question found, and when (Unix ms). */
const SavedCheck = Schema.Struct({ checkedAt: Schema.Finite, latest: Schema.String })
type SavedCheck = typeof SavedCheck.Type

/** `$XDG_CONFIG_HOME/ot-gateway`, or `~/.config/ot-gateway`. */
export const configFolder = (env: Readonly<Record<string, string | undefined>>) => {
  const base = env["XDG_CONFIG_HOME"]
  return `${base === undefined || base === "" ? `${homedir()}/.config` : base}/ot-gateway`
}

const LatestAnswer = Schema.Struct({ version: Schema.String })

/** The newest version on npm. */
export const latestOnNpm = Effect.gen(function* () {
  const response = yield* HttpClient.get(REGISTRY_URL, { headers: { accept: "application/json" } })
  const ok = yield* HttpClientResponse.filterStatusOk(response)
  const answer = yield* Effect.flatMap(ok.json, Schema.decodeUnknownEffect(LatestAnswer))
  return answer.version
}).pipe(Effect.provide(FetchHttpClient.layer), Effect.timeout(FETCH_TIMEOUT))

export interface UpdateCheckOptions {
  /** The running CLI's version; the installation's VERSION file unless a test gives another. */
  readonly current?: string
  readonly folder: string
  readonly now: number
  /** The registry question; `latestOnNpm` unless a test gives another. */
  readonly latest?: Effect.Effect<string, unknown>
  /** The command the notice names (`updateCommand`); npm's unless given. */
  readonly command?: string
}

/**
 * Runs `command`, asking for the newest version next to it when the saved answer is a day old, then prints the
 * notice on stderr when there is a newer one. The command's own result and failure pass through untouched.
 */
export const withUpdateNotice =
  (options: UpdateCheckOptions) =>
  <A, E, R>(command: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const current = options.current ?? (yield* readVersion)
      if (parseRelease(current) === undefined) return yield* command
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = path.join(options.folder, "update-check.json")
      const saved = yield* fs
        .readFileString(file)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SavedCheck))), Effect.option)
      const due = Option.match(saved, {
        onNone: () => true,
        onSome: (check) => options.now - check.checkedAt >= CHECK_INTERVAL_MS || check.checkedAt > options.now
      })
      const previous = Option.map(saved, (check) => check.latest)
      // A failed question is saved too, with what the last one found: a machine without internet asks once a day,
      // not on every command. Nothing in here, a defect neither, reaches the command's result.
      const ask = Effect.gen(function* () {
        const latest = yield* (options.latest ?? latestOnNpm).pipe(Effect.option)
        const known = Option.orElse(latest, () => previous)
        const check: SavedCheck = { checkedAt: options.now, latest: Option.getOrElse(known, () => "") }
        yield* fs.makeDirectory(options.folder, { recursive: true })
        yield* fs.writeFileString(file, `${JSON.stringify(check)}\n`)
        return latest
      }).pipe(Effect.catchCause(() => Effect.succeed(Option.none<string>())))
      const refresh = due ? yield* Effect.forkDetach(ask) : undefined
      const result = yield* command
      const fresh =
        refresh === undefined
          ? Option.none<string>()
          : Option.flatten(yield* Fiber.join(refresh).pipe(Effect.timeoutOption(JOIN_GRACE)))
      // A question still out is given up, so the command exits now; the next run asks again.
      if (refresh !== undefined) yield* Fiber.interrupt(refresh)
      const latest = Option.orElse(fresh, () => previous)
      if (Option.isSome(latest) && isNewer(latest.value, current)) {
        yield* Console.error(noticeLine(current, latest.value, options.command))
      }
      return result
    })
