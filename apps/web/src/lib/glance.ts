/**
 * What a point's value means at a glance: whether it is an alarm and on, whether an old read is stale or only
 * unchanged (a COV point), and which few points a device row on the Status tab shows. Pure, so it is tested without
 * a browser.
 */
import type { DeviceStatus, PointInfo, PointReading } from "@ot-gateway/api"
import { type LivePoint, pointKey } from "./points"
import { clockTime, freshness, lateAfterMs } from "./status"

/** What makes a point an alarm: its config's `alarmWhen`, or its semantics. */
type AlarmFields = Pick<PointInfo, "brick" | "haystack" | "alarmWhen">

/**
 * When a point's alarm is active, or `undefined` for a point that is no alarm. The config's `alarmWhen` wins (a points
 * list's `alarm` column); otherwise what the config says it means: a Brick class with `Alarm` in it (`Alarm`,
 * `Smoke_Detection_Alarm`) or the Haystack tag `alarm`, active when on.
 */
export const alarmWhen = (point: AlarmFields): "on" | "off" | undefined => {
  if (point.alarmWhen !== undefined) return point.alarmWhen
  const bySemantics = (point.brick?.includes("Alarm") ?? false) || (point.haystack ?? []).includes("alarm")
  return bySemantics ? "on" : undefined
}

/** Whether a point is an alarm: its value is then a condition someone should see. */
export const isAlarm = (point: AlarmFields) => alarmWhen(point) !== undefined

/**
 * Whether an alarm point's value says the alarm is active. `on` (the default): `true`, or a number other than 0 (a
 * flag read as a register). `off`: `false` or 0, as a normally-closed contact reads on a fault.
 */
export const alarmOn = (value: number | boolean | undefined, when: "on" | "off" = "on") => {
  if (value === undefined) return false
  const on = value === true || (typeof value === "number" && value !== 0)
  return when === "on" ? on : !on
}

/** An alarm point that is active. */
export const alarmActive = (point: AlarmFields, value: number | boolean | undefined) => {
  const when = alarmWhen(point)
  return when !== undefined && alarmOn(value, when)
}

/**
 * Whether the gateway asks the device to send the point on change of value (BACnet COV) rather than only polling it,
 * as the catalog's `cov` says (apps/gateway/src/PointCatalog.ts).
 */
export const readsOnChange = (point: Pick<PointInfo, "cov">) => point.cov

/**
 * How current a point's last read is, for dimming it and saying when it came:
 * - `none`: nothing read since the gateway started;
 * - `fresh`: read on schedule, or its device is only starting;
 * - `unchanged`: a COV point that has not changed for a while, while its device answers. The device sends a value
 *   only when it changes, so an old read is the current value, not a stale one;
 * - `stale`: the page does not reach the gateway, the point's device fails or is late, or a polled point was not
 *   read for a few intervals although its device answers.
 */
export type PointFreshness =
  | { readonly _tag: "none" }
  | { readonly _tag: "fresh"; readonly ts: number }
  | { readonly _tag: "unchanged"; readonly ts: number }
  | { readonly _tag: "stale"; readonly ts: number }

export const pointFreshness = (
  point: Pick<PointInfo, "cov">,
  live: LivePoint,
  now: number,
  unreachable: boolean
): PointFreshness => {
  const ts = live.value?.ts
  if (ts === undefined) return { _tag: "none" }
  if (unreachable) return { _tag: "stale", ts }
  const device = live.device
  if (device === undefined) return { _tag: "fresh", ts }
  const state = freshness(device, now)
  if (state._tag === "failing" || state._tag === "late") return { _tag: "stale", ts }
  if (state._tag === "starting" || now - ts <= lateAfterMs(device.pollIntervalMs)) return { _tag: "fresh", ts }
  return readsOnChange(point) ? { _tag: "unchanged", ts } : { _tag: "stale", ts }
}

/**
 * When a value was read, for its hover and the panels: "read 14:05:09", or "last read 14:05:09" for a stale one (the
 * last value known while its device fails), "nothing read yet" without a read.
 */
export const readLabel = (ts: number | undefined, now: number, stale: boolean) =>
  ts === undefined ? "nothing read yet" : `${stale ? "last read" : "read"} ${clockTime(ts, now)}`

/** Points a device row on the Status tab shows before "+n more". */
export const GLANCE_POINTS = 4

/** A catalog's points by device, each device's in config order. */
export const pointsByDevice = (points: ReadonlyArray<PointInfo>): ReadonlyMap<string, ReadonlyArray<PointInfo>> => {
  const byDevice = new Map<string, Array<PointInfo>>()
  for (const point of points) {
    const list = byDevice.get(point.device)
    if (list === undefined) byDevice.set(point.device, [point])
    else list.push(point)
  }
  return byDevice
}

