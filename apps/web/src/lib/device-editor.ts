/**
 * Editing a device and its points on the Settings tab, as pure functions over the config file's text: a device as
 * the form holds it (every field a string, as typed), the device as the file keeps it, the file with a device added,
 * replaced or removed (everything else as it was), and the gateway's check issues put next to the field they are
 * about. The gateway checks every candidate with its one schema; nothing here decides what is valid.
 *
 * A device or point the form did not change is written back exactly as the file had it, keys the form does not
 * know (a request gap, a writable point's limits, semantics) included.
 */
import type { ConfigIssue } from "@ot-gateway/api"
import { parseConfigText } from "./editor"
import { unitSymbols } from "./status"

type JsonObject = { [key: string]: unknown }

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The protocols the form edits; a simulated device is shown but edited in the file. */
export type EditableProtocol = "modbus-tcp" | "bacnet-ip"

export const isEditableProtocol = (protocol: unknown): protocol is EditableProtocol =>
  protocol === "modbus-tcp" || protocol === "bacnet-ip"

export type PublishMode = "" | "sample" | "change" | "aggregate"

/** One point as the form holds it. `key` stays the same while it is edited, for React and for test results. */
export interface PointDraft {
  readonly key: string
  readonly name: string
  readonly id: string
  /** Whether the id follows the name (a new point whose id nobody typed). */
  readonly autoId: boolean
  readonly unit: string
  // Modbus
  readonly table: string
  readonly register: string
  readonly dataType: string
  readonly byteOrder: string
  readonly scale: string
  readonly offset: string
  // BACnet
  readonly objectType: string
  readonly instance: string
  // Both
  readonly publish: PublishMode
  /** Seconds between messages (sample, aggregate). */
  readonly publishSeconds: string
  readonly deadband: string
  /** The point as the file has it; undefined for a new one. */
  readonly original: JsonObject | undefined
}

/** One device as the form holds it. */
export interface DeviceDraft {
  readonly protocol: EditableProtocol
  readonly id: string
  readonly autoId: boolean
  readonly host: string
  readonly port: string
  readonly unitId: string
  readonly deviceInstance: string
  readonly address: string
  readonly intervalSeconds: string
  readonly points: ReadonlyArray<PointDraft>
  /** The device as the file has it; undefined for a new one. */
  readonly original: JsonObject | undefined
}

/** A config slug from a name, as `ot-gateway import` makes one (apps/gateway/src/Slug.ts). */
export const slugify = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "")

let nextKey = 0
const newKey = () => `p${++nextKey}`

const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "")

/** A number in seconds from milliseconds in the file, without trailing noise. */
const seconds = (ms: unknown) => (typeof ms === "number" ? String(ms / 1000) : "")

/** A point of the file as the form holds it. */
export const pointDraft = (point: JsonObject): PointDraft => {
  const scaling = isObject(point["scaling"]) ? point["scaling"] : {}
  const publish = isObject(point["publish"]) ? point["publish"] : undefined
  const mode = text(publish?.["mode"])
  const shortDeadband = point["deadband"]
  return {
    key: newKey(),
    name: text(point["name"]),
    id: text(point["id"]),
    autoId: false,
    unit: unitShown(text(point["unit"])),
    table: text(point["table"]) || "holding",
    register: text(point["address"]),
    dataType: text(point["dataType"]),
    byteOrder: text(point["byteOrder"]) || "ABCD",
    scale: text(scaling["factor"]),
    offset: text(scaling["offset"]),
    objectType: text(point["objectType"]),
    instance: text(point["instance"]),
    publish:
      mode === "sample" || mode === "change" || mode === "aggregate"
        ? mode
        : shortDeadband === undefined
          ? ""
          : "change",
    publishSeconds: seconds(publish?.["intervalMs"]),
    deadband: text(publish?.["deadband"] ?? shortDeadband),
    original: point
  }
}

/** A new, empty point for `protocol`. */
export const newPoint = (protocol: EditableProtocol): PointDraft => ({
  key: newKey(),
  name: "",
  id: "",
  autoId: true,
  unit: "",
  table: "holding",
  register: "",
  dataType: protocol === "modbus-tcp" ? "float32" : "",
  byteOrder: "ABCD",
  scale: "",
  offset: "",
  objectType: protocol === "bacnet-ip" ? "analog-input" : "",
  instance: "",
  publish: "",
  publishSeconds: "",
  deadband: "",
  original: undefined
})

