/**
 * `ot-gateway config get|set|unset|remove|undo`: the config file changed key by key from the command line, so a
 * person or an agent does what the status page's forms do without editing JSON by hand.
 *
 * A key is named by its path, dots between: `mqtt.url`, `status.bindAddress`, and below `devices` by ids rather
 * than positions, `devices.heat-pump.pollIntervalMs`, `devices.heat-pump.points.setpoint.unit`. A value is JSON
 * when it reads as JSON (`5000`, `true`, `{"factor": 0.1}`) and text otherwise. Every change passes the gateway's
 * schema before the file is written (ConfigFileEdit.ts), and none makes a point writable or changes what a command
 * may set: that is `points allow-commands`, the one door for writes.
 */
import { GatewayConfig, type Limits, parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem, Predicate, Result, Schema } from "effect"
import { describeConfigChange } from "./ConfigChange.ts"
import { configIssues, describeIssues, makeConfigStore } from "./ConfigStore.ts"
import { afterSave, ConfigEditFailed, type ConfigEdited, editConfigFile, type RawConfig } from "./ConfigFileEdit.ts"
import { defaultConfigPath } from "./Import.ts"
import { loadConfig } from "./LoadConfig.ts"
import { shellArgument } from "./Output.ts"

/** ` --config=<path>` for a command to run again, when the config is not the one a command finds itself. */
const configFlag = (path: string) => (path === defaultConfigPath ? "" : ` --config=${shellArgument(path)}`)

type Next = ReadonlyArray<{ readonly command: string; readonly description: string }>

/** `mqtt.url` as its keys; an empty path names the whole config. */
export const parsePath = (path: string): ReadonlyArray<string> =>
  path
    .trim()
    .split(".")
    .filter((segment) => segment !== "")

/** A value as typed: JSON when it reads as JSON, text otherwise (`mqtts://broker:8883`, `unit:DEG_C`). */
export const parseValue = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return text
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Predicate.isObject(value) && !Array.isArray(value)

/** Where `segment` is in a list: the item with that id (a device, a point), or a position. */
const indexIn = (list: ReadonlyArray<unknown>, segment: string) => {
  const byId = list.findIndex((item) => isRecord(item) && item["id"] === segment)
  if (byId >= 0) return byId
  return /^\d+$/.test(segment) && Number(segment) < list.length ? Number(segment) : -1
}

/** What a list holds, for a hint: its ids, or how many items. */
const listed = (list: ReadonlyArray<unknown>) => {
  const ids = list.flatMap((item) => (isRecord(item) && typeof item["id"] === "string" ? [item["id"]] : []))
  if (ids.length === 0) return `it has ${list.length} items, 0 to ${list.length - 1}`
  return `it has ${ids.slice(0, 10).join(", ")}${ids.length > 10 ? `, and ${ids.length - 10} more` : ""}`
}

/** The value at `segments` below `node`, or `undefined` when a key on the way is not there. */
export const valueAt = (node: unknown, segments: ReadonlyArray<string>): unknown => {
  const [head, ...rest] = segments
  if (head === undefined) return node
  if (Array.isArray(node)) {
    const list: ReadonlyArray<unknown> = node
    const index = indexIn(list, head)
    return index < 0 ? undefined : valueAt(list[index], rest)
  }
  return isRecord(node) ? valueAt(node[head], rest) : undefined
}

const noSuch = (message: string, hint: string) => new ConfigEditFailed({ message, code: "unknown-key", hint })

/**
 * `node` with the value at `segments` replaced by `value`, or taken out when `value` is `undefined`. Keys that are
 * missing on the way are made (a `status` block for `status.bindAddress`); list items are not: a device or point
 * comes from `import` or `discover`.
 */
const changedAt = (
  node: unknown,
  segments: ReadonlyArray<string>,
  value: unknown,
  walked: ReadonlyArray<string> = []
): Result.Result<unknown, ConfigEditFailed> => {
  const [head, ...rest] = segments
  if (head === undefined) return Result.succeed(value)
  const here = walked.join(".") || "the config"
  if (Array.isArray(node)) {
    const list: ReadonlyArray<unknown> = node
    const index = indexIn(list, head)
    if (index < 0) return Result.fail(noSuch(`${here} has no ${head}`, listed(list)))
    if (rest.length === 0 && value === undefined) return Result.succeed(list.filter((_, at) => at !== index))
    return Result.map(changedAt(list[index], rest, value, [...walked, head]), (item) =>
      list.map((each, at) => (at === index ? item : each))
    )
  }
  if (node !== undefined && !isRecord(node)) {
    return Result.fail(noSuch(`${here} is ${JSON.stringify(node)}, which has no keys`, `set ${here} itself`))
  }
  const record = node ?? {}
  if (rest.length === 0 && value === undefined) {
    const { [head]: _removed, ...kept } = record
    return Result.succeed(kept)
  }
  if (value === undefined && !(head in record)) return Result.succeed(record)
  return Result.map(changedAt(record[head], rest, value, [...walked, head]), (child) => ({ ...record, [head]: child }))
}