/**
 * The points whose values the Status tab asks for: the first `max` of each listed device, and every alarm point of
 * the gateway, so an alarm counts whether or not its device's row is listed or its point is among the first few.
 */
export const glanceKeys = (
  points: ReadonlyArray<PointInfo>,
  devices: ReadonlyArray<string>,
  max: number = GLANCE_POINTS
): ReadonlyArray<string> => {
  const byDevice = pointsByDevice(points)
  const keys = new Set<string>()
  for (const device of devices)
    for (const point of (byDevice.get(device) ?? []).slice(0, max)) keys.add(pointKey(point))
  for (const point of points) if (isAlarm(point)) keys.add(pointKey(point))
  return [...keys]
}

/** The alarm points that are on, in config order. */
export const activeAlarms = (
  points: ReadonlyArray<PointInfo>,
  readings: ReadonlyMap<string, PointReading>
): ReadonlyArray<PointInfo> => points.filter((point) => alarmActive(point, readings.get(pointKey(point))?.value))

/**
 * What a device row shows: its alarms that are on first, then its points in config order, `max` in all, and how many
 * are left for the Points tab.
 */
export const glancePoints = (
  points: ReadonlyArray<PointInfo>,
  readings: ReadonlyMap<string, PointReading>,
  max: number = GLANCE_POINTS
): { readonly shown: ReadonlyArray<PointInfo>; readonly more: number } => {
  const alarms = activeAlarms(points, readings)
  const rest = points.filter((point) => !alarms.includes(point))
  const shown = [...alarms, ...rest.slice(0, Math.max(0, max - alarms.length))]
  return { shown, more: points.length - shown.length }
}

/**
 * An active alarm as the banner lists it. `lastKnown`, when its value is stale (`pointFreshness`): why it is not
 * known to be active now, "device not answering since 15:58". Its device may have cleared it meanwhile, or not.
 * `alarmNote` words it for the banner.
 */
export interface ShownAlarm {
  readonly point: PointInfo
  readonly lastKnown?: string
}

/** A time to the minute, "15:58" (with the date on another day), as the banner says it. */
const minuteTime = (at: number, now: number) => clockTime(at, now).slice(0, -3)

/** Why a stale alarm value is not known to be current, from its device's state (`pointFreshness`'s cases). */
const staleBecause = (device: DeviceStatus | undefined, ts: number, now: number, unreachable: boolean) => {
  if (unreachable) return `gateway not answering, last read ${minuteTime(ts, now)}`
  if (device?.status === "failing")
    return `device not answering since ${minuteTime(device.failingSince ?? device.lastSuccess ?? ts, now)}`
  if (device !== undefined && freshness(device, now)._tag === "late")
    return `device late, last read ${minuteTime(device.lastSuccess ?? ts, now)}`
  return `not read since ${minuteTime(ts, now)}`
}

/**
 * The active alarms for the banner, in config order: the ones whose last read is current first, then the ones whose
 * value is stale (its device fails, is late, or the page does not reach the gateway), which are only last known to
 * be active.
 */
export const shownAlarms = (
  points: ReadonlyArray<PointInfo>,
  readings: ReadonlyMap<string, PointReading>,
  devices: ReadonlyMap<string, DeviceStatus>,
  now: number,
  unreachable: boolean
): ReadonlyArray<ShownAlarm> => {
  const shown = activeAlarms(points, readings).map((point): ShownAlarm => {
    const value = readings.get(pointKey(point))
    const device = devices.get(point.device)
    const read = pointFreshness(point, { value, device }, now, unreachable)
    return read._tag === "stale" ? { point, lastKnown: staleBecause(device, read.ts, now, unreachable) } : { point }
  })
  return [
    ...shown.filter((alarm) => alarm.lastKnown === undefined),
    ...shown.filter((alarm) => alarm.lastKnown !== undefined)
  ]
}

const alarmsText = (count: number) => `${count} ${count === 1 ? "alarm" : "alarms"}`

/**
 * The banner's headline: "1 alarm active", "2 alarms last known active" when none is known to be on now, "1 alarm
 * active, 1 last known active" for both.
 */
export const alarmCount = (active: number, lastKnown = 0) =>
  active === 0
    ? `${alarmsText(lastKnown)} last known active`
    : lastKnown === 0
      ? `${alarmsText(active)} active`
      : `${alarmsText(active)} active, ${lastKnown} last known active`

/**
 * What the banner says after a last known alarm's name: "last known active, device not answering since 15:58", or
 * only why when the headline already says that none is known to be active now (`active` is 0).
 */
export const alarmNote = (alarm: ShownAlarm, active: number) =>
  alarm.lastKnown === undefined ? undefined : active === 0 ? alarm.lastKnown : `last known active, ${alarm.lastKnown}`
