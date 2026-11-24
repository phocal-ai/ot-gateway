/**
 * Reading the config file at start-up, for the gateway, `--check` and `--discover`. Whatever goes wrong comes
 * back as one `ConfigFileError` whose message says what to change: a missing file names the ways to get one, and
 * an invalid one lists every problem with its path.
 *
 * Relative file paths in the config (`buffer.path`, `history.path`) are resolved here, once: against the folder
 * the config file is in, so `ot-gateway run /home/pi/site-1/ot-gateway.json` keeps its outbox in that folder
 * wherever it is started from. `OT_GATEWAY_DATA_DIR` names another base: the container image sets it to its data
 * volume, so the outbox and the history outlive the container and stay out of the folder Compose mounts.
 */
import { type GatewayConfig, parseConfig } from "@ot-gateway/core"
import { Config, Effect, FileSystem, Option, Schema } from "effect"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { envFileName, loadEnvFile } from "./EnvFile.ts"

/** The config file is missing or does not describe a valid gateway. `message` says what to change. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  path: Schema.String,
  message: Schema.String
}) {}

/**
 * Where relative paths in the config resolve when the config's own folder is not the place: the container image
 * sets it to `/var/lib/ot-gateway`, the data volume. Empty or unset means the config's folder.
 */
export const dataDirectory = Config.String("OT_GATEWAY_DATA_DIR").pipe(
  Config.option,
  Config.map(Option.filter((directory) => directory !== ""))
)

/** SQLite names that are not files in a folder: an in-memory database, a `file:` URI. */
const notAFile = (path: string) => path === ":memory:" || path.startsWith("file:")

const resolvePath = (base: string, path: string) => (isAbsolute(path) || notAFile(path) ? path : resolve(base, path))

/** `config` with its relative file paths (`buffer.path`, `history.path`) resolved against the folder `base`. */
export const resolveConfigPaths = (config: GatewayConfig, base: string): GatewayConfig => ({
  ...config,
  ...(config.buffer === undefined ? {} : { buffer: { ...config.buffer, path: resolvePath(base, config.buffer.path) } }),
  ...(config.history === undefined
    ? {}
    : { history: { ...config.history, path: resolvePath(base, config.history.path) } })
})

export const loadConfig = Effect.fn("loadConfig")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path).pipe(
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.fail(
        new ConfigFileError({
          path,
          message: `no config at ${path}. To see the gateway work first, run ot-gateway demo. To write your own, run ot-gateway init. ot-gateway --help lists every command.`
        })
      )
    )
  )
  const config = yield* parseConfig(text).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(new ConfigFileError({ path, message: `${path} is not a valid config:\n${error.message}` }))
    )
  )
  const folder = dirname(resolve(path))
  // The gateway's folder holds ot-gateway.env too: started from elsewhere (a checkout's root), the CLI finds the
  // broker password there as well. main.ts has read the working directory's already, and set variables win.
  if (folder !== process.cwd()) yield* Effect.sync(() => loadEnvFile(join(folder, envFileName)))
  return (yield* configFileSource(path)).resolve(config)
})

/**
 * The config file at `path` as the status page's editor needs it: its absolute path, and how a config saved there
 * gets its relative paths resolved, the same way as at start.
 */
export const configFileSource = Effect.fn("configFileSource")(function* (path: string) {
  const absolute = resolve(path)
  const base = Option.getOrElse(yield* dataDirectory, () => dirname(absolute))
  return { path: absolute, resolve: (config: GatewayConfig) => resolveConfigPaths(config, base) }
})
