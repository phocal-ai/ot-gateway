/**
 * What a config change does on the broker, before it is applied (`ot-gateway diff`): which topics appear, which go
 * silent, which move (a point or device renamed, the site or building changed), which points start or stop taking
 * commands, whose retained `$meta` changes, and which retained messages stay behind as ghosts.
 *
 * Both sides are the points page's catalog (`GET /api/points`, PointCatalog.ts) with the gateway's site, building
 * and id: the running gateway's as it answers, or a config file's as it would run. So the same comparison works
 * against what runs now and between two files. The settings (broker, devices' hosts) are compared on the
 * Settings tab's view of the config (`GET /api/config`), by key: which ones change, never their values, which may
 * be secret.
 *
 * A rename is a guess, said as one: a point that leaves and a point that arrives on the same device (or on a
 * device that arrives with the very same points) with the same source (register, object) is the same point under a
 * new name. Consumers then have to follow it to the new topic.
 *
 * Retained `$meta` of a point that leaves is cleared by the gateway itself on its next connection when its device
 * stays in the config under the same site, building and gateway id (StaleMeta.ts); otherwise it stays on the broker
 * describing a point nobody publishes, and the result says how to clear it. A retained health message stays the
 * same way when the gateway's site, building or id changes.
 */
import type { ConfigView, PointInfo } from "@ot-gateway/api"
import { type GatewayConfig, healthTopic } from "@ot-gateway/core"
import { Effect, type FileSystem } from "effect"
import { configView } from "./ConfigView.ts"
import { DEFAULT_STATUS_URL, gatewayName, targetOf } from "./GatewayTarget.ts"
import { loadConfig } from "./LoadConfig.ts"
import { shellArgument } from "./Output.ts"
import { pointCatalog } from "./PointCatalog.ts"
import { askGateway, fetchGatewayStatus, type GatewayAnswerUnreadable, GatewayUnreachable } from "./StatusReport.ts"
import { count, firstOf, LISTED, NAMED, plural } from "./Words.ts"

/** One side of the comparison: a gateway's identity, its points, and its settings by key. */
export interface DiffSide {
  readonly site: string
  readonly building: string
  readonly id: string
  readonly points: ReadonlyArray<PointInfo>
  readonly settings: ConfigView
}

export interface AddedTopic {
  readonly topic: string
  readonly device: string
  readonly point: string
  readonly writable: boolean
}

export interface RemovedTopic {
  readonly topic: string
  readonly device: string
  readonly point: string
  /** Whether the gateway clears the retained `$meta` itself; when not, it stays on the broker. */
  readonly metaCleared: boolean
}

/** Why a topic moved: the point's id, its device's id, or the site or building above them. */
export type MoveReason = "point" | "device" | "site"

export interface MovedTopic {
  readonly from: string
  readonly to: string
  readonly reason: MoveReason
  readonly metaCleared: boolean
}

export type WritableChange = "now writable" | "limits changed" | "no longer writable"

export interface WritableTopic {
  readonly topic: string
  readonly change: WritableChange
  readonly limits?: { readonly min: number; readonly max: number }
}

export interface MetaChange {
  readonly topic: string
  /** The retained `$meta` fields that change: name, unit, publish, cov, alarmWhen, brick, haystack, gateway. */
  readonly fields: ReadonlyArray<string>
}

export interface ValueChange {
  readonly topic: string
  /** What changes what the values mean on the same topic: `source` (register, object), `scaling`. */
  readonly fields: ReadonlyArray<string>
}

export interface ConfigDiff {
  /** Whether anything on the broker or in the settings changes. */
  readonly changed: boolean
  readonly added: ReadonlyArray<AddedTopic>
  readonly removed: ReadonlyArray<RemovedTopic>
  readonly moved: ReadonlyArray<MovedTopic>
  readonly writable: ReadonlyArray<WritableTopic>
  readonly meta: ReadonlyArray<MetaChange>
  readonly values: ReadonlyArray<ValueChange>
  /** Settings whose values change, as `section: key, key` (`mqtt: url`, `device meter: host`). */
  readonly settings: ReadonlyArray<string>
  /** The health topic, when the gateway's site, building or id changes. */
  readonly health?: { readonly from: string; readonly to: string }
  /**
   * Whether the broker's address changes: then every retained message of before stays on the old broker, and
   * `stale` lists them all.
   */
  readonly brokerChanged: boolean
  /** Retained topics that nobody clears: each `$meta` that stays, and the old health topic. */
  readonly stale: ReadonlyArray<string>
}

