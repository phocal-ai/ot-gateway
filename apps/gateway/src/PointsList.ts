/**
 * A points list, the spreadsheet most building projects start from, turned into the config's `devices`.
 *
 * One row per point, with a header row. The columns are described once, in PointsSchema.ts
 * (`ot-gateway points schema` prints them).
 *
 * Commas, semicolons (what Excel writes where the decimal mark is a comma) or tabs separate the fields, the
 * first line decides which, and a decimal comma is read as a point. Nothing is made writable: a write is a
 * decision for the config, not for a spreadsheet. The result still goes through the gateway's schema, which
 * checks everything this module does not.
 */
import { Effect, Schema } from "effect"
import { slugify } from "./Discover.ts"

export class PointsListError extends Schema.TaggedError<PointsListError>()("PointsListError", {
  message: Schema.String
}) {}

/** Fields of a delimited text (RFC 4180: quotes, doubled quotes, line breaks inside quotes), empty lines dropped. */
export const parseDelimited = (text: string): ReadonlyArray<ReadonlyArray<string>> => {
  const body = text.replace(/^﻿/, "")
  const firstLine = body.split(/\r?\n/, 1)[0] ?? ""
  const delimiter = [";", "\t", ","].reduce((best, candidate) =>
    firstLine.split(candidate).length > firstLine.split(best).length ? candidate : best
  )
  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  let field = ""
  let quoted = false
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        field += '"'
        index++
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"' && field === "") quoted = true
    else if (char === delimiter) {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[index + 1] === "\n") index++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else field += char
  }
  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((fields) => fields.some((value) => value.trim() !== ""))
}

/** Common ways of writing a unit, as QUDT names. Anything else is kept as written. */
const units: Record<string, string> = {
  w: "unit:W",
  kw: "unit:KiloW",
  mw: "unit:MegaW",
  wh: "unit:W-HR",
  kwh: "unit:KiloW-HR",
  mwh: "unit:MegaW-HR",
  "°c": "unit:DEG_C",
  degc: "unit:DEG_C",
  c: "unit:DEG_C",
  "°f": "unit:DEG_F",
  degf: "unit:DEG_F",
  k: "unit:K",
  "%": "unit:PERCENT",
  "%rh": "unit:PERCENT_RH",
  v: "unit:V",
  a: "unit:A",
  hz: "unit:HZ",
  pa: "unit:PA",
  kpa: "unit:KiloPA",
  bar: "unit:BAR",
  "m3/h": "unit:M3-PER-HR",
  "m³/h": "unit:M3-PER-HR",
  "l/s": "unit:L-PER-SEC",
  ppm: "unit:PPM",
  lx: "unit:LUX",
  lux: "unit:LUX",
  rpm: "unit:REV-PER-MIN"
}

/** A unit as the config writes it: a QUDT name for the common spellings, otherwise as given. */
export const qudtUnit = (unit: string) => {
  const trimmed = unit.trim()
  if (trimmed.startsWith("unit:")) return trimmed
  return units[trimmed.toLowerCase().replace(/\s+/g, "")] ?? trimmed
}

/** Header aliases, after lower-casing and turning spaces and `-` into `_`. */
export const columnAliases: Readonly<Record<string, string>> = {
  device_name: "device",
  point_name: "point",
  name: "point",
  ip: "host",
  unitid: "unit_id",
  slave: "unit_id",
  slave_id: "unit_id",
  interval: "interval_s",
  poll_s: "interval_s",
  interval_seconds: "interval_s",
  data_type: "type",
  datatype: "type",
  byteorder: "byte_order",
  factor: "scale",
  object: "object_type",
  publish_mode: "publish",
  publish_interval_s: "publish_s",
  publish_every_s: "publish_s"
}

/** A header as the column it names: lower case, `_` for spaces and `-`, aliases resolved. */
export const columnName = (header: string) => {
  const normal = header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
  return columnAliases[normal] ?? normal
}

interface Row {
  readonly line: number
  readonly get: (column: string) => string | undefined
}

const fail = (message: string) => Effect.fail(new PointsListError({ message }))

const numberIn = Effect.fnUntraced(function* (row: Row, column: string) {
  const text = row.get(column)
  if (text === undefined) return undefined
  const value = Number(text.replace(",", "."))
  if (!Number.isFinite(value)) return yield* fail(`line ${row.line}: ${column} "${text}" is not a number`)
  return value
})

