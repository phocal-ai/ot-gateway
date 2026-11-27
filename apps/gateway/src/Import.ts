/**
 * `ot-gateway import`: the devices of a points list (see PointsList.ts) added to a config. The file keeps every
 * key it had; the result is checked with the gateway's schema before it is written, so a list that would break
 * the config changes nothing.
 */
import { type Device, type GatewayConfig, parseConfig } from "@ot-gateway/core"
import { Console, Effect, FileSystem, Schema } from "effect"
import { configIssues, etagOf, makeConfigStore } from "./ConfigStore.ts"
import { loadConfig } from "./LoadConfig.ts"
import {
  devicesFromPointsList,
  listFields,
  type PointsListDevice,
  PointsListError,
  profileNames,
  type UnitMapping,
  unitsWritten
} from "./PointsList.ts"
import { unknownColumns } from "./PointsSchema.ts"
import { describeTranslation, edeToPointsList, isEde } from "./Ede.ts"
import { resolveProfile } from "./Profile.ts"
import { dirname } from "node:path"
import { nounFor } from "./Words.ts"

/** The devices of the points list at `path`, with the profiles it names (Profile.ts) loaded. */
export const devicesFromFile = Effect.fn("devicesFromFile")(function* (
  path: string,
  existing: ReadonlyArray<string> = []
) {
  return yield* devicesFromText(yield* readPointsList(path), path, existing)
})

/** The devices of a points list's `text`, read from `path`: the profiles it names are found next to it. */
const devicesFromText = Effect.fnUntraced(function* (text: string, path: string, existing: ReadonlyArray<string>) {
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
  const ignored = unknownColumns(listFields(text)[0] ?? [])
  return {
    list: text,
    format: "points-list",
    notes:
      ignored.length === 0
        ? []
        : [
            `${source}: ignored ${nounFor(ignored.length, "column")} ${ignored.join(", ")} (ot-gateway points schema lists the known ones)`
          ]
  } satisfies PointsListText
})

/** In place of a points list's path: the list is given as text (`--text`), not read from a file. */
export const givenAsText = "-"

/** The most a list given as text may be: 100,000 points are about 10 MB. */
const GIVEN_BYTES = 32 * 1024 * 1024

/**
 * The points list's text and what to call it: the file at `path`, or `given` when the list came as text, which
 * `path` must then say with `-` so a file named by mistake is not passed over.
 */
export const pointsListSource = Effect.fn("pointsListSource")(function* (
  path: string,
  given: string | undefined,
  what = "points list"
) {
  if (given === undefined) {
    if (path === givenAsText) {
      return yield* new PointsListError({ message: `- stands for a ${what} given with --text, and there is none` })
    }
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs
      .readFileString(path)
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.fail(new PointsListError({ message: `no ${what} at ${path}` }))
        )
      )
    return { text, source: path }
  }
  if (path !== givenAsText) {
    return yield* new PointsListError({
      message: `${path} and --text both name a ${what}: write - in place of the file to take the text`
    })
  }
  if (given.length > GIVEN_BYTES) {
    return yield* new PointsListError({
      message: `the ${what} given as text is over 32 MB: save it as a file and name that`
    })
  }
  return { text: given, source: `the ${what} given` }
})

/**
 * The points list at `path` (or `given` as text), as text; an EDE file comes back translated into one (Ede.ts).
 */
export const readPointsList = Effect.fn("readPointsList")(function* (path: string, given?: string) {
  const { text, source } = yield* pointsListSource(path, given)
  const read = yield* pointsListFromText(text, source)
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
  /** Each unit the list writes and what goes out for it in `$meta`. */
  readonly units: ReadonlyArray<UnitMapping>
}

/**
 * The units of an import, one line each: what the list wrote, the QUDT name the `$meta` carries, on how many points.
 * A unit without a QUDT name is kept as written and said so: consumers that read QUDT names cannot read it.
 */
export const describeUnits = (units: ReadonlyArray<UnitMapping>) =>
  units.length === 0
    ? []
    : [
        "units, as the $meta of each point carries them (QUDT names):",
        ...units.map((mapping) => {
          const points = `${mapping.points} point${mapping.points === 1 ? "" : "s"}`
          if (!mapping.qudt) {
            const meant = mapping.suggestion === undefined ? "" : ` (did you mean ${mapping.suggestion}?)`
            return `  ${mapping.written}  kept as written: no QUDT name known for it${meant}; write one (unit:…) if consumers need it  (${points})`
          }
          return mapping.unit === mapping.written
            ? `  ${mapping.unit}  (${points})`
            : `  ${mapping.written} -> ${mapping.unit}  (${points})`
        })
      ]

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
  options: {
    readonly dryRun: boolean
    readonly command?: string | undefined
    /** The list itself, when `listPath` is `-`. */
    readonly text?: string | undefined
  }
) {
  const fs = yield* FileSystem.FileSystem
  const cli = options.command ?? "ot-gateway"
  const path = configPath ?? defaultConfigPath
  const exists = yield* fs.exists(path)
  const checkOnly = options.dryRun && configPath === undefined && !exists
  if (!exists && !checkOnly) {
    return yield* new PointsListError({
      message: `no config at ${path}; import adds to one and never makes one. ${cli} init <folder>${listPath === givenAsText ? "" : ` --points ${listPath}`} writes the gateway's folder${listPath === givenAsText ? "" : " with this list's devices"}; or name the config that is there: ${cli} import ${listPath} <config>`
    })
  }
  const existing = checkOnly ? [] : (yield* loadConfig(path)).devices.map((device) => device.id)
  const listText = yield* readPointsList(listPath, options.text)
  const added = yield* devicesFromText(listText, listPath, existing)
  const units = unitsWritten(listText)
  // One read: the text the devices are appended to and the ETag the save checks, so a change in between is refused.
  const fileText = checkOnly ? "" : yield* fs.readFileString(path)
  const etag = etagOf(fileText)
  const raw = checkOnly ? checkOnlyConfig : yield* Schema.decodeUnknownEffect(ConfigObject)(fileText)
  const { text, existing: devices } = devicesAppended(raw, added)
  const target = checkOnly ? "a config" : path
  const outcome = options.dryRun ? "" : ", so nothing was written"
  const config = yield* parseConfig(text).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        new PointsListError({
          message: `the points list would make ${target} invalid${outcome}. Its devices start at devices[${devices}]:\n${error.message}`,
          issues: configIssues(error.issue).map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        })
      )
    )
  )
  const decoded = config.devices.slice(devices)
  const against = checkOnly ? undefined : path
  if (options.dryRun) return { added, decoded, config: undefined, against, units } satisfies ImportResult
  const store = yield* makeConfigStore(path)
  yield* store.save(text, etag).pipe(
    Effect.catchTags({
      ConfigConflict: () =>
        Effect.fail(
          new PointsListError({
            message: `${path} changed while the import ran (saved from the status page, or edited): nothing was written; run the import again`
          })
        ),
      ConfigInvalid: (error) => Effect.fail(new PointsListError({ message: error.message })),
      ConfigUnreadable: (error) => Effect.fail(new PointsListError({ message: error.message })),
      ConfigWriteFailed: (error) =>
        Effect.fail(new PointsListError({ message: `${error.message}; ${path} is as it was` }))
    })
  )
  return { added, decoded, config, against, units } satisfies ImportResult
})
