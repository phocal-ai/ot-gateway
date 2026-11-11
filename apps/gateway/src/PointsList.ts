/**
 * A points list, the spreadsheet most building projects start from, turned into the config's `devices`.
 *
 * One row per point, with a header row. The columns are described once, in PointsSchema.ts
 * (`ot-gateway points schema` prints them).
 *
 * Commas, semicolons (what Excel writes where the decimal mark is a comma) or tabs separate the fields, the
 * first line decides which, and a decimal comma is read as a point. A row with more fields than the header (an
 * unquoted decimal comma), a quote never closed and a column named twice are refused, naming the line. Nothing is
 * made writable: a write is a
 * decision for the config, not for a spreadsheet. The result still goes through the gateway's schema, which
 * checks everything this module does not.
 */
import { Effect, Result, Schema } from "effect"
import { slugify } from "./Slug.ts"
import type { Profile, ProfilePoint } from "./Profile.ts"
import { closestMatch } from "./Suggest.ts"

export class PointsListError extends Schema.TaggedError<PointsListError>()("PointsListError", {
  message: Schema.String
}) {}

/** One record of a delimited text: its fields and the 1-based line of the text it starts on. */
export interface DelimitedRecord {
  readonly line: number
  readonly fields: ReadonlyArray<string>
}

/** A quote that is never closed: the line it opened on, and the records read up to the end of the text. */
export interface UnterminatedQuote {
  readonly line: number
  readonly records: ReadonlyArray<DelimitedRecord>
}

/** The separator of a delimited text: whichever of `;`, tab and `,` its first line has most of (`;` before tab before `,` on a tie). */
export const detectDelimiter = (text: string) => {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ""
  return [";", "\t", ","].reduce((best, candidate) =>
    firstLine.split(candidate).length > firstLine.split(best).length ? candidate : best
  )
}

/**
 * The records of a delimited text (RFC 4180: quotes, doubled quotes, line breaks inside quotes), each with the line
 * it starts on, empty lines dropped. The separator is the one the first line has most of, unless given. A quote that
 * is never closed is a failure naming the line it opened on.
 */
export const readDelimited = (
  text: string,
  separator?: string
): Result.Result<ReadonlyArray<DelimitedRecord>, UnterminatedQuote> => {
  const body = text.replace(/^﻿/, "")
  const delimiter = separator ?? detectDelimiter(body)
  const records: Array<DelimitedRecord> = []
  let row: Array<string> = []
  let field = ""
  let quoted = false
  let line = 1
  let rowLine = 1
  let quoteLine = 1
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        field += '"'
        index++
      } else if (char === '"') quoted = false
      else {
        field += char
        if (char === "\n" || (char === "\r" && body[index + 1] !== "\n")) line++
      }
    } else if (char === '"' && field === "") {
      quoted = true
      quoteLine = line
    } else if (char === delimiter) {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[index + 1] === "\n") index++
      row.push(field)
      records.push({ line: rowLine, fields: row })
      row = []
      field = ""
      line++
      rowLine = line
    } else field += char
  }
  if (field !== "" || row.length > 0 || quoted) {
    row.push(field)
    records.push({ line: rowLine, fields: row })
  }
  const filled = records.filter((record) => record.fields.some((value) => value.trim() !== ""))
  return quoted ? Result.fail({ line: quoteLine, records: filled }) : Result.succeed(filled)
}

/**
 * Fields of a delimited text, as `readDelimited` reads them, without line numbers. A quote that is never closed
 * runs to the end of the text.
 */