const publishModes = ["sample", "aggregate", "change"]

/**
 * The point's `publish` or `deadband` from its `publish`, `publish_s` and `deadband` columns. A deadband alone stays
 * the short form; ranges and clock alignment are the schema's to check.
 */
const publishOf = Effect.fnUntraced(function* (row: Row, name: string) {
  const mode = row.get("publish")?.toLowerCase()
  const seconds = yield* numberIn(row, "publish_s")
  const deadband = yield* numberIn(row, "deadband")
  const intervalMs = seconds === undefined ? {} : { intervalMs: Math.round(seconds * 1000) }
  if (mode === undefined) {
    if (seconds !== undefined) {
      return yield* fail(`line ${row.line}: "${name}" has publish_s but no publish (sample or aggregate)`)
    }
    return deadband === undefined ? {} : { deadband }
  }
  if (!publishModes.includes(mode)) {
    return yield* fail(`line ${row.line}: publish "${mode}" is not one of ${publishModes.join(", ")}`)
  }
  if (mode === "change") {
    if (seconds !== undefined)
      return yield* fail(`line ${row.line}: "${name}" sends on change, so it takes no publish_s`)
    return { publish: { mode, ...(deadband === undefined ? {} : { deadband }) } }
  }
  if (deadband !== undefined) {
    return yield* fail(`line ${row.line}: "${name}" has a deadband, which only change mode uses`)
  }
  if (mode === "aggregate" && seconds === undefined) {
    return yield* fail(`line ${row.line}: "${name}" aggregates, so it needs publish_s, the window (900 for 15 minutes)`)
  }
  return { publish: { mode, ...intervalMs } }
})

const commonPoint = Effect.fnUntraced(function* (row: Row, id: string, name: string) {
  const unit = row.get("unit")
  const publish = yield* publishOf(row, name)
  const factor = yield* numberIn(row, "scale")
  const offset = yield* numberIn(row, "offset")
  return {
    id,
    name,
    ...(unit === undefined ? {} : { unit: qudtUnit(unit) }),
    ...publish,
    ...(factor === undefined && offset === undefined
      ? {}
      : { scaling: { ...(factor === undefined ? {} : { factor }), ...(offset === undefined ? {} : { offset }) } })
  }
})

const modbusPoint = Effect.fnUntraced(function* (row: Row, id: string, name: string) {
  const table = row.get("table")?.toLowerCase() ?? "holding"
  const address = yield* numberIn(row, "register")
  if (address === undefined) return yield* fail(`line ${row.line}: "${name}" has a host but no register`)
  const bits = table === "coil" || table === "discrete"
  const dataType = row.get("type")?.toLowerCase() ?? (bits ? "bool" : undefined)
  if (dataType === undefined) {
    return yield* fail(
      `line ${row.line}: "${name}" needs a type (int16, uint16, int32, uint32, float32, …): the register alone does not say how to read it`
    )
  }
  const byteOrder = row.get("byte_order")?.toUpperCase()
  return {
    ...(yield* commonPoint(row, id, name)),
    table,
    address,
    dataType,
    ...(byteOrder === undefined ? {} : { byteOrder })
  }
})

const bacnetPoint = Effect.fnUntraced(function* (row: Row, id: string, name: string) {
  const objectType = row
    .get("object_type")
    ?.toLowerCase()
    .replace(/[\s_]+/g, "-")
  const instance = yield* numberIn(row, "object_instance")
  if (objectType === undefined || instance === undefined) {
    return yield* fail(`line ${row.line}: "${name}" needs object_type and object_instance (analog-input 1, say)`)
  }
  return { ...(yield* commonPoint(row, id, name)), objectType, instance }
})

/** A device-level value: the same on every row of the device that gives it. */
const deviceField = Effect.fnUntraced(function* (name: string, rows: ReadonlyArray<Row>, column: string) {
  const values = [...new Set(rows.flatMap((row) => row.get(column) ?? []))]
  if (values.length > 1)
    return yield* fail(`device "${name}": ${column} differs between its rows (${values.join(", ")})`)
  return values[0]
})