/** A device of the file as the form holds it, or undefined for one the form does not edit (a simulated one). */
export const deviceDraft = (device: unknown): DeviceDraft | undefined => {
  if (!isObject(device)) return undefined
  const protocol = device["protocol"]
  if (!isEditableProtocol(protocol)) return undefined
  const points = Array.isArray(device["points"]) ? device["points"].filter(isObject) : []
  return {
    protocol,
    id: text(device["id"]),
    autoId: false,
    host: text(device["host"]),
    port: text(device["port"]),
    unitId: text(device["unitId"]),
    deviceInstance: text(device["deviceInstance"]),
    address: text(device["address"]),
    intervalSeconds: seconds(device["pollIntervalMs"]),
    points: points.map(pointDraft),
    original: device
  }
}

/** A new device for `protocol`, with one empty point to fill in. */
export const newDevice = (protocol: EditableProtocol): DeviceDraft => ({
  protocol,
  id: "",
  autoId: true,
  host: "",
  port: "",
  unitId: "",
  deviceInstance: "",
  address: "",
  intervalSeconds: "",
  points: [newPoint(protocol)],
  original: undefined
})

/** A typed number as the file keeps it: a number when it is one, else the text, so the gateway's check names it. */
const typedNumber = (typed: string, scale = 1): unknown => {
  const trimmed = typed.trim().replace(",", ".")
  const number = Number(trimmed)
  return trimmed !== "" && Number.isFinite(number) ? Math.round(number * scale * 1e9) / 1e9 : typed.trim()
}

/** `value` under `key`, or the key removed when the field is empty. */
const setOrRemove = (target: JsonObject, key: string, value: unknown) => {
  if (value === "" || value === undefined) delete target[key]
  else target[key] = value
}

/** A unit as typed, its common spellings (kW, °C) as the QUDT name the status page knows. */
export const unitValue = (typed: string) => {
  const trimmed = typed.trim()
  const known = Object.entries(unitSymbols).find(([, symbol]) => symbol.toLowerCase() === trimmed.toLowerCase())
  return known === undefined ? trimmed : `unit:${known[0]}`
}

/** A unit as the form shows it: the symbol people write for a QUDT name the page knows (kW for unit:KiloW). */
export const unitShown = (unit: string) => {
  const symbol = unit.startsWith("unit:") ? unitSymbols[unit.slice(5)] : undefined
  return symbol ?? unit
}

/** The units offered as the field is typed in: QUDT names with the symbol people write. */
export const unitChoices = Object.entries(unitSymbols).map(([name, symbol]) => ({ value: `unit:${name}`, symbol }))

const samePoint = (a: PointDraft, b: PointDraft) => {
  const { key: _a, autoId: _autoA, original: _originalA, ...left } = a
  const { key: _b, autoId: _autoB, original: _originalB, ...right } = b
  return JSON.stringify(left) === JSON.stringify(right)
}

/** A point as the file keeps it: the file's own when the form left it unchanged, else its fields written in. */
export const pointJson = (protocol: EditableProtocol, draft: PointDraft): JsonObject => {
  if (draft.original !== undefined && samePoint(draft, pointDraft(draft.original))) return draft.original
  const point: JsonObject = { ...draft.original }
  point["id"] = draft.id.trim()
  point["name"] = draft.name.trim()
  setOrRemove(point, "unit", unitValue(draft.unit))
  if (protocol === "modbus-tcp") {
    point["table"] = draft.table
    point["address"] = typedNumber(draft.register)
    const bits = draft.table === "coil" || draft.table === "discrete"
    if (bits) {
      point["dataType"] = "bool"
      delete point["byteOrder"]
    } else {
      setOrRemove(point, "dataType", draft.dataType)
      setOrRemove(point, "byteOrder", draft.byteOrder === "ABCD" ? "" : draft.byteOrder)
    }
    if (bits || (draft.scale.trim() === "" && draft.offset.trim() === "")) delete point["scaling"]
    else {
      const scaling: JsonObject = {}
      setOrRemove(scaling, "factor", draft.scale.trim() === "" ? "" : typedNumber(draft.scale))
      setOrRemove(scaling, "offset", draft.offset.trim() === "" ? "" : typedNumber(draft.offset))
      point["scaling"] = scaling
    }
  } else {
    point["objectType"] = draft.objectType.trim()
    point["instance"] = typedNumber(draft.instance)
  }
  delete point["deadband"]
  const previous = isObject(point["publish"]) ? point["publish"] : {}
  switch (draft.publish) {
    case "":
      delete point["publish"]
      break
    case "change": {
      const publish: JsonObject = { mode: "change" }
      setOrRemove(publish, "deadband", draft.deadband.trim() === "" ? "" : typedNumber(draft.deadband))
      if (previous["mode"] === "change") setOrRemove(publish, "maxSilenceMs", previous["maxSilenceMs"])
      point["publish"] = publish
      break
    }
    case "sample":
    case "aggregate": {
      const publish: JsonObject = { mode: draft.publish }
      setOrRemove(
        publish,
        "intervalMs",
        draft.publishSeconds.trim() === "" ? "" : typedNumber(draft.publishSeconds, 1000)
      )
      point["publish"] = publish
      break
    }
  }
  return point
}

