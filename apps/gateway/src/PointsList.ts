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
import { Device } from "@ot-gateway/core"
import { Effect, Predicate, Result, Schema } from "effect"
import { configIssues } from "./ConfigStore.ts"
import { slugify } from "./Slug.ts"
import type { Profile, ProfilePoint } from "./Profile.ts"
import { closestMatch } from "./Suggest.ts"

/**
 * One mistake in a points list, where it is: the 1-based `line` and the `column` (as the schema names it) with the
 * `value` written there, or the config `path` the gateway's schema found it at. `message` says what is wrong
 * without the line, which `--json` gives apart.
 */
export const PointsListIssue = Schema.Struct({
  line: Schema.optionalKey(Schema.Number),
  column: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  message: Schema.String
})
export type PointsListIssue = typeof PointsListIssue.Type

/**
 * What is wrong with a points list. `message` is every mistake, one per line, as stderr shows them; `issues` the
 * same one by one for `--json`, when the reader knows where each one is.
 */
export class PointsListError extends Schema.TaggedError<PointsListError>()("PointsListError", {
  message: Schema.String,
  issues: Schema.optionalKey(Schema.Array(PointsListIssue))
}) {}

/** The mistakes of several errors as one, in the order of their lines: the whole list fixed in one pass. */
export const combinedError = (errors: ReadonlyArray<PointsListError>): PointsListError => {
  if (errors.length === 1 && errors[0] !== undefined) return errors[0]
  const issues = errors
    .flatMap((error) => error.issues ?? [{ message: error.message }])
    .map((issue, index) => ({ issue, index }))
    .toSorted((a, b) => (a.issue.line ?? Infinity) - (b.issue.line ?? Infinity) || a.index - b.index)
    .map(({ issue }) => issue)
  return new PointsListError({
    message: issues
      .map((issue) => (issue.line === undefined ? issue.message : `line ${issue.line}: ${issue.message}`))
      .join("\n"),
    issues
  })
}

/** The successes of `results`, or every failure among them as one error. */
const allOrIssues = <A>(results: ReadonlyArray<Result.Result<A, PointsListError>>) => {
  const failures = results.flatMap((result) => (Result.isFailure(result) ? [result.failure] : []))
  return failures.length > 0
    ? Effect.fail(combinedError(failures))
    : Effect.succeed(results.flatMap((result) => (Result.isSuccess(result) ? [result.success] : [])))
}

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

/**
 * Whether a points list is the JSON form: an array of rows, each an object with the columns as keys
 * (`[{"device": "Meter", "point": "Active power", "register": 100, …}]`). The CSV form's header row and quoting
 * have no part in it, which is what makes it the easier one for a program to write.
 */
