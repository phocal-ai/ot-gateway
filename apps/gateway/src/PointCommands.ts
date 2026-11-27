/**
 * `ot-gateway points allow-commands` and `points read-only`: whether one point takes commands, set in the config
 * file as the status page's "Allow commands…" sets it (`writable: true` with `limits`, or both taken out again).
 *
 * This is the one command that makes a point writable, so a person or an agent does it on purpose: one point per
 * call, named as `device/point`, never a list or a pattern, and a number only with the lowest and highest value a
 * command may set. The file keeps every other key; the result passes the gateway's schema before it is written
 * (a BACnet device needs a fixed address, an input register stays read-only), and the previous file is the `.bak`.
 * Nothing is sent to a device: the running gateway reads the file when it restarts, and every command still goes
 * through the command guard (VISION.md, principle 6).
 */
import {
  type AnyPoint,
  type Device,
  type GatewayConfig,
  type Limits,
  parseConfig,
  pointTopic,
  writeKind
} from "@ot-gateway/core"
import { Effect, FileSystem, Predicate, Schema } from "effect"
import { configIssues, describeIssues, etagOf, makeConfigStore } from "./ConfigStore.ts"
import { ConfigFileIssue, loadConfig } from "./LoadConfig.ts"
import { pointCatalog } from "./PointCatalog.ts"

/** Why a point's commands were not changed; nothing was written. */
export class PointCommandsFailed extends Schema.TaggedError<PointCommandsFailed>()("PointCommandsFailed", {
  message: Schema.String,
  code: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  issues: Schema.optionalKey(Schema.Array(ConfigFileIssue))
}) {}

/** What to do with a point: take commands (a number within `limits`), or none. */
export type PointCommandsChange =
  | { readonly allow: true; readonly min?: number | undefined; readonly max?: number | undefined }
  | { readonly allow: false }

export interface PointCommandsReport {
  readonly ok: true
  readonly path: string
  readonly dryRun: boolean
  /** `device/point`. */
  readonly point: string
  readonly name: string
  /** Where the point is on its device, in the config's words. */
  readonly source: string
  /** Where its values arrive. */
  readonly topic: string
  /** Where it takes commands, when it does. */
  readonly setTopic?: string
  readonly writable: boolean
  readonly limits?: Limits
  /** What it takes: true or false, a state number, or a number. */
  readonly takes: "binary" | "multi-state" | "number"
  /** False when the file said so already: nothing was written. */
  readonly changed: boolean
  /** The previous file, kept by the save. */
  readonly backup?: string
  readonly next: ReadonlyArray<{ readonly command: string; readonly description: string }>
}

/** The config file as it is, every key kept. */
const ConfigObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const hasId = (value: unknown, id: string): value is Readonly<Record<string, unknown>> =>
  Predicate.isObject(value) && Predicate.hasProperty(value, "id") && value.id === id

const listOf = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

/**
 * The config file's object with one point's `writable` and `limits` set or taken out, every other key (and the
 * key order of the point) as it was. The point is one the decoded config has, so it is found here too.
 */
export const withPointCommands = (
  raw: Readonly<Record<string, unknown>>,
  target: { readonly device: string; readonly point: string },
  commands: { readonly writable: true; readonly limits?: Limits | undefined } | { readonly writable: false }
): Readonly<Record<string, unknown>> => ({
  ...raw,
  devices: listOf(raw["devices"]).map((device) =>
    hasId(device, target.device)
      ? {
          ...device,
          points: listOf(device["points"]).map((point) => {
            if (!hasId(point, target.point)) return point
            const { writable: _writable, limits: _limits, ...rest } = point
            return commands.writable
              ? { ...rest, writable: true, ...(commands.limits === undefined ? {} : { limits: commands.limits }) }
              : rest
          })
        }
      : device
  )
})

const sameLimits = (a: Limits | undefined, b: Limits | undefined) => a?.min === b?.min && a?.max === b?.max

const pointNames = (device: Device) => {
  const ids = device.points.map((point) => `${device.id}/${point.id}`)
  return `${ids.slice(0, 10).join(", ")}${ids.length > 10 ? `, and ${ids.length - 10} more` : ""}`
}

