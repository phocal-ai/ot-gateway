/**
 * Reading the config file at start-up, for the gateway, `--check` and `--discover`. Whatever goes wrong comes
 * back as one `ConfigFileError` whose message says what to change: a missing file names the ways to get one, and
 * an invalid one lists every problem with its path.
 */
import { parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem, Schema } from "effect"

/** The config file is missing or does not describe a valid gateway. `message` says what to change. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  path: Schema.String,
  message: Schema.String
}) {}

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
  return yield* parseConfig(text).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(new ConfigFileError({ path, message: `${path} is not a valid config:\n${error.message}` }))
    )
  )
})