const key = (point: { readonly device: string; readonly id: string }) => `${point.device}/${point.id}`

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** What a point's retained `$meta` says (Pipeline.ts, `metaPayload`), as the catalog has it; writable apart. */
const metaFields = ["name", "unit", "publish", "cov", "alarmWhen", "brick", "haystack"] as const
/** What is not in `$meta` but changes what a topic's values mean. */
const valueFields = ["source", "scaling"] as const

/** One setting's value in a config view: `mqtt` `url`. */
const settingOf = (view: ConfigView, section: string, name: string) =>
  view.sections.find((each) => each.key === section)?.entries.find((entry) => entry.key === name)?.value

/** A device's sources, sorted: a device that arrives with the same ones as one that leaves is that one renamed. */
const sourcesOf = (points: ReadonlyArray<PointInfo>, device: string) =>
  JSON.stringify(
    points
      .filter((point) => point.device === device)
      .map((point) => point.source)
      .toSorted()
  )

/** The keys whose values differ between two lists of entries. */
const changedKeys = (
  was: ReadonlyArray<{ readonly key: string; readonly value: unknown }>,
  is: ReadonlyArray<{ readonly key: string; readonly value: unknown }>
) => {
  const old = new Map(was.map((entry) => [entry.key, entry.value]))
  const now = new Map(is.map((entry) => [entry.key, entry.value]))
  return [...new Set([...old.keys(), ...now.keys()])].filter((name) => !sameJson(old.get(name), now.get(name)))
}

/** The settings that differ, by key, section by section and device by device; no values. */
const settingsChanges = (before: ConfigView, after: ConfigView): ReadonlyArray<string> => {
  const lines: Array<string> = []
  const sections = new Map(before.sections.map((section) => [section.key, section.entries]))
  const sectionsAfter = new Map(after.sections.map((section) => [section.key, section.entries]))
  for (const name of new Set([...sections.keys(), ...sectionsAfter.keys()])) {
    const was = sections.get(name)
    const is = sectionsAfter.get(name)
    if (was === undefined) lines.push(`${name}: added`)
    else if (is === undefined) lines.push(`${name}: removed`)
    else {
      // The gateway's identity shows as moved topics already.
      const keys = changedKeys(was, is).filter(
        (each) => name !== "gateway" || !["site", "building", "id"].includes(each)
      )
      if (keys.length > 0) lines.push(`${name}: ${keys.join(", ")}`)
    }
  }
  const devices = new Map(before.devices.map((device) => [device.id, device]))
  for (const device of after.devices) {
    const was = devices.get(device.id)
    if (was === undefined) continue
    const keys = [
      ...(was.protocol === device.protocol ? [] : ["protocol"]),
      ...changedKeys(was.entries, device.entries)
    ]
    if (keys.length > 0) lines.push(`device ${device.id}: ${keys.join(", ")}`)
  }
  return lines
}