const deviceNumber = Effect.fnUntraced(function* (name: string, rows: ReadonlyArray<Row>, column: string) {
  const text = yield* deviceField(name, rows, column)
  const line = rows[0]?.line ?? 0
  return yield* numberIn({ line, get: (wanted) => (wanted === column ? text : undefined) }, column)
})

interface NamedPoint {
  readonly row: Row
  readonly pointId: string
  readonly pointName: string
}

/** The points of one device with their ids, which must be unique within it. */
const namedPoints = Effect.fnUntraced(function* (name: string, rows: ReadonlyArray<Row>) {
  const lines = new Map<string, number>()
  const points: Array<NamedPoint> = []
  for (const row of rows) {
    const pointName = row.get("point") ?? ""
    const pointId = slugify(pointName)
    if (pointId === "") return yield* fail(`line ${row.line}: the point name "${pointName}" has no letters or digits`)
    const seen = lines.get(pointId)
    if (seen !== undefined) {
      return yield* fail(`lines ${seen} and ${row.line}: two points of "${name}" are both called ${pointId}`)
    }
    lines.set(pointId, row.line)
    points.push({ row, pointId, pointName })
  }
  return points
})

/** The rows of one device as its config entry. */
const toDevice = Effect.fnUntraced(function* (name: string, rows: ReadonlyArray<Row>, taken: Set<string>) {
  const id = slugify(name)
  if (id === "") return yield* fail(`device "${name}": its name has no letters or digits`)
  if (taken.has(id)) return yield* fail(`device id "${id}" is already in the config`)
  taken.add(id)
  const points = yield* namedPoints(name, rows)
  const intervalSeconds = yield* deviceNumber(name, rows, "interval_s")
  const pollIntervalMs = intervalSeconds === undefined ? {} : { pollIntervalMs: Math.round(intervalSeconds * 1000) }
  const host = yield* deviceField(name, rows, "host")
  if (host !== undefined) {
    const port = yield* deviceNumber(name, rows, "port")
    const unitId = yield* deviceNumber(name, rows, "unit_id")
    return {
      protocol: "modbus-tcp" as const,
      id,
      host,
      ...(port === undefined ? {} : { port }),
      ...(unitId === undefined ? {} : { unitId }),
      ...pollIntervalMs,
      points: yield* Effect.forEach(points, (point) => modbusPoint(point.row, point.pointId, point.pointName))
    }
  }
  const deviceInstance = yield* deviceNumber(name, rows, "device_instance")
  if (deviceInstance !== undefined) {
    const address = yield* deviceField(name, rows, "address")
    return {
      protocol: "bacnet-ip" as const,
      id,
      deviceInstance,
      ...(address === undefined ? {} : { address }),
      ...pollIntervalMs,
      points: yield* Effect.forEach(points, (point) => bacnetPoint(point.row, point.pointId, point.pointName))
    }
  }
  return yield* fail(`device "${name}": give it a host (Modbus TCP) or a device_instance (BACnet/IP)`)
})

export type PointsListDevice = Effect.Success<ReturnType<typeof toDevice>>

/**
 * The devices of a points list, with ids that are not in `existing`. Fails with the first mistake, naming its
 * line, the way `check` names a path.
 */
export const devicesFromPointsList = Effect.fn("devicesFromPointsList")(function* (
  text: string,
  existing: ReadonlyArray<string> = []
) {
  const [header, ...records] = parseDelimited(text)
  if (header === undefined) return yield* fail("the points list is empty")
  const columns = header.map(columnName)
  for (const required of ["device", "point"]) {
    if (!columns.includes(required)) {
      return yield* fail(`the points list needs a "${required}" column; its header has ${header.join(", ")}`)
    }
  }
  const rows: ReadonlyArray<Row> = records.map((fields, index) => ({
    line: index + 2,
    get: (column) => {
      const value = fields[columns.indexOf(column)]?.trim()
      return value === undefined || value === "" ? undefined : value
    }
  }))
  const byDevice = new Map<string, Array<Row>>()
  for (const row of rows) {
    const device = row.get("device")
    if (device === undefined) return yield* fail(`line ${row.line}: no device`)
    byDevice.set(device, [...(byDevice.get(device) ?? []), row])
  }
  const taken = new Set(existing)
  return yield* Effect.forEach(byDevice, ([name, deviceRows]) => toDevice(name, deviceRows, taken))
})