export const parseDelimited = (text: string, separator?: string): ReadonlyArray<ReadonlyArray<string>> => {
  const read = readDelimited(text, separator)
  return (Result.isSuccess(read) ? read.success : read.failure.records).map((record) => record.fields)
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
  rpm: "unit:REV-PER-MIN",
  va: "unit:V-A",
  kva: "unit:KiloV-A",
  var: "unit:V-A_Reactive",
  kvar: "unit:KiloV-A_Reactive"
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

/**
 * The columns this reader reads, the same as PointsSchema.ts's `pointsListColumns` (its test checks they agree).
 * Kept here so the reader does not import the schema, which imports the reader.
 */
export const readColumns: ReadonlyArray<string> = [
  "device",
  "point",
  "unit",
  "interval_s",
  "publish",
  "publish_s",
  "deadband",
  "scale",
  "offset",
  "host",
  "port",
  "unit_id",
  "profile",
  "register",
  "table",
  "type",
  "byte_order",
  "device_instance",
  "address",
  "object_type",
  "object_instance"
]

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

/** A profile point's value for a points list column. */
const profileValue = (point: ProfilePoint, column: string): string | undefined => {
  switch (column) {
    case "register":
      return String(point.register)
    case "table":
      return point.table
    case "type":
      return point.type
    case "byte_order":
      return point.byteOrder
    case "scale":
      return point.scale === undefined ? undefined : String(point.scale)
    case "offset":
      return point.offset === undefined ? undefined : String(point.offset)
    case "unit":
      return point.unit
    default:
      return undefined
  }
}

/**
 * A row as the rows it stands for: itself, or with a profile the profile's points it picks (`*` for all), each
 * taking the row's columns first (host, interval, publish, a byte order the meter was set to) and the profile's
 * registers for the rest.
 */
const expandProfile = Effect.fnUntraced(function* (row: Row, profiles: ReadonlyMap<string, Profile>) {
  const name = row.get("profile")
  if (name === undefined) return [row]
  const profile = profiles.get(name)
  if (profile === undefined) return yield* fail(`line ${row.line}: profile "${name}" was not loaded`)
  if (row.get("device_instance") !== undefined) {
    return yield* fail(`line ${row.line}: profiles describe Modbus devices; this row has a device_instance`)
  }
  for (const column of ["register", "table", "type"]) {
    if (row.get(column) !== undefined) {
      return yield* fail(`line ${row.line}: the row takes ${column} from profile ${profile.id}; leave ${column} empty`)
    }
  }
  const wanted = row.get("point") ?? "*"
  const ids = profile.points.map((point) => slugify(point.name))
  const picked =
    wanted === "*" ? profile.points : profile.points.filter((point) => slugify(point.name) === slugify(wanted))
  if (picked.length === 0) {
    const meant = closestMatch(slugify(wanted), ids)
    return yield* fail(
      `line ${row.line}: profile ${profile.id} has no point "${wanted}"${meant === undefined ? "" : `; did you mean ${meant}?`} (* takes all: ${ids.join(", ")})`
    )
  }
  return picked.map((point): Row => ({
    line: row.line,
    get: (column) => (column === "point" ? point.name : (row.get(column) ?? profileValue(point, column)))
  }))
})

/** The profiles a points list names, as written, for the caller to load before devicesFromPointsList. */
export const profileNames = (text: string): ReadonlyArray<string> => {
  const [header, ...records] = parseDelimited(text)
  const column = (header ?? []).map(columnName).indexOf("profile")
  if (column === -1) return []
  return [...new Set(records.flatMap((fields) => fields[column]?.trim() || []))]
}

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

/**
 * The rows of one device as its config entry. Its id must not be in the config (`inConfig`) or taken by another
 * spelling earlier in the list (`listed`, id to name as written, which this adds to).
 */
const toDevice = Effect.fnUntraced(function* (
  name: string,
  rows: ReadonlyArray<Row>,
  inConfig: ReadonlySet<string>,
  listed: Map<string, string>
) {
  const id = slugify(name)
  if (id === "") return yield* fail(`device "${name}": its name has no letters or digits`)
  if (inConfig.has(id)) return yield* fail(`device id "${id}" is already in the config`)
  const earlier = listed.get(id)
  if (earlier !== undefined) {
    return yield* fail(`"${earlier}" and "${name}" are the same device id "${id}"; use one spelling`)
  }
  listed.set(id, name)
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
  existing: ReadonlyArray<string> = [],
  profiles: ReadonlyMap<string, Profile> = new Map()
) {
  const read = readDelimited(text)
  if (Result.isFailure(read)) return yield* fail(`line ${read.failure.line}: a quote opened here is never closed`)
  const [headerRecord, ...records] = read.success
  if (headerRecord === undefined) return yield* fail("the points list is empty")
  const header = headerRecord.fields
  const columns = header.map(columnName)
  for (const required of ["device", "point"]) {
    if (!columns.includes(required)) {
      return yield* fail(`the points list needs a "${required}" column; its header has ${header.join(", ")}`)
    }
  }
  // Only columns the reader reads: unknown ones are ignored, so two of the same name (two "Notes") are fine.
  for (const [index, column] of columns.entries()) {
    const first = columns.indexOf(column)
    if (readColumns.includes(column) && first !== index) {
      return yield* fail(
        `the header has both "${header[first]?.trim()}" and "${header[index]?.trim()}", which are the same column`
      )
    }
  }
  for (const record of records) {
    // Extra fields that are all empty are trailing delimiters, which spreadsheets export.
    if (record.fields.slice(header.length).some((value) => value.trim() !== "")) {
      return yield* fail(
        `line ${record.line}: ${record.fields.length} fields, but the header has ${header.length} columns; a value containing the delimiter (a decimal comma, say) needs quotes`
      )
    }
  }
  const rows: ReadonlyArray<Row> = records.map(({ line, fields }) => ({
    line,
    get: (column) => {
      const value = fields[columns.indexOf(column)]?.trim()
      return value === undefined || value === "" ? undefined : value
    }
  }))
  const byDevice = new Map<string, Array<Row>>()
  for (const row of rows) {
    const device = row.get("device")
    if (device === undefined) return yield* fail(`line ${row.line}: no device`)
    byDevice.set(device, [...(byDevice.get(device) ?? []), ...(yield* expandProfile(row, profiles))])
  }
  const inConfig = new Set(existing)
  const listed = new Map<string, string>()
  return yield* Effect.forEach(byDevice, ([name, deviceRows]) => toDevice(name, deviceRows, inConfig, listed))
})