/** What changes on the broker when `after` replaces `before`. */
export const diffConfigs = (before: DiffSide, after: DiffSide): ConfigDiff => {
  const sameGateway = before.site === after.site && before.building === after.building && before.id === after.id
  const sameBase = before.site === after.site && before.building === after.building
  const devicesAfter = new Set(after.points.map((point) => point.device))
  const devicesBefore = new Set(before.points.map((point) => point.device))
  // The gateway clears a point's retained $meta when it still has the device, under the same name in the same place.
  const clearedBy = (device: string) => sameGateway && devicesAfter.has(device)

  // Devices that leave and arrive with the very same sources: renamed.
  const leaving = [...devicesBefore].filter((device) => !devicesAfter.has(device))
  const arriving = [...devicesAfter].filter((device) => !devicesBefore.has(device))
  const renamedDevice = new Map<string, string>()
  for (const device of leaving) {
    const sources = sourcesOf(before.points, device)
    const matches = arriving.filter((candidate) => sourcesOf(after.points, candidate) === sources)
    const [match] = matches
    if (matches.length === 1 && match !== undefined && ![...renamedDevice.values()].includes(match)) {
      renamedDevice.set(device, match)
    }
  }

  const afterByKey = new Map(after.points.map((point) => [key(point), point]))
  /** Pairs of the same point before and after, with why its topic moved when it did. */
  const pairs: Array<{ was: PointInfo; is: PointInfo; reason: MoveReason | undefined }> = []
  const paired = new Set<string>()
  const pairedAfter = new Set<string>()
  for (const point of before.points) {
    const same = afterByKey.get(key(point))
    if (same !== undefined) {
      pairs.push({ was: point, is: same, reason: sameBase ? undefined : "site" })
      paired.add(key(point))
      pairedAfter.add(key(same))
    }
  }
  for (const point of before.points) {
    if (paired.has(key(point))) continue
    const device = renamedDevice.get(point.device) ?? point.device
    const candidates = after.points.filter(
      (each) => each.device === device && each.source === point.source && !pairedAfter.has(key(each))
    )
    const [match] = candidates
    if (candidates.length === 1 && match !== undefined) {
      pairs.push({ was: point, is: match, reason: !sameBase ? "site" : device === point.device ? "point" : "device" })
      paired.add(key(point))
      pairedAfter.add(key(match))
    }
  }

  const removed = before.points
    .filter((point) => !paired.has(key(point)))
    .map((point) => ({
      topic: point.topic,
      device: point.device,
      point: point.id,
      metaCleared: clearedBy(point.device)
    }))
  const added = after.points
    .filter((point) => !pairedAfter.has(key(point)))
    .map((point) => ({ topic: point.topic, device: point.device, point: point.id, writable: point.writable }))
  const moved = pairs.flatMap(({ was, is, reason }) =>
    reason === undefined || was.topic === is.topic
      ? []
      : [{ from: was.topic, to: is.topic, reason, metaCleared: clearedBy(was.device) }]
  )
  const writable: Array<WritableTopic> = [
    ...pairs.flatMap(({ was, is }): ReadonlyArray<WritableTopic> => {
      const limits = is.limits === undefined ? {} : { limits: is.limits }
      if (is.writable && !was.writable) return [{ topic: is.topic, change: "now writable", ...limits }]
      if (!is.writable && was.writable) return [{ topic: is.topic, change: "no longer writable" }]
      if (is.writable && !sameJson(was.limits, is.limits))
        return [{ topic: is.topic, change: "limits changed", ...limits }]
      return []
    }),
    ...after.points
      .filter((point) => point.writable && !pairedAfter.has(key(point)))
      .map((point): WritableTopic => ({
        topic: point.topic,
        change: "now writable",
        ...(point.limits === undefined ? {} : { limits: point.limits })
      }))
  ]
  // Every $meta names its gateway: a new id rewrites each one that stays on its topic.
  const meta = pairs.flatMap(({ was, is }) => {
    const fields = [
      ...metaFields.filter((field) => !sameJson(was[field], is[field])),
      ...(before.id === after.id || was.topic !== is.topic ? [] : ["gateway"])
    ]
    return fields.length === 0 ? [] : [{ topic: is.topic, fields }]
  })
  const values = pairs.flatMap(({ was, is }) => {
    const fields = valueFields.filter((field) => !sameJson(was[field], is[field]))
    return fields.length === 0 ? [] : [{ topic: is.topic, fields }]
  })
  const brokerChanged = !sameJson(settingOf(before.settings, "mqtt", "url"), settingOf(after.settings, "mqtt", "url"))
  const settings = settingsChanges(before.settings, after.settings)
  const oldHealth = healthTopic(before.site, before.building, before.id)
  const newHealth = healthTopic(after.site, after.building, after.id)
  const health = oldHealth === newHealth ? undefined : { from: oldHealth, to: newHealth }
  // On another broker, the gateway publishes nothing to the old one again: all it retained there stays.
  const stale = brokerChanged
    ? [...before.points.map((point) => `${point.topic}/$meta`), oldHealth]
    : [
        ...removed.filter((each) => !each.metaCleared).map((each) => `${each.topic}/$meta`),
        ...moved.filter((each) => !each.metaCleared).map((each) => `${each.from}/$meta`),
        ...(health === undefined ? [] : [health.from])
      ]
  return {
    changed:
      added.length + removed.length + moved.length + writable.length + meta.length + values.length + settings.length >
        0 || health !== undefined,
    added,
    removed,
    moved,
    writable,
    meta,
    values,
    settings,
    ...(health === undefined ? {} : { health }),
    brokerChanged,
    stale
  }
}

const moveText: Readonly<Record<MoveReason, string>> = {
  point: "point renamed (same source)",
  device: "device renamed (same points)",
  site: "site or building changed"
}

const limitsText = (limits: { readonly min: number; readonly max: number } | undefined) =>
  limits === undefined ? "" : ` (${limits.min} to ${limits.max})`

/** The command that clears a retained topic on the config's broker. */
export const clearCommand = (command: string, topic: string, config: string | undefined) =>
  `${command} publish ${shellArgument(topic)} --retain${config === undefined ? "" : ` --config ${shellArgument(config)}`}`

/** How the CLI was run and which configs it compared: what the clear commands name. */
export interface ClearContext {
  readonly command: string
  /** The edited config, unless it is ./ot-gateway.json. */
  readonly config?: string | undefined
  /** The config compared against, when it was a file. */
  readonly against?: string | undefined
}

