/**
 * The gateway's status, through the typed client for `PlenumApi`: the same
 * schema the gateway encodes with decodes the answer here.
 */
import { type GatewayStatus, PlenumApi } from "@plenum/api"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"

/** The page is served by the gateway, so the API is on the same origin. */
export const fetchStatus: Effect.Effect<GatewayStatus, unknown> = HttpApiClient.make(PlenumApi, {
  baseUrl: typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin
}).pipe(
  Effect.flatMap((client) => client.status.status()),
  Effect.provide(FetchHttpClient.layer)
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

/** "12 s ago", "4 min ago", from two Unix ms timestamps. */
export const ago = (then: number | undefined, now: number) => {
  if (then === undefined) return "never"
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86_400)} d ago`
}
