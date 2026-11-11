/**
 * What a saved config changes against the running one, in short, for the `config-applied` event, the log line and
 * the page: which settings of the gateway and broker sections, which other sections, which devices were added,
 * removed or changed, and every point that takes commands now or no longer does (with its limits). And what an in-process apply cannot change: the status page's own address (its server keeps
 * running) and the history (its file stays open), which need a restart.
 */
import type { ConfigChange } from "@ot-gateway/api"
import { GatewayConfig } from "@ot-gateway/core"
import { Schema } from "effect"

const encodeConfig = Schema.encodeSync(GatewayConfig)

/** Equal as the file would have them: both sides went through the same schema, so key order agrees. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const gatewayKeys = ["site", "building", "id", "healthIntervalMs"] as const
/** Each section with its name in words, and whether the running process keeps it (saved now, applied by a restart). */
const sections = [
  { key: "mqtt", name: "broker", kept: false },
  { key: "buffer", name: "buffer", kept: false },
  { key: "history", name: "history", kept: true },
  { key: "status", name: "status page", kept: true },
  { key: "bacnet", name: "BACnet/IP", kept: false }
] as const

/** The keys whose values differ between two objects (the broker's `url`, `clientId`, ...). */
const changedKeys = (was: object, is: object) => {
  const before = new Map(Object.entries(was))
  const after = new Map(Object.entries(is))
  return [...new Set([...before.keys(), ...after.keys()])].filter((key) => !same(before.get(key), after.get(key)))
}

/** Every writable point as `device/point`, with its limits in words (` (10 to 30)`, or nothing for a binary one). */
const writablePoints = (config: GatewayConfig) =>
  new Map(
    config.devices.flatMap((device) =>
      device.points.flatMap((point) =>
        point.writable
          ? [
              [
                `${device.id}/${point.id}`,
                point.limits === undefined ? "" : ` (${point.limits.min} to ${point.limits.max})`
              ] as const
            ]
          : []
      )
    )
  )

export const describeConfigChange = (before: GatewayConfig, after: GatewayConfig): ConfigChange => {
  const changes: Array<string> = []
  const restartNeeded: Array<string> = []
  const gateway = gatewayKeys.filter((key) => before[key] !== after[key])
  if (gateway.length > 0) changes.push(`gateway: ${gateway.join(", ")}`)
  const encodedBefore = encodeConfig(before)
  const encodedAfter = encodeConfig(after)
  for (const { key, name, kept } of sections) {
    const was = encodedBefore[key]
    const is = encodedAfter[key]
    if (same(was, is)) continue
    if (was === undefined) changes.push(`${name} added`)
    else if (is === undefined) changes.push(`${name} removed`)
    else if (key === "mqtt") changes.push(`${name}: ${changedKeys(was, is).join(", ")}`)
    else changes.push(`${name} changed`)
    if (kept) restartNeeded.push(name)
  }
  const beforeDevices = new Map(encodedBefore.devices.map((device) => [device.id, device]))
  const afterDevices = new Map(encodedAfter.devices.map((device) => [device.id, device]))
  for (const id of afterDevices.keys()) if (!beforeDevices.has(id)) changes.push(`device ${id} added`)
  for (const id of beforeDevices.keys()) if (!afterDevices.has(id)) changes.push(`device ${id} removed`)
  for (const [id, device] of afterDevices) {
    const previous = beforeDevices.get(id)
    if (previous !== undefined && !same(previous, device)) changes.push(`device ${id} changed`)
  }
  // A write is a decision: every point that now takes commands, or no longer does, is named with its limits.
  const writableBefore = writablePoints(before)
  const writableAfter = writablePoints(after)
  for (const [key, limits] of writableAfter) {
    const was = writableBefore.get(key)
    if (was === undefined) changes.push(`writes allowed: ${key}${limits}`)
    else if (was !== limits) changes.push(`write limits changed: ${key}${limits}`)
  }
  for (const key of writableBefore.keys()) if (!writableAfter.has(key)) changes.push(`writes turned off: ${key}`)
  const summary = changes.length === 0 ? "nothing to apply" : changes.join("; ")
  return {
    summary: restartNeeded.length === 0 ? summary : `${summary} (${restartNeeded.join(" and ")}: after a restart)`,
    changes,
    restartNeeded
  }
}