/** The config file's object with one key set, or taken out (`value` undefined). */
export const withValue = (
  raw: RawConfig,
  segments: ReadonlyArray<string>,
  value: unknown
): RawConfig | ConfigEditFailed => {
  if (segments.length === 0) {
    return noSuch("name a key: mqtt.url, devices.<device>.pollIntervalMs", "ot-gateway config get lists the config")
  }
  const changed = changedAt(raw, segments, value)
  if (Result.isFailure(changed)) return changed.failure
  return isRecord(changed.success) ? changed.success : noSuch("the config is an object of keys", "name a key below it")
}

const sameLimits = (a: Limits | undefined, b: Limits | undefined) => a?.min === b?.min && a?.max === b?.max

/**
 * Every point whose commands a change would touch, as `device/point`: one that takes commands and did not before
 * (under this id: a renamed device's `$set` topics are new ones), or whose limits are other ones, writable or not.
 * A point that takes none any more, or is gone, is not among them: less may always be written.
 */
export const writesTouched = (before: GatewayConfig, after: GatewayConfig): ReadonlyArray<string> =>
  after.devices.flatMap((device) => {
    const was = before.devices.find((each) => each.id === device.id)
    return device.points.flatMap((point) => {
      const previous = was?.points.find((each) => each.id === point.id)
      const allowed = point.writable && previous?.writable !== true
      const limits = point.limits !== undefined && !sameLimits(point.limits, previous?.limits)
      return allowed || limits ? [`${device.id}/${point.id}`] : []
    })
  })

/** No change here makes a point writable or sets what a command may write: that is `points allow-commands`. */
const writesStayAsTheyAre = (cli: string) => (before: GatewayConfig, after: GatewayConfig) => {
  const touched = writesTouched(before, after)
  return touched.length === 0
    ? undefined
    : new ConfigEditFailed({
        message: `this would change which commands the gateway takes on ${touched.slice(0, 5).join(", ")}${touched.length > 5 ? `, and ${touched.length - 5} more` : ""}, which config set does not do`,
        code: "writes-not-here",
        hint: `${cli} points allow-commands <device/point> --min=<lowest> --max=<highest> lets one point take commands, on purpose; to rename a device or point that takes commands, make it read-only first (${cli} points read-only) and allow them again after`
      })
}

export interface ConfigChangeReport {
  readonly ok: true
  readonly path: string
  readonly dryRun: boolean
  /** The key as named, or the device or point removed. */
  readonly key: string
  /** The value in the file before and after; `null` with `set: false` when the key is not in the file. */
  readonly before: unknown
  readonly after: unknown
  /** The value the gateway runs with, defaults filled in. */
  readonly effective: unknown
  readonly changed: boolean
  /** What the change does, part by part. */
  readonly changes: ReadonlyArray<string>
  readonly backup?: string
  readonly next: Next
}

const reportOf = (
  path: string,
  key: string,
  dryRun: boolean,
  edited: ConfigEdited<{ readonly before: unknown; readonly after: unknown; readonly effective: unknown }>,
  again: string,
  cli: string
): ConfigChangeReport => ({
  ok: true,
  path,
  dryRun,
  key,
  before: edited.report.before ?? null,
  after: edited.report.after ?? null,
  effective: edited.report.effective ?? null,
  changed: edited.changed,
  changes: edited.changes,
  ...(edited.backup === undefined ? {} : { backup: edited.backup }),
  next: !edited.changed
    ? []
    : dryRun
      ? [{ command: again, description: "Write it into the config" }]
      : afterSave(cli, path)
})

