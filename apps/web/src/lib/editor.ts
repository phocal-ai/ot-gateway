/**
 * Editing the gateway and broker settings on the Settings tab, as pure functions over the config file's text: the
 * fields the page edits, their values read from the file, the file with new values written in (everything else, the
 * devices among it, as it was), and the gateway's check issues put next to the field they are about.
 */
import type { ConfigChange, ConfigIssue } from "@ot-gateway/api"

/** A clock time to the minute, 13:27, for a saved message. */
export const hourMinute = (at: number) =>
  new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })

/**
 * What a save that went through says: what changed (the gateway's summary names what waits for a restart), and at
 * what time when `at` (13:27) is given.
 */
export const savedMessage = (applied: ConfigChange, at?: string) =>
  applied.changes.length === 0
    ? "Saved. Nothing changed, so nothing had to be applied."
    : `Saved and applied${at === undefined ? "" : ` at ${at}`}: ${applied.summary}.`

/** A setting the page edits: where it is in the file, and how it is typed in. */
export interface EditField {
  readonly key: string
  readonly path: readonly [string] | readonly [string, string]
  readonly label: string
  readonly kind: "text" | "number" | "choice"
  /** Left empty, the key is removed from the file and the gateway's default applies. */
  readonly optional: boolean
  readonly placeholder?: string
  readonly hint?: string
  readonly choices?: ReadonlyArray<{ readonly value: string; readonly label: string }>
}

export type EditCard = "gateway" | "mqtt" | "bacnet"

export const isEditCard = (key: string | null | undefined): key is EditCard =>
  key === "gateway" || key === "mqtt" || key === "bacnet"

export const editFields: Readonly<Record<EditCard, ReadonlyArray<EditField>>> = {
  gateway: [
    {
      key: "site",
      path: ["site"],
      label: "Site",
      kind: "text",
      optional: false,
      hint: "Lower-case letters, digits and dashes; the first part of every topic."
    },
    { key: "building", path: ["building"], label: "Building", kind: "text", optional: false },
    {
      key: "id",
      path: ["id"],
      label: "Gateway id",
      kind: "text",
      optional: true,
      placeholder: "main",
      hint: "Names this gateway in its health topic, when a building has more than one."
    },
    {
      key: "healthIntervalMs",
      path: ["healthIntervalMs"],
      label: "Health message every (ms)",
      kind: "number",
      optional: true,
      placeholder: "60000"
    }
  ],
  mqtt: [
    {
      key: "url",
      path: ["mqtt", "url"],
      label: "Broker",
      kind: "text",
      optional: false,
      placeholder: "mqtt://192.168.1.10:1883",
      hint: "mqtts:// for TLS. No user or password here."
    },
    { key: "username", path: ["mqtt", "username"], label: "User name", kind: "text", optional: true },
    { key: "clientId", path: ["mqtt", "clientId"], label: "Client id", kind: "text", optional: true },
    {
      key: "version",
      path: ["mqtt", "version"],
      label: "MQTT version",
      kind: "choice",
      optional: true,
      choices: [
        { value: "auto", label: "5, or 3.1.1 if the broker needs it" },
        { value: "5", label: "5" },
        { value: "3.1.1", label: "3.1.1" }
      ]
    }
  ],
  // Every BACnet/IP setting has a default: an empty field leaves it to the gateway.
  bacnet: [
    {
      key: "port",
      path: ["bacnet", "port"],
      label: "Port",
      kind: "number",
      optional: true,
      placeholder: "47808",
      hint: "This gateway's UDP port. Devices answer a search on 47808; on another port, find a device by its address."
    },
    {
      key: "broadcastAddress",
      path: ["bacnet", "broadcastAddress"],
      label: "Broadcast address",
      kind: "text",
      optional: true,
      placeholder: "255.255.255.255",
      hint: "Where a search for devices goes: this subnet's broadcast address, e.g. 192.168.1.255."
    },
    {
      key: "bbmdAddress",
      path: ["bacnet", "bbmdAddress"],
      label: "BBMD",
      kind: "text",
      optional: true,
      placeholder: "none",
      hint: "The BBMD on this subnet that forwards devices on other subnets; leave empty without one."
    },
    {
      key: "bindAddress",
      path: ["bacnet", "bindAddress"],
      label: "Listens on",
      kind: "text",
      optional: true,
      placeholder: "0.0.0.0",
      hint: "Leave at 0.0.0.0 (every network): bound to one address, the gateway hears no broadcast answers."
    },
    {
      key: "requestTimeoutMs",
      path: ["bacnet", "requestTimeoutMs"],
      label: "Reply timeout (ms)",
      kind: "number",
      optional: true,
      placeholder: "3000",
      hint: "How long to wait for a device's answer before asking again."
    },
    {
      key: "retries",
      path: ["bacnet", "retries"],
      label: "Retries",
      kind: "number",
      optional: true,
      placeholder: "2",
      hint: "How often to ask again when a device does not answer."
    },
    {
      key: "covLifetimeSeconds",
      path: ["bacnet", "covLifetimeSeconds"],
      label: "Change subscriptions last (s)",
      kind: "number",
      optional: true,
      placeholder: "300",
      hint: "How long a device sends changes before the gateway renews; it renews at half of this."
    }
  ]
}

