/**
 * `ot-gateway import`: the devices of a points list (see PointsList.ts) added to a config. The file keeps every
 * key it had; the result is checked with the gateway's schema before it is written, so a list that would break
 * the config changes nothing.
 */
import { type GatewayConfig, parseConfig } from "@ot-gateway/core"
import { Console, Effect, FileSystem, Schema } from "effect"
import { loadConfig } from "./LoadConfig.ts"
import { devicesFromPointsList, parseDelimited, type PointsListDevice, PointsListError } from "./PointsList.ts"
import { unknownColumns } from "./PointsSchema.ts"
import { describeTranslation, edeToPointsList, isEde } from "./Ede.ts"

/** The config file as it is, every key kept, to add devices to. */
const ConfigObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** The points list at `path`, as text; an EDE file comes back translated into one (Ede.ts). */
export const readPointsList = Effect.fn("readPointsList")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.fail(new PointsListError({ message: `no points list at ${path}` }))
      )
    )
  if (isEde(text)) {
    const translation = yield* edeToPointsList(text)
    yield* Console.error(describeTranslation(path, translation))
    return translation.list
  }
  // A misspelt column would otherwise vanish without a word; extra columns (a description, a comment) are normal.
  const ignored = unknownColumns(parseDelimited(text)[0] ?? [])
  if (ignored.length > 0) {
    yield* Console.error(
      `${path}: ignored column(s) ${ignored.join(", ")} (ot-gateway points schema lists the known ones)`
    )
  }
  return text
})

export interface ImportResult {
  readonly added: ReadonlyArray<PointsListDevice>
  /** The config as written, or `undefined` for a dry run. */
  readonly config: GatewayConfig | undefined
}

/**
 * Where a dry run without a config checks the devices: a broker on this machine, so only the devices can be
 * wrong. Never written anywhere.
 */
const checkOnlyConfig: Readonly<Record<string, unknown>> = {
  site: "points-check",
  building: "points-check",
  mqtt: { url: "mqtt://127.0.0.1:1883" }
}

/**
 * Adds the devices in the points list at `listPath` to the config at `configPath`, or, for a dry run, checks
 * them and prints them. Either way they pass the gateway's schema first. A dry run needs no config: without
 * one, the devices are checked on their own.
 */
export const importPointsList = Effect.fn("importPointsList")(function* (
  listPath: string,
  configPath: string,
  options: { readonly dryRun: boolean }
) {
  const fs = yield* FileSystem.FileSystem
  const checkOnly = options.dryRun && !(yield* fs.exists(configPath))
  const existing = checkOnly ? [] : (yield* loadConfig(configPath)).devices.map((device) => device.id)
  const added = yield* devicesFromPointsList(yield* readPointsList(listPath), existing)
  const raw = checkOnly
    ? checkOnlyConfig
    : yield* Schema.decodeUnknownEffect(ConfigObject)(yield* fs.readFileString(configPath))
  const devices = Array.isArray(raw["devices"]) ? raw["devices"] : []
  const text = `${JSON.stringify({ ...raw, devices: [...devices, ...added] }, null, 2)}\n`
  const target = checkOnly ? "a config" : configPath
  const outcome = options.dryRun ? "" : ", so nothing was written"
  const config = yield* parseConfig(text).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        new PointsListError({
          message: `the points list would make ${target} invalid${outcome}. Its devices start at devices[${devices.length}]:\n${error.message}`
        })
      )
    )
  )
  if (options.dryRun) return { added, config: undefined } satisfies ImportResult
  yield* fs.writeFileString(configPath, text)
  return { added, config } satisfies ImportResult
})
