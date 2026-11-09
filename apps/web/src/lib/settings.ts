/**
 * The Settings tab's words for the running config (`/api/config`): a title per section, a label per setting and
 * values as people read them ("5 s", "yes", "10,000 messages"). A setting this file does not know yet still shows,
 * under its key in words, so a new config field is never hidden.
 */
import type { ConfigEntry } from "@ot-gateway/api"

type Json = ConfigEntry["value"]

const sectionTitles: Readonly<Record<string, string>> = {
  gateway: "Gateway",
  mqtt: "Broker",
  buffer: "Buffer",
  history: "History",
  status: "Status page",
  bacnet: "BACnet/IP"
}

export const sectionTitle = (key: string) => sectionTitles[key] ?? words(key)

const labels: Readonly<Record<string, string>> = {
  site: "Site",
  building: "Building",
  id: "Gateway id",
  healthIntervalMs: "Health message every",
  url: "Broker",
  clientId: "Client id",
  username: "User name",
  passwordEnv: "Password from variable",
  version: "MQTT version",
  path: "File",
  maxRows: "Holds up to",
  retentionDays: "Keeps",
  bindAddress: "Listens on",
  port: "Port",
  webRoot: "Web files",
  broadcastAddress: "Broadcasts to",
  bbmdAddress: "BBMD",
  requestTimeoutMs: "Reply timeout",
  retries: "Retries",
  covLifetimeSeconds: "Subscriptions renewed every",
  host: "Address",
  unitId: "Unit id",
  pollIntervalMs: "Read every",
  cycleTimeoutMs: "Give up a read after",
  publish: "Publishes",
  requestGapMs: "Pause between requests",
  maxRegistersPerRead: "Registers per request",
  maxBitsPerRead: "Bits per request",
  deviceInstance: "Device instance",
  address: "Address",
  cov: "Change notifications (COV)"
}

/** "healthIntervalMs" → "Health interval ms": a key no label exists for, readable. */
const words = (key: string) => {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export const settingLabel = (key: string) => labels[key] ?? words(key)

/** 500 ms, 5 s, 2 min, 1.5 h. */
export const duration = (ms: number) => {
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${Number(seconds.toFixed(1))} s`
  if (seconds < 3600) return `${Number((seconds / 60).toFixed(1))} min`
  return `${Number((seconds / 3600).toFixed(1))} h`
}

/** Numbers that are names, not amounts: no thousands separator. */
const identifiers = new Set(["port", "unitId", "deviceInstance"])

const isObject = (value: Json): value is { readonly [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const formatSetting = (key: string, value: Json): string => {
  if (value === null) return "–"
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (typeof value === "number") {
    if (key.endsWith("Ms")) return duration(value)
    if (key.endsWith("Seconds")) return duration(value * 1000)
    if (key === "retentionDays") return `${value} ${value === 1 ? "day" : "days"} per minute`
    if (key === "maxRows") return `${value.toLocaleString("en-US")} messages`
    if (identifiers.has(key)) return String(value)
    return value.toLocaleString("en-US")
  }
  if (typeof value === "string")
    return key === "version" && value === "auto" ? "5, or 3.1.1 if the broker needs it" : value
  if (Array.isArray(value)) return value.map((item) => formatSetting(key, item)).join(", ")
  if (isObject(value)) {
    return Object.entries(value)
      .map(([inner, item]) => `${words(inner).toLowerCase()} ${formatSetting(inner, item)}`)
      .join(" · ")
  }
  return String(value)
}

/** Where a device is reached, from its settings: "10.0.1.1:502 · unit 1", "device 1234 at 10.0.0.9:47808". */
export const deviceAddress = (protocol: string, entries: ReadonlyArray<ConfigEntry>) => {
  const get = (key: string) => {
    const value = entries.find((entry) => entry.key === key)?.value
    return typeof value === "string" || typeof value === "number" ? String(value) : undefined
  }
  if (protocol === "modbus-tcp") return `${get("host") ?? "?"}:${get("port") ?? "502"} · unit ${get("unitId") ?? "?"}`
  if (protocol === "bacnet-ip") {
    const address = get("address")
    return `device ${get("deviceInstance") ?? "?"}${address === undefined ? ", found by broadcast" : ` at ${address}`}`
  }
  if (protocol === "simulator") return "on this gateway"
  return ""
}

/** A device's settings shown in their own columns, and so left out of its other settings. */
export const deviceColumns = new Set(["host", "port", "unitId", "deviceInstance", "address", "pollIntervalMs"])