/** What the form holds: one string per field key, "" for a key the file leaves out. */
export type EditValues = Readonly<Record<string, string>>

type JsonObject = { [key: string]: unknown }

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The file as an object, or undefined when it is not a JSON object (a hand edit broke it). */
export const parseConfigText = (text: string): JsonObject | undefined => {
  try {
    const parsed: unknown = JSON.parse(text)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const valueAt = (config: JsonObject, path: EditField["path"]): unknown => {
  const [first, second] = path
  if (second === undefined) return config[first]
  const section = config[first]
  return isObject(section) ? section[second] : undefined
}

/** The fields of `card` as the file has them, or undefined when the file is not a JSON object. */
export const valuesFrom = (text: string, card: EditCard): EditValues | undefined => {
  const config = parseConfigText(text)
  if (config === undefined) return undefined
  return Object.fromEntries(
    editFields[card].map((field) => {
      const value = valueAt(config, field.path)
      return [field.key, typeof value === "string" || typeof value === "number" ? String(value) : ""]
    })
  )
}

/** A typed-in value as the file keeps it: a number field's digits as a number, anything else as written. */
const fileValue = (field: EditField, typed: string): unknown => {
  const trimmed = typed.trim()
  if (field.kind !== "number") return trimmed
  const number = Number(trimmed)
  // Not a number: written as typed, so the gateway's check names the field.
  return trimmed !== "" && Number.isFinite(number) ? number : trimmed
}

/**
 * The file with `values` written into `card`'s fields: an empty optional field removed (and a section with nothing
 * left in it), the order of the keys and
 * every other setting as they were. Formatted as `ot-gateway init` writes it (two spaces, a final newline).
 */
export const withValues = (text: string, card: EditCard, values: EditValues): string | undefined => {
  const config = parseConfigText(text)
  if (config === undefined) return undefined
  for (const field of editFields[card]) {
    const typed = values[field.key] ?? ""
    const [first, second] = field.path
    const remove = typed.trim() === "" && field.optional
    if (second === undefined) {
      if (remove) delete config[first]
      else config[first] = fileValue(field, typed)
      continue
    }
    const existing = config[first]
    const section: JsonObject = isObject(existing) ? existing : {}
    if (remove) delete section[second]
    else section[second] = fileValue(field, typed)
    // A section left empty (every BACnet/IP setting at its default) goes, as the file had it before.
    if (Object.keys(section).length === 0) delete config[first]
    else config[first] = section
  }
  return `${JSON.stringify(config, null, 2)}\n`
}

/** Whether the form differs from the file. */
export const isChanged = (text: string, card: EditCard, values: EditValues) => {
  const before = valuesFrom(text, card)
  return (
    before !== undefined &&
    editFields[card].some((field) => (before[field.key] ?? "").trim() !== (values[field.key] ?? "").trim())
  )
}

/**
 * The check's issues by the field of `card` they are about (`["mqtt", "url"]` → `url`), and the rest: issues
 * elsewhere in the file (a device, a hand edit) that the form cannot fix but the save would still be refused for.
 */
export const issuesByField = (issues: ReadonlyArray<ConfigIssue>, card: EditCard) => {
  const byField: Record<string, Array<string>> = {}
  const elsewhere: Array<string> = []
  for (const issue of issues) {
    const field = editFields[card].find((candidate) =>
      candidate.path.every((segment, index) => issue.path[index] === segment)
    )
    if (field === undefined) {
      const where = issue.path.join(".")
      elsewhere.push(where === "" ? issue.message : `${where}: ${issue.message}`)
    } else (byField[field.key] ??= []).push(issue.message)
  }
  return { byField, elsewhere }
}
