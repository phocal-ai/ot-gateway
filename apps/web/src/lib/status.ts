/**
 * The gateway's status, through the typed client for `OtGatewayApi`: the same
 * schema the gateway encodes with decodes the answer here.
 */
import { type GatewayStatus, type Messages, OtGatewayApi } from "@ot-gateway/api"
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

/**
 * The gateway's clock now: its `now` from the last answer, moved on by the time since that answer arrived. Ages
 * then count up every second between polls, and keep counting while the gateway does not answer, while a browser
 * whose own clock is off still shows them right.
 */
export const gatewayNow = (serverNow: number, receivedAt: number, clientNow: number) =>
  serverNow + Math.max(0, clientNow - receivedAt)

/** "12 s ago", "4 min ago", from two Unix ms timestamps. */
export const ago = (then: number | undefined, now: number) => {
  if (then === undefined) return "never"
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86_400)} d ago`
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
