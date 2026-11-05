/**
 * `ot-gateway import`: the devices of a points list (see PointsList.ts) added to a config. The file keeps every
 * key it had; the result is checked with the gateway's schema before it is written, so a list that would break
 * the config changes nothing.
 */
import { type GatewayConfig, parseConfig } from "@ot-gateway/core"
import { Console, Effect, FileSystem, Schema } from "effect"
import { loadConfig } from "./LoadConfig.ts"
import { devicesFromPointsList, type PointsListDevice, PointsListError } from "./PointsList.ts"

/** The config file as it is, every key kept, to add devices to. */
const ConfigObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** The points list at `path`, as text. */
export const readPointsList = Effect.fn("readPointsList")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.fail(new PointsListError({ message: `no points list at ${path}` }))
      )
    )
})

export interface ImportResult {
  readonly added: ReadonlyArray<PointsListDevice>
  /** The config as written, or `undefined` for a dry run. */
  readonly config: GatewayConfig | undefined
}

/** Adds the devices in the points list at `listPath` to the config at `configPath`, or only prints them. */
export const importPointsList = Effect.fn("importPointsList")(function* (
  listPath: string,
  configPath: string,
  options: { readonly dryRun: boolean }
) {
  const fs = yield* FileSystem.FileSystem
  const current = yield* loadConfig(configPath)
  const added = yield* devicesFromPointsList(
    yield* readPointsList(listPath),
    current.devices.map((device) => device.id)
  )
  if (options.dryRun) {
    yield* Console.log(JSON.stringify({ devices: added }, null, 2))
    return { added, config: undefined } satisfies ImportResult
  }
  const raw = yield* Schema.decodeUnknownEffect(ConfigObject)(yield* fs.readFileString(configPath))
  const devices = Array.isArray(raw["devices"]) ? raw["devices"] : []
  const text = `${JSON.stringify({ ...raw, devices: [...devices, ...added] }, null, 2)}\n`
  const config = yield* parseConfig(text).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        new PointsListError({
          message: `the points list would make ${configPath} invalid, so nothing was written. Its devices start at devices[${devices.length}]:\n${error.message}`
        })
      )
    )
  )
  yield* fs.writeFileString(configPath, text)
  return { added, config } satisfies ImportResult
})