/** Set the key `key` of the config at `path` to `value`, or take it out (`value` undefined: its default applies). */
export const setConfigValue = Effect.fn("setConfigValue")(function* (
  path: string,
  key: string,
  value: { readonly set: string } | { readonly unset: true },
  options: { readonly dryRun: boolean; readonly command?: string | undefined }
) {
  const cli = options.command ?? "ot-gateway"
  const segments = parsePath(key)
  const again =
    "set" in value
      ? `${cli} config set ${shellArgument(key)} ${value.set.startsWith("-") ? `--value=${shellArgument(value.set)}` : shellArgument(value.set)}${configFlag(path)}`
      : `${cli} config unset ${shellArgument(key)}${configFlag(path)}`
  const edited = yield* editConfigFile(
    path,
    {
      again,
      refused: `${key} cannot be ${"set" in value ? `set to ${value.set}` : "taken out"}`,
      change: (raw) => {
        const wanted = "set" in value ? parseValue(value.set) : undefined
        const changed = withValue(raw, segments, wanted)
        if (changed instanceof ConfigEditFailed) return changed
        return {
          raw: changed,
          report: (after) => ({
            before: valueAt(raw, segments),
            after: wanted,
            // A device or point given another id is no longer found under the old one: what was set stands.
            effective: valueAt(after, segments) ?? wanted
          })
        }
      },
      allowed: writesStayAsTheyAre(cli)
    },
    options
  )
  return reportOf(path, key, options.dryRun, edited, again, cli)
})

/** Take the device `target` (or its point, `device/point`) out of the config at `path`. */
export const removeFromConfig = Effect.fn("removeFromConfig")(function* (
  path: string,
  target: string,
  options: { readonly dryRun: boolean; readonly command?: string | undefined }
) {
  const cli = options.command ?? "ot-gateway"
  const [device = "", point, ...more] = target.trim().split("/")
  const segments = point === undefined ? ["devices", device] : ["devices", device, "points", point]
  const again = `${cli} config remove ${shellArgument(target)}${configFlag(path)}`
  if (device === "" || point === "" || more.length > 0) {
    return yield* new ConfigEditFailed({
      message: `${target} names no device or device/point`,
      code: "unknown-key",
      hint: `${cli} config remove <device> or <device>/<point>`
    })
  }
  const edited = yield* editConfigFile(
    path,
    {
      again,
      refused: `${target} cannot be removed`,
      change: (raw) => {
        const before = valueAt(raw, segments)
        if (before === undefined) {
          const devices = valueAt(raw, ["devices"])
          const points = valueAt(raw, ["devices", device, "points"])
          const within = point !== undefined && Array.isArray(points) ? points : Array.isArray(devices) ? devices : []
          return noSuch(
            `${target}: no such ${point !== undefined && Array.isArray(points) ? "point" : "device"} in ${path}`,
            listed(within)
          )
        }
        const changed = withValue(raw, segments, undefined)
        if (changed instanceof ConfigEditFailed) return changed
        return { raw: changed, report: () => ({ before, after: undefined, effective: undefined }) }
      }
    },
    options
  )
  return reportOf(path, target, options.dryRun, edited, again, cli)
})

export interface ConfigGetReport {
  readonly ok: true
  readonly path: string
  readonly key: string
  /** Whether the file has the key; when not, `value` is null and `effective` its default. */
  readonly set: boolean
  readonly value: unknown
  readonly effective: unknown
}

