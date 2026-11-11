/**
 * What a point's value means at a glance: whether it is an alarm and on, whether an old read is stale or only
 * unchanged (a COV point), and which few points a device row on the Status tab shows. Pure, so it is tested without
 * a browser.
 */
import type { PointInfo, PointReading } from "@ot-gateway/api"
import { type LivePoint, pointKey } from "./points"
import { freshness, lateAfterMs } from "./status"

/**
 * Whether a point is an alarm by what its config says it means: a Brick class with `Alarm` in it (`Alarm`,
 * `Smoke_Detection_Alarm`) or the Haystack tag `alarm`. Its value is then a condition someone should see.
 */
export const isAlarm = (point: Pick<PointInfo, "brick" | "haystack">) =>
  (point.brick?.includes("Alarm") ?? false) || (point.haystack ?? []).includes("alarm")

/** Whether an alarm point's value says the alarm is on: `true`, or a number other than 0 (a flag read as a register). */
export const alarmOn = (value: number | boolean | undefined) =>
  value === true || (typeof value === "number" && value !== 0)

/** An alarm point that is on. */
export const alarmActive = (point: Pick<PointInfo, "brick" | "haystack">, value: number | boolean | undefined) =>
  isAlarm(point) && alarmOn(value)

/**
 * Whether the gateway asks the device to send the point on change of value (BACnet COV) rather than only polling it:
 * the catalog's `read` says so in words (apps/gateway/src/PointCatalog.ts).
 */
export const readsOnChange = (point: Pick<PointInfo, "read">) => point.read.startsWith("on change of value")

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
  point: Pick<PointInfo, "read">,
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