/**
 * The commands that clear what stays: on the edited config's broker, or when the broker changes, on the old one,
 * which only the old config names. Against a running gateway there is no old file to name: none, and the caller
 * says how instead.
 */
export const clearCommands = (diff: ConfigDiff, context: ClearContext): ReadonlyArray<string> => {
  const config = diff.brokerChanged ? context.against : context.config
  if (diff.brokerChanged && config === undefined) return []
  return diff.stale.map((topic) => clearCommand(context.command, topic, config))
}

/** Up to this many topic lines, the diff lists each; beyond, a terminal sums them up per device. */
const TOPICS_LISTED = 20

/** The device's part of a topic: `site/building/device` of `site/building/device/point`. */
const deviceOf = (topic: string) => topic.slice(0, Math.max(0, topic.lastIndexOf("/")))

/**
 * Lines for one kind of change: one per topic, or with `grouped` one per device, `+ site/building/ahu-1/…  15 new
 * topics`, a device's single topic still on its own, the first devices and how many more.
 */
const changeLines = <A>(
  items: ReadonlyArray<A>,
  grouped: boolean,
  groupOf: (item: A) => string,
  one: (item: A) => string,
  many: (group: string, items: ReadonlyArray<A>) => string
) => {
  if (!grouped) return items.map(one)
  const groups = new Map<string, Array<A>>()
  for (const item of items) {
    const group = groups.get(groupOf(item)) ?? []
    group.push(item)
    groups.set(groupOf(item), group)
  }
  const { shown, more } = firstOf([...groups], LISTED)
  return [
    ...shown.map(([name, group]) => {
      const [only] = group
      return group.length === 1 && only !== undefined ? one(only) : many(name, group)
    }),
    ...(more > 0 ? [`  … and ${plural(more, "more device")}`] : [])
  ]
}

/**
 * The diff for people: one line per topic that changes, marked `+` (new), `-` (silent), `→` (moved), `!` (takes
 * commands now), `~` (its `$meta` changes), then the settings, and last what stays on the broker with the
 * command that clears it. `title` says what was compared with what. `brief` (a terminal) sums many topics up per
 * device, the first few devices; a point that takes commands now is always named. --json lists every topic.
 */
export const formatDiff = (
  diff: ConfigDiff,
  title: string,
  context: ClearContext,
  options: { readonly brief?: boolean } = {}
): string => {
  const lines = [title]
  if (!diff.changed)
    return [...lines, "✓ nothing changes on the broker: the same topics, writable points and settings"].join("\n")
  const topicLines = diff.added.length + diff.removed.length + diff.moved.length + diff.meta.length + diff.values.length
  const grouped = (options.brief ?? false) && topicLines > TOPICS_LISTED
  lines.push(
    ...changeLines(
      diff.added,
      grouped,
      (each) => deviceOf(each.topic),
      (each) => `  + ${each.topic}  new topic`,
      (device, group) => `  + ${device}/…  ${plural(group.length, "new topic")}`
    ),
    ...changeLines(
      diff.removed,
      grouped,
      (each) => deviceOf(each.topic),
      (each) =>
        `  - ${each.topic}  goes silent${each.metaCleared ? "; the gateway clears its $meta" : "; its $meta stays"}`,
      (device, group) =>
        `  - ${device}/…  ${plural(group.length, "topic")} go silent${group.every((each) => each.metaCleared) ? "; the gateway clears their $meta" : "; their $meta stays"}`
    ),
    ...changeLines(
      diff.moved,
      grouped,
      (each) => `${deviceOf(each.from)} → ${deviceOf(each.to)}`,
      (each) => `  → ${each.from} → ${each.to}  ${moveText[each.reason]}`,
      (devices, group) => `  → ${devices}  ${plural(group.length, "topic")} moved`
    )
  )
  for (const each of diff.writable) {
    lines.push(
      `  ! ${each.topic}  ${each.change}${each.change === "no longer writable" ? "" : limitsText(each.limits)}`
    )
  }
  lines.push(
    ...changeLines(
      diff.meta,
      grouped,
      (each) => deviceOf(each.topic),
      (each) => `  ~ ${each.topic}  $meta: ${each.fields.join(", ")}`,
      (device, group) =>
        `  ~ ${device}/…  $meta of ${plural(group.length, "topic")}: ${[...new Set(group.flatMap((each) => each.fields))].join(", ")}`
    ),
    ...changeLines(
      diff.values,
      grouped,
      (each) => deviceOf(each.topic),
      (each) => `  ~ ${each.topic}  values: ${each.fields.join(", ")} (same topic)`,
      (device, group) =>
        `  ~ ${device}/…  values of ${plural(group.length, "topic")}: ${[...new Set(group.flatMap((each) => each.fields))].join(", ")} (same topics)`
    )
  )
  if (diff.health !== undefined) lines.push(`  → ${diff.health.from} → ${diff.health.to}  health`)
  for (const each of diff.settings) lines.push(`  ~ ${each}`)
  const counts = [
    diff.added.length > 0 ? `${count(diff.added.length)} new` : undefined,
    diff.removed.length > 0 ? `${count(diff.removed.length)} silent` : undefined,
    diff.moved.length > 0 ? `${count(diff.moved.length)} moved` : undefined,
    diff.writable.length > 0 ? plural(diff.writable.length, "writable change") : undefined
  ].filter((each) => each !== undefined)
  // Only a topic that moves or goes silent asks something of the consumers; new ones they pick up as they like.
  const follow = diff.moved.length + diff.removed.length > 0 ? "; consumers of moved or silent topics must follow" : ""
  if (counts.length > 0) lines.push(`${counts.join(", ")}${follow}`)
  if (diff.stale.length > 0) {
    const where = diff.brokerChanged ? "the old broker" : "the broker"
    const commands = clearCommands(diff, context)
    const stays = diff.stale.length === 1 ? "stays" : "stay"
    if (commands.length === 0) {
      lines.push(
        `✗ ${plural(diff.stale.length, "retained message")} ${stays} on ${where}; clear each there with ${context.command} publish <topic> --retain --config <the config from before> (--json lists them)`
      )
    } else {
      lines.push(
        `✗ ${plural(diff.stale.length, "retained message")} ${stays} on ${where} after the change; clear each with:`
      )
      const listed = grouped ? NAMED : 10
      for (const each of commands.slice(0, listed)) lines.push(`  ${each}`)
      if (commands.length > listed) {
        lines.push(`  … and ${count(commands.length - listed)} more (--json lists them all)`)
      }
    }
  }
  return lines.join("\n")
}