/** A device as the file keeps it, with its points; keys the form does not know kept as they were. */
export const deviceJson = (draft: DeviceDraft): JsonObject => {
  const device: JsonObject = { ...draft.original }
  device["protocol"] = draft.protocol
  device["id"] = draft.id.trim()
  if (draft.protocol === "modbus-tcp") {
    device["host"] = draft.host.trim()
    setOrRemove(device, "port", draft.port.trim() === "" ? "" : typedNumber(draft.port))
    setOrRemove(device, "unitId", draft.unitId.trim() === "" ? "" : typedNumber(draft.unitId))
  } else {
    device["deviceInstance"] = typedNumber(draft.deviceInstance)
    setOrRemove(device, "address", draft.address.trim())
  }
  setOrRemove(
    device,
    "pollIntervalMs",
    draft.intervalSeconds.trim() === "" ? "" : typedNumber(draft.intervalSeconds, 1000)
  )
  device["points"] = draft.points.map((point) => pointJson(draft.protocol, point))
  return device
}

const format = (config: JsonObject) => `${JSON.stringify(config, null, 2)}\n`

/** The file's devices, or undefined when the file is not a JSON object. */
export const devicesOf = (fileText: string): ReadonlyArray<unknown> | undefined => {
  const config = parseConfigText(fileText)
  if (config === undefined) return undefined
  return Array.isArray(config["devices"]) ? config["devices"] : []
}

/** The file with `draft` at `index`, or added at the end when `index` is undefined. */
export const withDevice = (fileText: string, index: number | undefined, draft: DeviceDraft): string | undefined => {
  const config = parseConfigText(fileText)
  if (config === undefined) return undefined
  const devices: Array<unknown> = Array.isArray(config["devices"]) ? [...config["devices"]] : []
  const device = deviceJson(draft)
  if (index === undefined || index >= devices.length) devices.push(device)
  else devices[index] = device
  return format({ ...config, devices })
}

/** The file without the device at `index`. */
export const withoutDevice = (fileText: string, index: number): string | undefined => {
  const config = parseConfigText(fileText)
  if (config === undefined) return undefined
  const devices: Array<unknown> = Array.isArray(config["devices"]) ? [...config["devices"]] : []
  devices.splice(index, 1)
  return format({ ...config, devices })
}

/** Where the device with `id` is in the file, or undefined. */
export const deviceIndex = (fileText: string, id: string): number | undefined => {
  const index = devicesOf(fileText)?.findIndex((device) => isObject(device) && device["id"] === id)
  return index === undefined || index < 0 ? undefined : index
}

/** The device fields' keys as issues name them, under `devices[i]`. */
const deviceFieldOf: Readonly<Record<string, string>> = {
  id: "id",
  host: "host",
  port: "port",
  unitId: "unitId",
  deviceInstance: "deviceInstance",
  address: "address",
  pollIntervalMs: "intervalSeconds"
}

/** The point fields' keys as issues name them, under `devices[i].points[j]`, for each protocol. */
const pointFieldOf = (protocol: EditableProtocol, key: string): string | undefined => {
  switch (key) {
    case "id":
    case "name":
    case "unit":
    case "deadband":
      return key
    case "publish":
      return "publish"
    case "scaling":
      return "scale"
    case "address":
      return protocol === "modbus-tcp" ? "register" : undefined
    case "table":
    case "dataType":
    case "byteOrder":
    case "objectType":
    case "instance":
      return key
    default:
      return undefined
  }
}

/** Issues by field: the device's (`host`), each point's by its key (`p3`), and what the form has no field for. */
export interface DeviceIssues {
  readonly device: Readonly<Record<string, ReadonlyArray<string>>>
  readonly points: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<string>>>>>
  /** About this device, but no field of the form (a writable point's limits, a key added by hand). */
  readonly other: ReadonlyArray<string>
  /** About the rest of the file, which this form does not change. */
  readonly elsewhere: ReadonlyArray<string>
}

const pathText = (path: ConfigIssue["path"]) => path.join(".")

