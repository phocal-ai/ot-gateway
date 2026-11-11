/**
 * What a point's value means at a glance: whether it is an alarm and on, whether an old read is stale or only
 * unchanged (a COV point), and which few points a device row on the Status tab shows. Pure, so it is tested without
 * a browser.
 */
import type { PointInfo, PointReading } from "@ot-gateway/api"
import { type LivePoint, pointKey } from "./points"
import { freshness, lateAfterMs } from "./status"

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

/** "1 alarm active", "3 alarms active". */
export const alarmCount = (count: number) => `${count} ${count === 1 ? "alarm" : "alarms"} active`