export const isJsonList = (text: string) => /^[[{]/.test(text.replace(/^\uFEFF/, "").trimStart())

/** The 1-based line each element of a JSON array's top level starts on, in order. */
const elementLines = (text: string): ReadonlyArray<number> => {
  const lines: Array<number> = []
  let line = 1
  let depth = 0
  let inString = false
  let escaped = false
  let expecting = false
  let previous = ""
  for (const char of text) {
    // \n, \r\n and a bare \r each end a line, as readDelimited counts them.
    if (char === "\n" ? previous !== "\r" : char === "\r") line++
    previous = char
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (/\s/.test(char)) continue
    if (depth === 1 && expecting && char !== "]") {
      lines.push(line)
      expecting = false
    }
    if (char === '"') inString = true
    else if (char === "[" || char === "{") {
      depth++
      if (depth === 1) expecting = true
    } else if (char === "]" || char === "}") depth--
    else if (char === "," && depth === 1) expecting = true
  }
  return lines
}

/**
 * The line a JSON parser's message points at: its own `(line 3 column 5)` where it gives one, else the line of
 * its `position 41`, else (the text ended early) the last line.
 */
const jsonErrorLine = (text: string, message: string): number | undefined => {
  const given = /\(line (\d+) column \d+\)/.exec(message)?.[1]
  if (given !== undefined) return Number(given)
  const position = /position (\d+)/.exec(message)?.[1]
  const upTo =
    position === undefined
      ? /end of JSON input/.test(message)
        ? text.trimEnd()
        : undefined
      : text.slice(0, Number(position))
  return upTo === undefined ? undefined : upTo.split(/\r\n|\r|\n/).length
}

/** A JSON value as a points list field: text as it is, a number as written in JSON, nothing for null. */
const jsonField = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

/**
 * The JSON form's rows as the records of a delimited text: a header of every key in the order first used, then one
 * record per row with the line it starts on in the file, so a mistake names the line to fix there too.
 */
export const readJsonList = (text: string): Result.Result<ReadonlyArray<DelimitedRecord>, PointsListError> => {
  const body = text.replace(/^\uFEFF/, "")
  const decoded = Result.try({ try: (): unknown => JSON.parse(body), catch: (error) => String(error) })
  if (Result.isFailure(decoded)) {
    const line = jsonErrorLine(body, decoded.failure)
    const message = `not valid JSON: ${decoded.failure.replace(/^SyntaxError: /, "")}; check its commas, quotes and brackets (a JSON list is [{"device": "…", "point": "…", …}, …])`
    return Result.fail(
      line === undefined ? new PointsListError({ message: `the points list is ${message}` }) : lineError(line, message)
    )
  }
  const rows = decoded.success
  if (Array.isArray(rows) && rows.length === 0) return Result.succeed([])
  if (!Array.isArray(rows)) {
    return Result.fail(new PointsListError({ message: 'a JSON points list is an array of rows: [{"device": …}]' }))
  }
  const lines = elementLines(text)
  const header: Array<string> = []
  const errors: Array<PointsListError> = []
  const objects = rows.flatMap((row: unknown, index): Array<{ line: number; row: Record<string, unknown> }> => {
    const line = lines[index] ?? 1
    if (!Predicate.isObject(row) || Array.isArray(row)) {
      errors.push(lineError(line, 'each row of a JSON points list is an object, such as {"device": "Meter", …}'))
      return []
    }
    // Keys as columns, so `Unit` on one row and `unit` on another are one column, as in a CSV header.
    for (const [key, value] of Object.entries(row)) {
      if (!header.includes(columnName(key))) header.push(columnName(key))
      if (jsonField(value) === undefined) {
        errors.push(
          lineError(line, `${key} is an object or a list; write text or a number`, { column: columnName(key) })
        )
      }
    }
    return [{ line, row }]
  })
  if (errors.length > 0) return Result.fail(combinedError(errors))
  return Result.succeed([
    { line: 1, fields: header },
    ...objects.map(({ line, row }) => {
      const byColumn = new Map(Object.entries(row).map(([key, value]) => [columnName(key), value]))
      return { line, fields: header.map((column) => jsonField(byColumn.get(column)) ?? "") }
    })
  ])
}

/** A points list's records, either form: its header first. A list that cannot be read at all fails. */
const readList = (text: string): Result.Result<ReadonlyArray<DelimitedRecord>, PointsListError> => {
  if (isJsonList(text)) return readJsonList(text)
  const read = readDelimited(text)
  return Result.isSuccess(read)
    ? Result.succeed(read.success)
    : Result.fail(lineError(read.failure.line, "a quote opened here is never closed"))
}

/** A points list's fields, either form, header first; nothing for a list that cannot be read. */
export const listFields = (text: string): ReadonlyArray<ReadonlyArray<string>> => {
  if (!isJsonList(text)) return parseDelimited(text)
  const read = readJsonList(text)
  return Result.isSuccess(read) ? read.success.map((record) => record.fields) : []
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
  display_name: "name",
  label: "name",
  alarm_when: "alarm",
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
  "name",
  "unit",
  "interval_s",
  "publish",
  "publish_s",
  "deadband",
  "alarm",
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

/**
 * A header's columns as `columnName` names them. A list from before the `name` column has `name` where `point`
 * belongs: without a `point` column, `name` is the point.
 */
export const headerColumns = (header: ReadonlyArray<string>) => {
  const named = header.map(columnName)
  return named.includes("point") ? named : named.map((column) => (column === "name" ? "point" : column))
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

const fail = (message: string, issue: Partial<PointsListIssue> = {}) =>
  Effect.fail(new PointsListError({ message, issues: [{ ...issue, message }] }))

/** A mistake on a line of the list, as an error: `line 4: …`, the line apart in its issue. */
const lineError = (line: number, message: string, at: Partial<PointsListIssue> = {}) =>
  new PointsListError({ message: `line ${line}: ${message}`, issues: [{ line, ...at, message }] })

/** A mistake on one row, in `column` when it is about one, with the value written there. */
const failAt = (row: Row, column: string | undefined, message: string) => {
  const value = column === undefined ? undefined : row.get(column)
  return Effect.fail(
    lineError(row.line, message, {
      ...(column === undefined ? {} : { column }),
      ...(value === undefined ? {} : { value })
    })
  )
}

const numberIn = Effect.fnUntraced(function* (row: Row, column: string) {
  const text = row.get(column)
  if (text === undefined) return undefined
  const value = Number(text.replace(",", "."))
  if (!Number.isFinite(value)) return yield* failAt(row, column, `${column} "${text}" is not a number`)
  return value
})

const publishModes = ["sample", "aggregate", "change"]

/** A point as its row writes it, for an error to name: its `point` column, which may differ from its shown name. */
const listedAs = (row: Row, name: string) => row.get("point") ?? name

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
      return yield* failAt(
        row,
        "publish",
        `"${listedAs(row, name)}" has publish_s but no publish (sample or aggregate)`
      )
    }
    return deadband === undefined ? {} : { deadband }
  }
  if (!publishModes.includes(mode)) {
    return yield* failAt(row, "publish", `publish "${mode}" is not one of ${publishModes.join(", ")}`)
  }
  if (mode === "change") {
    if (seconds !== undefined)
      return yield* failAt(row, "publish_s", `"${listedAs(row, name)}" sends on change, so it takes no publish_s`)
    return { publish: { mode, ...(deadband === undefined ? {} : { deadband }) } }
  }
  if (deadband !== undefined) {
    return yield* failAt(row, "deadband", `"${listedAs(row, name)}" has a deadband, which only change mode uses`)
  }
  if (mode === "aggregate" && seconds === undefined) {
    return yield* failAt(
      row,
      "publish_s",
      `"${listedAs(row, name)}" aggregates, so it needs publish_s, the window (900 for 15 minutes)`
    )
  }
  return { publish: { mode, ...intervalMs } }
})