/** The check's issues for the device at `index` of the candidate, by field of `draft`. */
export const deviceIssues = (issues: ReadonlyArray<ConfigIssue>, index: number, draft: DeviceDraft): DeviceIssues => {
  const device: Record<string, Array<string>> = {}
  const points: Record<string, Record<string, Array<string>>> = {}
  const other: Array<string> = []
  const elsewhere: Array<string> = []
  for (const issue of issues) {
    const [section, position, key, pointIndex, pointKey] = issue.path
    if (section !== "devices" || position !== index) {
      elsewhere.push(issue.path.length === 0 ? issue.message : `${pathText(issue.path)}: ${issue.message}`)
      continue
    }
    if (key === "points" && typeof pointIndex === "number") {
      const point = draft.points[pointIndex]
      const field = typeof pointKey === "string" ? pointFieldOf(draft.protocol, pointKey) : undefined
      if (point !== undefined && field !== undefined) {
        ;((points[point.key] ??= {})[field] ??= []).push(issue.message)
        continue
      }
      if (point !== undefined && pointKey === undefined) {
        ;((points[point.key] ??= {})["name"] ??= []).push(issue.message)
        continue
      }
    }
    const field = typeof key === "string" ? deviceFieldOf[key] : undefined
    if (field !== undefined) (device[field] ??= []).push(issue.message)
    else if (key === "points" && pointIndex === undefined) (device["points"] ??= []).push(issue.message)
    else other.push(`${pathText(issue.path.slice(2))}: ${issue.message}`)
  }
  return { device, points, other, elsewhere }
}

const isEmptyField = (record: object, field: string) => {
  const value: unknown = Object.entries(record).find(([key]) => key === field)?.[1]
  return typeof value === "string" && value.trim() === ""
}

/**
 * The issues without those of fields still empty: a new device's form does not open red. Whether any were left out
 * comes with them, so the page can say why Save waits.
 */
export const withoutEmptyFields = (
  issues: DeviceIssues,
  draft: DeviceDraft
): DeviceIssues & { readonly quiet: boolean } => {
  let quiet = false
  const keep = (record: object, byField: Readonly<Record<string, ReadonlyArray<string>>>) =>
    Object.fromEntries(
      Object.entries(byField).filter(([field]) => {
        const empty = isEmptyField(record, field)
        if (empty) quiet = true
        return !empty
      })
    )
  const device = keep(draft, issues.device)
  const points = Object.fromEntries(
    draft.points.map((point) => [point.key, keep(point, issues.points[point.key] ?? {})])
  )
  return { ...issues, device, points, quiet }
}

/** Whether there is anything to say under a field. */
export const hasIssues = (issues: DeviceIssues) =>
  Object.keys(issues.device).length > 0 ||
  Object.keys(issues.points).length > 0 ||
  issues.other.length > 0 ||
  issues.elsewhere.length > 0

/** Whether the form differs from the file's device (always, for a new one). */
export const isDeviceChanged = (draft: DeviceDraft) => {
  if (draft.original === undefined) return true
  return JSON.stringify(deviceJson(draft)) !== JSON.stringify(draft.original)
}

/** The Modbus tables, as people name them. */
export const tables = [
  { value: "holding", label: "Holding register" },
  { value: "input", label: "Input register" },
  { value: "coil", label: "Coil" },
  { value: "discrete", label: "Discrete input" }
] as const

export const dataTypes = [
  "float32",
  "int16",
  "uint16",
  "int32",
  "uint32",
  "int64",
  "uint64",
  "float64",
  "bool"
] as const

export const byteOrders = [
  { value: "ABCD", label: "ABCD (high word first)" },
  { value: "CDAB", label: "CDAB (low word first)" },
  { value: "BADC", label: "BADC (bytes swapped)" },
  { value: "DCBA", label: "DCBA (little-endian)" }
] as const

/** BACnet object types a point is usually read from; any other is typed in the file. */
export const objectTypes = [
  "analog-input",
  "analog-output",
  "analog-value",
  "binary-input",
  "binary-output",
  "binary-value",
  "multi-state-input",
  "multi-state-output",
  "multi-state-value"
] as const

export const publishModes: ReadonlyArray<{ readonly value: PublishMode; readonly label: string }> = [
  { value: "", label: "Every read (default)" },
  { value: "change", label: "On change" },
  { value: "sample", label: "Latest, every n seconds" },
  { value: "aggregate", label: "Min, max, average every n seconds" }
]

/** Whether a Modbus point reads bits (a coil or discrete input), which have no type, byte order or scaling. */
export const readsBits = (point: PointDraft) => point.table === "coil" || point.table === "discrete"

/** A short line for a point in a list: where it is read from. */
export const pointSource = (protocol: EditableProtocol, point: PointDraft) =>
  protocol === "modbus-tcp"
    ? `${tables.find((table) => table.value === point.table)?.label ?? point.table} ${point.register || "?"}${readsBits(point) ? "" : `, ${point.dataType || "?"}`}`
    : `${point.objectType || "?"} ${point.instance || "?"}`