/** A config as one side: how it would run. */
export const sideOfConfig = (config: GatewayConfig): DiffSide => ({
  site: config.site,
  building: config.building,
  id: config.id,
  points: pointCatalog(config).points,
  settings: configView(config)
})

/** The diff and what it was taken against, as `diff --json` prints it apart from `ok`. */
export interface DiffReport {
  readonly path: string
  /** A config file, or the running gateway's status page. */
  readonly against: { readonly file: string } | { readonly url: string; readonly gateway: string }
  readonly diff: ConfigDiff
}

/**
 * `config` against `against` (a file), or against the gateway running now: the one at `url`, or at the status page
 * `config` names. The running one is what the broker has now, so it is the default.
 */
export const diffReport = Effect.fn("diffReport")(function* (
  path: string,
  options: { readonly against?: string | undefined; readonly url?: string | undefined }
) {
  const config = yield* loadConfig(path)
  const after = sideOfConfig(config)
  if (options.against !== undefined) {
    const before = sideOfConfig(yield* loadConfig(options.against))
    return { path, against: { file: options.against }, diff: diffConfigs(before, after) } satisfies DiffReport
  }
  // The running gateway may serve its page where the edited file no longer says: --url, or --against, then.
  const url =
    options.url ?? (config.status === undefined ? DEFAULT_STATUS_URL : (yield* targetOf(path, config, undefined)).url)
  const ask = <A>(answer: Effect.Effect<A, GatewayUnreachable | GatewayAnswerUnreadable, FileSystem.FileSystem>) =>
    answer.pipe(
      Effect.catchTag("GatewayUnreachable", (error) =>
        Effect.fail(
          new GatewayUnreachable({
            url: error.url,
            message: error.message,
            code: error.code,
            hint: `${error.hint}. If the edit moved the status page, name the running one with --url; without a running gateway, compare with the file from before: --against ${path}.bak`
          })
        )
      )
    )
  const status = yield* ask(fetchGatewayStatus(url, "none"))
  const catalog = yield* ask(askGateway(url, (client) => client.status.points()))
  const settings = yield* ask(askGateway(url, (client) => client.status.config()))
  const before = { site: status.site, building: status.building, id: status.id, points: catalog.points, settings }
  return {
    path,
    against: { url, gateway: gatewayName(status) },
    diff: diffConfigs(before, after)
  } satisfies DiffReport
})

/** What the report compared, as its first line. */
export const diffTitle = (report: DiffReport) =>
  "file" in report.against
    ? `${report.path} against ${report.against.file}`
    : `${report.path} against the running ${report.against.gateway} (${report.against.url})`