/** The device and point `target` names, or that the config has none. */
const find = (config: GatewayConfig, target: { readonly device: string; readonly point: string }, path: string) => {
  const device = config.devices.find((candidate) => candidate.id === target.device)
  const point = device?.points.find((candidate) => candidate.id === target.point)
  if (device !== undefined && point !== undefined) return { device, point }
  return new PointCommandsFailed({
    message: `${target.device}/${target.point}: ${device === undefined ? "no such device" : "no such point"} in ${path}`,
    code: "unknown-point",
    hint:
      device === undefined
        ? `its devices: ${config.devices.map((each) => each.id).join(", ") || "none"}`
        : `its points: ${pointNames(device)}`
  })
}

/**
 * The limits a change asks for on `point`: both ends for a number (the ones it has stay when none is named), none
 * for a switch.
 */
const limitsFor = (
  device: Device,
  point: AnyPoint,
  change: { readonly min?: number | undefined; readonly max?: number | undefined },
  cli: string
): Limits | undefined | PointCommandsFailed => {
  const target = `${device.id}/${point.id}`
  const kind = writeKind(device, point)
  const named = change.min !== undefined || change.max !== undefined
  if (kind === "binary") {
    return named
      ? new PointCommandsFailed({
          message: `${target} is a switch: it takes true or false, so it has no lowest and highest value`,
          code: "invalid-limits",
          hint: `${cli} points allow-commands ${target}`
        })
      : undefined
  }
  const what = kind === "multi-state" ? "state number" : "value"
  if (!named && point.limits !== undefined) return point.limits
  if (change.min === undefined || change.max === undefined) {
    return new PointCommandsFailed({
      message: `${target} takes a number, so it needs the lowest and the highest ${what} a command may set: there is no unlimited write`,
      code: "invalid-limits",
      hint: `${cli} points allow-commands ${target} --min=<lowest> --max=<highest>, in the point's unit${point.unit === undefined ? "" : ` (${point.unit})`}; ask the person who runs the building when they did not name them`
    })
  }
  if (change.min > change.max) {
    return new PointCommandsFailed({
      message: `${target}: --min ${change.min} is above --max ${change.max}`,
      code: "invalid-limits",
      hint: `${cli} points allow-commands ${target} --min=${change.max} --max=${change.min}`
    })
  }
  return { min: change.min, max: change.max }
}

/**
 * Lets the point `target` of the config at `path` take commands, or none any more. A dry run checks and reports
 * without writing.
 */
