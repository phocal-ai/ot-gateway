/**
 * The gateway's status, through the typed client for `OtGatewayApi`: the same
 * schema the gateway encodes with decodes the answer here.
 */
import { type DeviceStatus, type GatewayStatus, type Messages, OtGatewayApi } from "@ot-gateway/api"
import { Effect, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"

/** The gateway did not answer, not in time, or not with a status: for the page, all the same. */
export class StatusUnavailable extends Schema.TaggedError<StatusUnavailable>()("StatusUnavailable", {
  message: Schema.String
}) {}

/** The typed client for the gateway that served this page: the API is on the same origin. */
const gateway = HttpApiClient.make(OtGatewayApi, {
  baseUrl: typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin
})

/**
 * An answer within three seconds, or `StatusUnavailable`: every way of not getting it (unreachable, a timeout, an
 * answer that does not decode) means one thing here.
 */
const withinThreeSeconds = <A, E extends { readonly message: string }, R>(request: Effect.Effect<A, E, R>) =>
  request.pipe(
    Effect.mapError((error) => new StatusUnavailable({ message: error.message })),
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () => Effect.fail(new StatusUnavailable({ message: "no answer within 3 s" }))
    })
  )

/** The status, for the whole page. */
export const fetchStatus: Effect.Effect<GatewayStatus, StatusUnavailable> = gateway.pipe(
  Effect.flatMap((client) => client.status.status()),
  Effect.provide(FetchHttpClient.layer),
  withinThreeSeconds
)

/** The latest message per topic, for the messages view; asked for only while it is open. */
export const fetchMessages: Effect.Effect<Messages, StatusUnavailable> = gateway.pipe(
  Effect.flatMap((client) => client.status.messages()),
  Effect.provide(FetchHttpClient.layer),
  withinThreeSeconds
)

/** QUDT unit names (`unit:DEG_C`) as people write them. */
const unitSymbols: Record<string, string> = {
  DEG_C: "°C",
  DEG_F: "°F",
  PERCENT: "%",
  KiloW: "kW",
  W: "W",
  "KiloW-HR": "kWh",
  V: "V",
  A: "A",
  PA: "Pa",
  BAR: "bar",
  "M3-PER-HR": "m³/h",
  "L-PER-SEC": "l/s",
  PPM: "ppm"
}

export const unitLabel = (unit: string | undefined) => {
  if (unit === undefined) return ""
  const name = unit.replace(/^unit:/, "")
  return unitSymbols[name] ?? name
}

export const formatValue = (value: number | boolean | undefined) => {
  if (value === undefined) return "–"
  if (typeof value === "boolean") return value ? "on" : "off"
  return Math.abs(value) >= 1000 || Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2)
}

/** A device counts as late once this many poll intervals pass without a read, and never sooner than `LATE_MIN_MS`. */
const LATE_INTERVALS = 3
const LATE_MIN_MS = 15_000

/**
 * How fresh a device is, as a state rather than a counting number: `live` while it is read on schedule, `late`
 * when no read came for a few intervals although the gateway has not marked it failing (a stalled cycle), and
 * `failing` or `starting` as the gateway says.
 */
export type Freshness =
  | { readonly _tag: "live" }
  | { readonly _tag: "starting" }
  | { readonly _tag: "late"; readonly lastSuccess: number | undefined }
  | { readonly _tag: "failing"; readonly reason: string; readonly lastSuccess: number | undefined }

export const freshness = (device: DeviceStatus, now: number): Freshness => {
  if (device.status === "failing")
    return { _tag: "failing", reason: device.reason ?? "failing", lastSuccess: device.lastSuccess }
  if (device.status === "starting") return { _tag: "starting" }
  const lateAfter = Math.max(LATE_INTERVALS * device.pollIntervalMs, LATE_MIN_MS)
  return device.lastSuccess !== undefined && now - device.lastSuccess <= lateAfter
    ? { _tag: "live" }
    : { _tag: "late", lastSuccess: device.lastSuccess }
}

/** "every 5 s", "every 2 min": how often a device is read. */
export const every = (intervalMs: number) => {
  const seconds = intervalMs / 1000
  if (seconds < 60) return `every ${Number(seconds.toFixed(1))} s`
  if (seconds < 3600) return `every ${Number((seconds / 60).toFixed(1))} min`
  return `every ${Number((seconds / 3600).toFixed(1))} h`
}

/**
 * Since when, in steps that don't count every second: "under a minute", "4 min", "3 h", "2 d". For a device that
 * stopped answering, where the seconds don't matter and a ticking number would only distract.
 */
export const since = (then: number | undefined, now: number) => {
  if (then === undefined) return "never"
  const seconds = Math.max(0, (now - then) / 1000)
  if (seconds < 60) return "under a minute"
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`
  return `${Math.floor(seconds / 86_400)} d`
}

/** A moment as a clock time (14:02:31), with the date when it is not today. Unlike "12 s ago", it does not change while you look. */
export const clockTime = (at: number, now: number) => {
  const moment = new Date(at)
  const time = moment.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  return moment.toDateString() === new Date(now).toDateString()
    ? time
    : `${moment.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`
}

/** Bytes as people read them: 312 MB, 1.4 GB. */
export const formatBytes = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** What a topic under `site/building/` carries, by its shape (README, "Topics"). */
export type TopicKind = "value" | "metadata" | "health" | "command result" | "other"

export const topicKind = (topic: string): TopicKind => {
  const parts = topic.split("/")
  if (parts[2] === "$gateway" && parts[4] === "health") return "health"
  if (parts.length === 4) return "value"
  if (parts.length === 5 && parts[4] === "$meta") return "metadata"
  if (parts.length === 6 && parts[4] === "$set" && parts[5] === "result") return "command result"
  return "other"
}
