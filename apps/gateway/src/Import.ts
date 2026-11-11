/**
 * `ot-gateway import`: the devices of a points list (see PointsList.ts) added to a config. The file keeps every
 * key it had; the result is checked with the gateway's schema before it is written, so a list that would break
 * the config changes nothing.
 */
import { type Device, type GatewayConfig, parseConfig } from "@ot-gateway/core"
import { Console, Effect, FileSystem, Schema } from "effect"
import { loadConfig } from "./LoadConfig.ts"
import {
  devicesFromPointsList,
  parseDelimited,
  type PointsListDevice,
  PointsListError,
  profileNames
} from "./PointsList.ts"
import { unknownColumns } from "./PointsSchema.ts"
import { describeTranslation, edeToPointsList, isEde } from "./Ede.ts"
import { resolveProfile } from "./Profile.ts"
import { dirname } from "node:path"

/** The devices of the points list at `path`, with the profiles it names (Profile.ts) loaded. */
export const devicesFromFile = Effect.fn("devicesFromFile")(function* (
  path: string,
  existing: ReadonlyArray<string> = []
) {
  const text = yield* readPointsList(path)
  const names = profileNames(text)
  const profiles = yield* Effect.forEach(names, (name) =>
    Effect.map(resolveProfile(name, { relativeTo: dirname(path) }), (profile) => [name, profile] as const)
  )
  return yield* devicesFromPointsList(text, existing, new Map(profiles))
})

/** The config file as it is, every key kept, to add devices to. */
const ConfigObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** A points list's text, as the reader takes it: an EDE file translated into one, and what to tell about it. */
export interface PointsListText {
  readonly list: string
  readonly format: "points-list" | "ede"
  /** What was translated or ignored, one sentence each, naming `source`. */
  readonly notes: ReadonlyArray<string>
}

/** `text` as a points list: an EDE file translated (Ede.ts), the columns the reader ignores named. */
export const pointsListFromText = Effect.fn("pointsListFromText")(function* (text: string, source: string) {
  if (isEde(text)) {
    const translation = yield* edeToPointsList(text)
    return {
      list: translation.list,
      format: "ede",
      notes: [describeTranslation(source, translation)]
    } satisfies PointsListText
  }
  // A misspelt column would otherwise vanish without a word; extra columns (a description, a comment) are normal.
  const ignored = unknownColumns(parseDelimited(text)[0] ?? [])
  return {
    list: text,
    format: "points-list",
    notes:
      ignored.length === 0
        ? []
        : [`${source}: ignored column(s) ${ignored.join(", ")} (ot-gateway points schema lists the known ones)`]
  } satisfies PointsListText
})

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
  const read = yield* pointsListFromText(text, path)
  yield* Effect.forEach(read.notes, (note) => Console.error(note), { discard: true })
  return read.list
})

/**
 * The config file's text with `added` after its devices, every other key as it was, formatted as `init` writes
 * it; `existing` is how many devices it had, where the added ones start.
 */
export const withDevicesAdded = Effect.fn("withDevicesAdded")(function* (
  configText: string,
  added: ReadonlyArray<PointsListDevice>
) {
  const raw = yield* Schema.decodeUnknownEffect(ConfigObject)(configText)
  return devicesAppended(raw, added)
})

const devicesAppended = (raw: Readonly<Record<string, unknown>>, added: ReadonlyArray<PointsListDevice>) => {
  const devices: ReadonlyArray<unknown> = Array.isArray(raw["devices"]) ? raw["devices"] : []
  return {
    text: `${JSON.stringify({ ...raw, devices: [...devices, ...added] }, null, 2)}\n`,
    existing: devices.length
  }
}

export interface ImportResult {
  readonly added: ReadonlyArray<PointsListDevice>
  /** The same devices as the gateway reads them, with every default filled in. */
  readonly decoded: ReadonlyArray<Device>
  /** The config as written, or `undefined` for a dry run. */
  readonly config: GatewayConfig | undefined
  /** The config the devices were checked against, or `undefined` when a dry run checked them on their own. */
  readonly against: string | undefined
}

/** The config `import` adds to when the command names none, as every command that takes a config. */
export const defaultConfigPath = "ot-gateway.json"

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
 * Adds the devices in the points list at `listPath` to the config at `configPath` (`ot-gateway.json` when
 * undefined), or, for a dry run, checks them and prints them. Either way they pass the gateway's schema first.
 *
 * A config that is not there is an error that names `init`: `import` never makes one. The one exception is a dry
 * run that names no config, the check of a list before `init` (docs/first-building.md): without an
 * `ot-gateway.json` here, its devices are checked on their own, and `against` says so.
 */
export const importPointsList = Effect.fn("importPointsList")(function* (
  listPath: string,
  configPath: string | undefined,
  options: { readonly dryRun: boolean }
) {
  const fs = yield* FileSystem.FileSystem
  const path = configPath ?? defaultConfigPath
  const exists = yield* fs.exists(path)
  const checkOnly = options.dryRun && configPath === undefined && !exists
  if (!exists && !checkOnly) {
    return yield* new PointsListError({
      message: `no config at ${path}; import adds to one and never makes one. ot-gateway init <folder> --points ${listPath} writes the gateway's folder with this list's devices; or name the config that is there: ot-gateway import ${listPath} <config>`
    })
  }
  const existing = checkOnly ? [] : (yield* loadConfig(path)).devices.map((device) => device.id)
  const added = yield* devicesFromFile(listPath, existing)
  const raw = checkOnly
    ? checkOnlyConfig
    : yield* Schema.decodeUnknownEffect(ConfigObject)(yield* fs.readFileString(path))
  const { text, existing: devices } = devicesAppended(raw, added)
  const target = checkOnly ? "a config" : path
  const outcome = options.dryRun ? "" : ", so nothing was written"
  const config = yield* parseConfig(text).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        new PointsListError({
          message: `the points list would make ${target} invalid${outcome}. Its devices start at devices[${devices}]:\n${error.message}`
        })
      )
    )
  )
  const decoded = config.devices.slice(devices)
  const against = checkOnly ? undefined : path
  if (options.dryRun) return { added, decoded, config: undefined, against } satisfies ImportResult
  yield* fs.writeFileString(path, text)
  return { added, decoded, config, against } satisfies ImportResult
})