/** The value of `key` in the config at `path`: as the file has it, and as the gateway runs with it. */
export const getConfigValue = Effect.fn("getConfigValue")(function* (path: string, key: string) {
  const fs = yield* FileSystem.FileSystem
  const config = yield* loadConfig(path)
  const raw = yield* Effect.orElseSucceed(
    Effect.flatMap(fs.readFileString(path), Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
    () => undefined
  )
  const segments = parsePath(key)
  const value = valueAt(raw, segments)
  // The config as its JSON again, every default filled in.
  const effective = valueAt(yield* Effect.orDie(Schema.encodeEffect(GatewayConfig)(config)), segments)
  if (value === undefined && effective === undefined) {
    return yield* noSuch(
      `${path} has no ${key}`,
      "ot-gateway config get lists the config; docs/configuration.md has every key"
    )
  }
  return {
    ok: true,
    path,
    key,
    set: value !== undefined,
    value: value ?? null,
    effective: effective ?? null
  } satisfies ConfigGetReport
})

const notSaved = (message: string, hint?: string) =>
  new ConfigEditFailed({ message, code: "config-not-saved", ...(hint === undefined ? {} : { hint }) })

export interface ConfigUndoReport {
  readonly ok: true
  readonly path: string
  readonly dryRun: boolean
  readonly restored: string
  readonly changed: boolean
  readonly changes: ReadonlyArray<string>
  readonly backup?: string
  readonly next: Next
}

/**
 * The previous config back: the file and its `.bak` change places, so a second undo brings the change back. The
 * `.bak` is what the last save replaced, from this CLI, `import` or the status page.
 */
export const undoConfig = Effect.fn("undoConfig")(function* (
  path: string,
  options: { readonly dryRun: boolean; readonly command?: string | undefined }
) {
  const fs = yield* FileSystem.FileSystem
  const cli = options.command ?? "ot-gateway"
  const backup = `${path}.bak`
  const again = `${cli} config undo${configFlag(path)}`
  const current = yield* loadConfig(path)
  const store = yield* makeConfigStore(path)
  const file = yield* store.read.pipe(Effect.mapError((error) => notSaved(error.message)))
  const previous = yield* fs.readFileString(backup).pipe(
    Effect.mapError(
      () =>
        new ConfigEditFailed({
          message: `no ${backup}: nothing to go back to`,
          code: "no-backup",
          hint: "a save from this CLI or the status page keeps the previous config there"
        })
    )
  )
  const restored = yield* parseConfig(previous).pipe(
    Effect.catchTag("SchemaError", (error) => {
      const issues = configIssues(error.issue)
      return Effect.fail(
        new ConfigEditFailed({
          message: `${backup} is not a config this release reads, so nothing was written:\n${describeIssues(issues).join("\n")}`,
          code: "invalid-config",
          issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        })
      )
    })
  )
  const changed = previous !== file.text
  const changes = describeConfigChange(current, restored).changes
  const saved = changed && !options.dryRun
  if (saved) {
    yield* store.save(previous, file.etag).pipe(
      Effect.catchTags({
        ConfigConflict: () =>
          Effect.fail(notSaved(`${path} changed while this ran: nothing was written`, `run it again: ${again}`)),
        ConfigInvalid: (error) => Effect.fail(new ConfigEditFailed({ message: error.message, code: "invalid-config" })),
        ConfigUnreadable: (error) => Effect.fail(notSaved(error.message)),
        ConfigWriteFailed: (error) => Effect.fail(notSaved(`${error.message}; ${path} is as it was`))
      })
    )
  }
  return {
    ok: true,
    path,
    dryRun: options.dryRun,
    restored: backup,
    changed,
    changes,
    ...(saved ? { backup } : {}),
    next: !changed ? [] : options.dryRun ? [{ command: again, description: "Put it back" }] : afterSave(cli, path)
  } satisfies ConfigUndoReport
})

const shown = (value: unknown) => (value === null || value === undefined ? "not set" : JSON.stringify(value))

const nextLines = (next: Next) => next.map((step) => `  next: ${step.command}   # ${step.description}`)

/** A change for a person: the key, what it was and is, what that does, and what to run next. */
export const formatConfigChange = (report: ConfigChangeReport) => {
  const would = report.dryRun && report.changed
  const mark = would ? "–" : "✓"
  const removed = report.after === null && report.before !== null
  const head = !report.changed
    ? `${mark} ${report.key} is ${shown(report.before)} already, nothing was written`
    : removed
      ? `${mark} ${report.key} ${would ? "would be" : "was"} taken out of ${report.path}`
      : `${mark} ${report.key}: ${shown(report.before)} → ${shown(report.after)}${would ? " (not written)" : ""}`
  return [
    head,
    ...report.changes.map((change) => `  ${change}`),
    ...(report.backup === undefined ? [] : [`  saved ${report.path}; the previous one is ${report.backup}`]),
    ...nextLines(report.next)
  ].join("\n")
}

/** Text as it is, anything else as JSON. */
const plain = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2))

export const formatConfigGet = (report: ConfigGetReport) =>
  report.set
    ? plain(report.value)
    : `${plain(report.effective)}   (the default: ${report.path} does not set ${report.key})`

export const formatConfigUndo = (report: ConfigUndoReport) => {
  const would = report.dryRun && report.changed
  return [
    !report.changed
      ? `✓ ${report.path} and ${report.restored} are the same, nothing was written`
      : `${would ? "–" : "✓"} ${report.path} ${would ? "would be" : "is"} what ${report.restored} was`,
    ...report.changes.map((change) => `  ${change}`),
    ...(report.backup === undefined ? [] : [`  what it replaced is ${report.backup} now: undo again brings it back`]),
    ...nextLines(report.next)
  ].join("\n")
}