export const setPointCommands = Effect.fn("setPointCommands")(function* (
  path: string,
  target: { readonly device: string; readonly point: string },
  change: PointCommandsChange,
  options: { readonly dryRun: boolean; readonly command?: string | undefined }
) {
  const fs = yield* FileSystem.FileSystem
  const cli = options.command ?? "ot-gateway"
  const name = `${target.device}/${target.point}`
  const current = yield* loadConfig(path)
  const found = find(current, target, path)
  if (found instanceof PointCommandsFailed) return yield* found
  const limits = change.allow ? limitsFor(found.device, found.point, change, cli) : undefined
  if (limits instanceof PointCommandsFailed) return yield* limits

  // One read: the text that is changed and the ETag the save checks, so a change in between is refused.
  const fileText = yield* fs.readFileString(path)
  const raw = yield* Schema.decodeUnknownEffect(ConfigObject)(fileText)
  const text = `${JSON.stringify(
    withPointCommands(raw, target, change.allow ? { writable: true, limits } : { writable: false }),
    null,
    2
  )}\n`
  const config = yield* parseConfig(text).pipe(
    Effect.catchTag("SchemaError", (error) => {
      const issues = configIssues(error.issue)
      return Effect.fail(
        new PointCommandsFailed({
          message: `${name} cannot take commands${options.dryRun ? "" : ", so nothing was written"}:\n${describeIssues(issues).join("\n")}`,
          code: "invalid-config",
          hint: `fix what the message names in ${path}, then run this again; ${cli} explain invalid-config`,
          issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        })
      )
    })
  )
  const info = pointCatalog(config).points.find((each) => each.device === target.device && each.id === target.point)
  const after = find(config, target, path)
  if (after instanceof PointCommandsFailed || info === undefined) {
    return yield* Effect.die(new Error(`${name} was in ${path} before the change and is not after it`))
  }
  const changed = found.point.writable !== after.point.writable || !sameLimits(found.point.limits, after.point.limits)
  const topic = pointTopic({ site: config.site, building: config.building, device: target.device, point: target.point })
  const saved = changed && !options.dryRun
  if (saved) {
    const store = yield* makeConfigStore(path)
    yield* store.save(text, etagOf(fileText)).pipe(
      Effect.catchTags({
        ConfigConflict: () =>
          Effect.fail(
            new PointCommandsFailed({
              message: `${path} changed while this ran (saved from the status page, or edited): nothing was written`,
              code: "config-not-saved",
              hint: "run it again"
            })
          ),
        ConfigInvalid: (error) =>
          Effect.fail(new PointCommandsFailed({ message: error.message, code: "invalid-config" })),
        ConfigUnreadable: (error) =>
          Effect.fail(new PointCommandsFailed({ message: error.message, code: "config-not-saved" })),
        ConfigWriteFailed: (error) =>
          Effect.fail(
            new PointCommandsFailed({
              message: `${error.message}; ${path} is as it was`,
              code: "config-not-saved",
              hint: `the user running this must be able to write ${path} and its folder`
            })
          )
      })
    )
  }
  const next = !changed
    ? []
    : options.dryRun
      ? [
          {
            command: `${cli} points ${change.allow ? "allow-commands" : "read-only"} ${name}${
              after.point.limits === undefined ? "" : ` --min=${after.point.limits.min} --max=${after.point.limits.max}`
            }`,
            description: "Write it into the config"
          }
        ]
      : [
          {
            command: `${cli} diff ${path}`,
            description: "What the saved config changes on the broker against the running gateway"
          },
          {
            command: `${cli} restart ${path}`,
            description: "The running gateway reads the config again; under systemd, restart its service"
          },
          ...(after.point.writable
            ? [{ command: `${cli} write ${name} <value>`, description: "Send a command and see its result" }]
            : [])
        ]
  return {
    ok: true,
    path,
    dryRun: options.dryRun,
    point: name,
    name: after.point.name,
    source: info.source,
    topic,
    ...(after.point.writable ? { setTopic: `${topic}/$set` } : {}),
    writable: after.point.writable,
    ...(after.point.limits === undefined ? {} : { limits: after.point.limits }),
    takes: writeKind(after.device, after.point),
    changed,
    ...(saved ? { backup: `${path}.bak` } : {}),
    next
  } satisfies PointCommandsReport
})

/** The report for a person: what the point takes now, where, and what to run next. */
export const formatPointCommands = (report: PointCommandsReport) => {
  const range = report.limits === undefined ? "" : `, ${report.limits.min} to ${report.limits.max}`
  const takes =
    report.takes === "binary" ? "true or false" : report.takes === "multi-state" ? "a state number" : "a number"
  const would = report.dryRun && report.changed
  const state = report.writable
    ? `${would ? "would take" : "takes"} commands${report.changed ? (would ? "" : " now") : " already"}: ${takes}${range}`
    : `${would ? "would be" : "is"} read-only${report.changed ? (would ? "" : " now") : " already"}: commands are refused`
  return [
    `${would ? "–" : "✓"} ${report.point} (${report.name}) ${state}`,
    `  on the device: ${report.source}`,
    ...(report.setTopic === undefined ? [] : [`  commands on:   ${report.setTopic}`]),
    ...(report.backup === undefined ? [] : [`  saved ${report.path}; the previous one is ${report.backup}`]),
    ...(report.changed ? [] : [`  ${report.path} said so, nothing was written`]),
    ...report.next.map((step) => `  next: ${step.command}   # ${step.description}`)
  ].join("\n")
}