const alarmValues = ["on", "off"] as const

/** The point's `alarmWhen` from its `alarm` column: `on` or `off`, empty for a point that is no alarm. */
const alarmOf = Effect.fnUntraced(function* (row: Row, name: string) {
  const text = row.get("alarm")?.toLowerCase()
  if (text === undefined) return {}
  const alarmWhen = alarmValues.find((value) => value === text)
  if (alarmWhen === undefined) {
    return yield* failAt(
      row,
      "alarm",
      `"${listedAs(row, name)}" has alarm "${text}"; write on (the alarm is active when the value is true or not 0) or off (active when false or 0), or leave it empty`
    )
  }
  return { alarmWhen }
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
    ...(yield* alarmOf(row, name)),
    ...publish,
    ...(factor === undefined && offset === undefined
      ? {}
      : { scaling: { ...(factor === undefined ? {} : { factor }), ...(offset === undefined ? {} : { offset }) } })
  }
})

const modbusPoint = Effect.fnUntraced(function* (row: Row, id: string, name: string) {
  const table = row.get("table")?.toLowerCase() ?? "holding"
  const address = yield* numberIn(row, "register")
  if (address === undefined)
    return yield* failAt(row, "register", `"${listedAs(row, name)}" has a host but no register`)
  const bits = table === "coil" || table === "discrete"
  const dataType = row.get("type")?.toLowerCase() ?? (bits ? "bool" : undefined)
  if (dataType === undefined) {
    return yield* failAt(
      row,
      "type",
      `"${listedAs(row, name)}" needs a type (int16, uint16, int32, uint32, float32, …): the register alone does not say how to read it`
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
    return yield* failAt(
      row,
      "object_type",
      `"${listedAs(row, name)}" needs object_type and object_instance (analog-input 1, say)`
    )
  }
  return { ...(yield* commonPoint(row, id, name)), objectType, instance }
})

/** A device-level value: the same on every row of the device that gives it. */
const deviceField = Effect.fnUntraced(function* (name: string, rows: ReadonlyArray<Row>, column: string) {
  const values = [...new Set(rows.flatMap((row) => row.get(column) ?? []))]
  if (values.length > 1)
    return yield* fail(`device "${name}": ${column} differs between its rows (${values.join(", ")})`, { column })
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
  if (profile === undefined) return yield* failAt(row, "profile", `profile "${name}" was not loaded`)
  if (row.get("device_instance") !== undefined) {
    return yield* failAt(row, "device_instance", "profiles describe Modbus devices; this row has a device_instance")
  }
  for (const column of ["register", "table", "type"]) {
    if (row.get(column) !== undefined) {
      return yield* failAt(row, column, `the row takes ${column} from profile ${profile.id}; leave ${column} empty`)
    }
  }
  const wanted = row.get("point") ?? "*"
  const ids = profile.points.map((point) => slugify(point.name))
  const picked =
    wanted === "*" ? profile.points : profile.points.filter((point) => slugify(point.name) === slugify(wanted))
  if (picked.length === 0) {
    const meant = closestMatch(slugify(wanted), ids)
    return yield* failAt(
      row,
      "point",
      `profile ${profile.id} has no point "${wanted}"${meant === undefined ? "" : `; did you mean ${meant}?`} (* takes all: ${ids.join(", ")})`
    )
  }
  return picked.map((point): Row => ({
    line: row.line,
    get: (column) =>
      column === "point"
        ? point.name
        : // A name given on a row that stands for several points would name them all alike.
          column === "name" && picked.length > 1
          ? undefined
          : (row.get(column) ?? profileValue(point, column))
  }))
})

/** A unit as a points list writes it, what the config gets for it, and on how many rows. */
export interface UnitMapping {
  readonly written: string
  /** A QUDT name (`unit:KiloW`), or `written` itself when it is not a spelling `qudtUnit` knows. */
  readonly unit: string
  /** Whether `unit` is a QUDT name, as consumers of the `$meta` expect. */
  readonly qudt: boolean
  /** For a unit with no QUDT name, the QUDT name of a common spelling one typo away (`kWhh`: `unit:KiloW-HR`). */
  readonly suggestion?: string
  readonly points: number
}

/**
 * The QUDT name of the common spelling `written` is most likely a typo of (`kWhh`: `unit:KiloW-HR`), for three letters
 * or more.
 */
const closeUnit = (written: string) => {
  const spelled = written.trim().toLowerCase().replace(/\s+/g, "")
  if (spelled.length < 3) return undefined
  const meant = Object.keys(units).find((key) => typoOf(spelled, key))
  return meant === undefined ? undefined : units[meant]
}

/** The indexes of a text's UTF-16 code units. */
const positions = (text: string) => Array.from({ length: text.length }, (_, index) => index)

/**
 * Whether `written` is `known` with a letter doubled (`kWhh`) or two neighbours swapped (`kwH` written `khW`): typos,
 * not other units. A letter more, less or changed is left out on purpose: that is a prefix (`mbar`, `hPa`, `GWh`) or
 * another unit (`m/s`, not `l/s`) as often as a typo.
 */
const typoOf = (written: string, known: string) => {
  if (written.length === known.length) {
    const differ = positions(written).filter((index) => written[index] !== known[index])
    const [first, second] = differ
    return (
      differ.length === 2 &&
      first !== undefined &&
      second === first + 1 &&
      written[first] === known[second] &&
      written[second] === known[first]
    )
  }
  if (written.length !== known.length + 1) return false
  return positions(written).some(
    (index) =>
      index > 0 && written[index] === written[index - 1] && written.slice(0, index) + written.slice(index + 1) === known
  )
}

/** Each distinct unit the list's `unit` column writes, in the order first written, and what it becomes. */
export const unitsWritten = (text: string): ReadonlyArray<UnitMapping> => {
  const [header, ...records] = listFields(text)
  const column = headerColumns(header ?? []).indexOf("unit")
  if (column === -1) return []
  const counted = new Map<string, number>()
  for (const fields of records) {
    const written = fields[column]?.trim() ?? ""
    if (written !== "") counted.set(written, (counted.get(written) ?? 0) + 1)
  }
  return Array.from(counted, ([written, points]) => {
    const unit = qudtUnit(written)
    const qudt = unit.startsWith("unit:")
    const meant = qudt ? undefined : closeUnit(written)
    return { written, unit, qudt, ...(meant === undefined ? {} : { suggestion: meant }), points }
  })
}

/** The profiles a points list names, as written, for the caller to load before devicesFromPointsList. */
export const profileNames = (text: string): ReadonlyArray<string> => {
  const [header, ...records] = listFields(text)
  const column = (header ?? []).map(columnName).indexOf("profile")
  if (column === -1) return []
  return [...new Set(records.flatMap((fields) => fields[column]?.trim() || []))]
}

interface NamedPoint {
  readonly row: Row
  readonly pointId: string
  readonly pointName: string
}

/**
 * A name to show for a point (or device) written as an id: `active-power` → `Active power`, `main_breaker_tripped` →
 * `Main breaker tripped`. Anything that is not already a slug is a name as written, and kept.
 */
export const readableName = (written: string) =>
  slugify(written) === written ? (written.charAt(0).toUpperCase() + written.slice(1)).replace(/[-_]+/g, " ") : written

/** The points of one device with their ids, which must be unique within it. */
const namedPoints = (name: string, rows: ReadonlyArray<Row>) => {
  const lines = new Map<string, number>()
  const points: Array<NamedPoint> = []
  const errors: Array<PointsListError> = []
  for (const row of rows) {
    const written = row.get("point") ?? ""
    const pointId = slugify(written)
    const pointName = row.get("name") ?? readableName(written)
    const seen = lines.get(pointId)
    if (pointId === "") {
      errors.push(lineError(row.line, `the point name "${written}" has no letters or digits`, { column: "point" }))
    } else if (seen !== undefined) {
      errors.push(
        new PointsListError({
          message: `lines ${seen} and ${row.line}: two points of "${name}" are both called ${pointId}`,
          issues: [
            {
              line: row.line,
              column: "point",
              value: written,
              message: `two points of "${name}" are both called ${pointId}, here and on line ${seen}`
            }
          ]
        })
      )
    } else {
      lines.set(pointId, row.line)
      points.push({ row, pointId, pointName })
    }
  }
  return { points, errors }
}

/**
 * A schema message in the list's words and units: the config counts milliseconds under its own keys
 * (`pollIntervalMs`), the list seconds (`interval_s`), so "between 100 and 86400000" becomes "between 0.1 and 86400
 * (in seconds)" and a key the message names becomes the column.
 */
const inColumnUnits = (path: ReadonlyArray<string | number>, column: string, message: string) => {
  const field = path.at(-1)
  if (!column.endsWith("_s") || typeof field !== "string" || !field.endsWith("Ms")) return message
  const named = message.replaceAll("pollIntervalMs", "interval_s").replaceAll("intervalMs", "publish_s")
  return `${named.replace(/\d+(\.\d+)?/g, (number) => String(Number(number) / 1000))} (in seconds)`
}

/** The points list column a device field comes from, for a schema issue at `devices[i].<field>`. */
const deviceColumns: Readonly<Record<string, string>> = {
  id: "device",
  host: "host",
  port: "port",
  unitId: "unit_id",
  pollIntervalMs: "interval_s",
  deviceInstance: "device_instance",
  address: "address"
}

/** The column a point field comes from, for a schema issue at `points[j].<field>` (`publish.intervalMs`: two keys). */
const pointColumn = (path: ReadonlyArray<string | number>): string | undefined => {
  const [field, inner] = path
  switch (field) {
    case "id":
      return "point"
    case "dataType":
      return "type"
    case "byteOrder":
      return "byte_order"
    case "address":
      return "register"
    case "objectType":
      return "object_type"
    case "instance":
      return "object_instance"
    case "alarmWhen":
      return "alarm"
    case "scaling":
      return inner === "offset" ? "offset" : "scale"
    case "publish":
      return inner === "intervalMs" ? "publish_s" : inner === "deadband" ? "deadband" : "publish"
    case "name":
    case "unit":
    case "table":
    case "deadband":
      return field
    case undefined:
    default:
      return undefined
  }
}

/**
 * The device as the gateway's schema reads it, every finding at the line and column it comes from (a point's
 * row, or the device's first row), together with the mistakes found in its rows before. Fails with all of them.
 */
const checkedDevice = <D>(
  device: D,
  rows: ReadonlyArray<Row>,
  made: ReadonlyArray<{ readonly row: Row }>,
  errors: ReadonlyArray<PointsListError>
): Effect.Effect<D, PointsListError> =>
  Schema.decodeUnknownEffect(Device)(device, { errors: "all" }).pipe(
    Effect.as<ReadonlyArray<PointsListError>>([]),
    Effect.catchTag("SchemaError", (error) =>
      Effect.succeed(
        configIssues(error.issue)
          // A device whose every point has a mistake has no points left: those mistakes say it, not the schema.
          .filter(({ path }) => errors.length === 0 || path.length !== 1 || path[0] !== "points")
          .map(({ path, message }) => {
            const pointRow = path[0] === "points" && typeof path[1] === "number" ? made[path[1]]?.row : undefined
            const deviceColumn = typeof path[0] === "string" ? deviceColumns[path[0]] : undefined
            // A device's value may be written on any of its rows: the first that has it is where to fix it.
            const row =
              pointRow ??
              (deviceColumn === undefined ? undefined : rows.find((each) => each.get(deviceColumn) !== undefined)) ??
              rows[0]
            const column =
              pointRow === undefined
                ? typeof path[0] === "string"
                  ? deviceColumns[path[0]]
                  : undefined
                : pointColumn(path.slice(2))
            const value = column === undefined ? undefined : row?.get(column)
            const said =
              column === undefined
                ? message
                : `${column}${value === undefined ? "" : ` "${value}"`}: ${inColumnUnits(path, column, message)}`
            return row === undefined
              ? new PointsListError({ message: said, issues: [{ message: said }] })
              : lineError(row.line, said, {
                  ...(column === undefined ? {} : { column }),
                  ...(value === undefined ? {} : { value })
                })
          })
      )
    ),
    Effect.flatMap((found) => {
      const all = [...errors, ...found]
      return all.length === 0 ? Effect.succeed(device) : Effect.fail(combinedError(all))
    })
  )

/**
 * The rows of one device as its config entry. Its id must not be in the config (`inConfig`) or taken by another
 * spelling earlier in the list (`listed`, id to name as written, which this adds to).
 */
const toDevice = Effect.fnUntraced(function* (
  name: string,
  rows: ReadonlyArray<Row>,
  inConfig: ReadonlySet<string>,
  listed: Map<string, string>,
  /** What the id is made from, when not the name: another id the status page gave the device. */
  idFrom: string = name
) {
  const id = slugify(idFrom)
  if (id === "") return yield* fail(`device "${name}": its name has no letters or digits`)
  if (inConfig.has(id)) return yield* fail(`device id "${id}" is already in the config`)
  const earlier = listed.get(id)
  if (earlier !== undefined) {
    return yield* fail(`"${earlier}" and "${name}" are the same device id "${id}"; use one spelling`)
  }
  listed.set(id, name)
  const { points, errors: naming } = namedPoints(name, rows)
  /**
   * The device's points made by `make`, each with its row, and the mistakes in the rest and in their names: the
   * points that are right still go through the schema, so its findings come in the same pass.
   */
  const pointsOf = <A>(make: (point: NamedPoint) => Effect.Effect<A, PointsListError>) =>
    Effect.map(
      Effect.forEach(points, (point) => Effect.result(make(point))),
      (results) => ({
        made: results.flatMap((result, index) => {
          const row = points[index]?.row
          return Result.isSuccess(result) && row !== undefined ? [{ row, point: result.success }] : []
        }),
        errors: [...naming, ...results.flatMap((result) => (Result.isFailure(result) ? [result.failure] : []))]
      })
    )
  const intervalSeconds = yield* deviceNumber(name, rows, "interval_s")
  const pollIntervalMs = intervalSeconds === undefined ? {} : { pollIntervalMs: Math.round(intervalSeconds * 1000) }
  const host = yield* deviceField(name, rows, "host")
  if (host !== undefined) {
    const port = yield* deviceNumber(name, rows, "port")
    const unitId = yield* deviceNumber(name, rows, "unit_id")
    const { made, errors } = yield* pointsOf((point) => modbusPoint(point.row, point.pointId, point.pointName))
    const device = {
      protocol: "modbus-tcp" as const,
      id,
      host,
      ...(port === undefined ? {} : { port }),
      ...(unitId === undefined ? {} : { unitId }),
      ...pollIntervalMs,
      points: made.map(({ point }) => point)
    }
    return yield* checkedDevice(device, rows, made, errors)
  }
  const deviceInstance = yield* deviceNumber(name, rows, "device_instance")
  if (deviceInstance !== undefined) {
    const address = yield* deviceField(name, rows, "address")
    const { made, errors } = yield* pointsOf((point) => bacnetPoint(point.row, point.pointId, point.pointName))
    const device = {
      protocol: "bacnet-ip" as const,
      id,
      deviceInstance,
      ...(address === undefined ? {} : { address }),
      ...pollIntervalMs,
      points: made.map(({ point }) => point)
    }
    return yield* checkedDevice(device, rows, made, errors)
  }
  return yield* fail(`device "${name}": give it a host (Modbus TCP) or a device_instance (BACnet/IP)`)
})

export type PointsListDevice = Effect.Success<ReturnType<typeof toDevice>>

/** The rows of one device as the list has them, before they become its config entry. */
interface DeviceRows {
  readonly name: string
  /** The 1-based lines of its rows. */
  readonly lines: ReadonlyArray<number>
  readonly rows: ReadonlyArray<Row>
  /** A row naming a profile it cannot use: the device cannot be made, whatever its other rows say. */
  readonly expansionError: PointsListError | undefined
}

/**
 * A points list's rows by device, after the checks of the list as a whole (a quote never closed, the header, the
 * field counts, a row without a device), which fail: nothing in such a list can be trusted.
 */
const groupRows = Effect.fnUntraced(function* (text: string, profiles: ReadonlyMap<string, Profile>) {
  const read = readList(text)
  if (Result.isFailure(read)) return yield* read.failure
  const [headerRecord, ...records] = read.success
  if (headerRecord === undefined) return yield* fail("the points list is empty")
  const header = headerRecord.fields
  const columns = headerColumns(header)
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
  // Extra fields that are all empty are trailing delimiters, which spreadsheets export.
  const overfull = records.filter((record) => record.fields.slice(header.length).some((value) => value.trim() !== ""))
  if (overfull.length > 0) {
    return yield* combinedError(
      overfull.map((record) =>
        lineError(
          record.line,
          `${record.fields.length} fields, but the header has ${header.length} columns; a value containing the delimiter (a decimal comma, say) needs quotes`
        )
      )
    )
  }
  const rows: ReadonlyArray<Row> = records.map(({ line, fields }) => ({
    line,
    get: (column) => {
      const value = fields[columns.indexOf(column)]?.trim()
      return value === undefined || value === "" ? undefined : value
    }
  }))
  const deviceless = rows.filter((row) => row.get("device") === undefined)
  if (deviceless.length > 0) {
    return yield* combinedError(deviceless.map((row) => lineError(row.line, "no device", { column: "device" })))
  }
  const byDevice = new Map<string, { lines: Array<number>; rows: Array<Row>; expansionError?: PointsListError }>()
  for (const row of rows) {
    const device = row.get("device")
    if (device === undefined) continue
    const entry = byDevice.get(device) ?? { lines: [], rows: [] }
    byDevice.set(device, entry)
    entry.lines.push(row.line)
    const expanded = yield* Effect.result(expandProfile(row, profiles))
    if (Result.isSuccess(expanded)) entry.rows.push(...expanded.success)
    else {
      entry.expansionError =
        entry.expansionError === undefined ? expanded.failure : combinedError([entry.expansionError, expanded.failure])
    }
  }
  return [...byDevice].map(([name, entry]): DeviceRows => ({
    name,
    lines: entry.lines,
    rows: entry.rows,
    expansionError: entry.expansionError
  }))
})

/**
 * The devices of a points list, with ids that are not in `existing`. Fails with every mistake in it, each naming
 * its line and column, the way `check` names a path, so the whole list is fixed in one pass. A mistake in the list
 * as a whole (its header, a quote never closed) stops it there.
 */
export const devicesFromPointsList = Effect.fn("devicesFromPointsList")(function* (
  text: string,
  existing: ReadonlyArray<string> = [],
  profiles: ReadonlyMap<string, Profile> = new Map()
) {
  const groups = yield* groupRows(text, profiles)
  const inConfig = new Set(existing)
  const listed = new Map<string, string>()
  const results = yield* Effect.forEach(groups, (group) =>
    checkedGroup(group, group.rows, inConfig, listed, group.name)
  )
  return yield* allOrIssues(results)
})

/**
 * One device of the list as a result: its entry, or every mistake in it. A row whose profile cannot be used does
 * not stop the rest: the rows that expanded are checked too, and the device's id is taken, so a later spelling of
 * it is named in the same pass.
 */
const checkedGroup = (
  group: DeviceRows,
  rows: ReadonlyArray<Row>,
  inConfig: ReadonlySet<string>,
  listed: Map<string, string>,
  idFrom: string
): Effect.Effect<Result.Result<PointsListDevice, PointsListError>> => {
  const expansionError = group.expansionError
  if (expansionError === undefined) return Effect.result(toDevice(group.name, rows, inConfig, listed, idFrom))
  if (rows.length === 0) {
    const id = slugify(idFrom)
    if (id !== "" && !listed.has(id)) listed.set(id, group.name)
    return Effect.succeed(Result.fail(expansionError))
  }
  return Effect.map(Effect.result(toDevice(group.name, rows, inConfig, listed, idFrom)), (result) =>
    Result.fail(Result.isFailure(result) ? combinedError([expansionError, result.failure]) : expansionError)
  )
}

/** One device of a points list, checked on its own: its config entry, or what is wrong with it. */
export interface CheckedDevice {
  /** The device as the list names it. */
  readonly name: string
  readonly lines: ReadonlyArray<number>
  readonly result: Result.Result<PointsListDevice, PointsListError>
}

/**
 * What the status page changes about one device of a list before adding it, the file left as it is: the id it gets,
 * and the host (Modbus TCP) or address (BACnet/IP) of every row of it. Empty values are left out.
 */
export interface DeviceOverride {
  readonly id?: string | undefined
  readonly host?: string | undefined
  readonly address?: string | undefined
}

/** The rows of a device with an override's host and address in place of the file's. */
const overriddenRows = (rows: ReadonlyArray<Row>, override: DeviceOverride): ReadonlyArray<Row> => {
  const replaced = new Map<string, string>()
  for (const column of ["host", "address"] as const) {
    const value = override[column]?.trim()
    if (value !== undefined && value !== "") replaced.set(column, value)
  }
  if (replaced.size === 0) return rows
  return rows.map((row) => ({ line: row.line, get: (column) => replaced.get(column) ?? row.get(column) }))
}

/**
 * The devices of a points list, each checked on its own with the rules of `devicesFromPointsList`, for the status
 * page: it shows every device with its mistake and adds the ones without. A
 * mistake in the list as a whole (its header, a row without a device) still fails. `overrides`, by the device's name
 * as the list writes it, give a device another id, host or address than the file does.
 */
export const checkPointsListByDevice = Effect.fn("checkPointsListByDevice")(function* (
  text: string,
  existing: ReadonlyArray<string> = [],
  profiles: ReadonlyMap<string, Profile> = new Map(),
  overrides: ReadonlyMap<string, DeviceOverride> = new Map()
) {
  const groups = yield* groupRows(text, profiles)
  const inConfig = new Set(existing)
  const listed = new Map<string, string>()
  return yield* Effect.forEach(groups, (group) => {
    const override = overrides.get(group.name)
    const id = override?.id?.trim()
    const rows = override === undefined ? group.rows : overriddenRows(group.rows, override)
    return Effect.map(
      checkedGroup(group, rows, inConfig, listed, id === undefined || id === "" ? group.name : id),
      (result): CheckedDevice => ({ name: group.name, lines: group.lines, result })
    )
  })
})
