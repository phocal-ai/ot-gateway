/**
 * The points list's columns, the one description of the format: `ot-gateway points schema` prints it (as text or
 * JSON, for people and agents), `points template` starts a list from it, and `import` names the columns it does
 * not know instead of dropping them without a word. PointsList.ts reads the rows.
 *
 * The version changes only when a list that worked stops working or means something else; a new optional
 * column keeps it.
 */
import type { PointsListFormat } from "@ot-gateway/api"
import { ByteOrder, DataType } from "@ot-gateway/core"
import { toCsv } from "./Csv.ts"
import { columnAliases, columnName } from "./PointsList.ts"

export const pointsListVersion = 1

/** Which rows a column applies to: every row, or the rows of one protocol. */
export type ColumnScope = "any" | "modbus-tcp" | "bacnet-ip"

export interface PointsListColumn {
  readonly name: string
  readonly scope: ColumnScope
  /** Needed on every row of its scope, or only in the cases its description names. */
  readonly required: boolean
  readonly description: string
  readonly default?: string | number
  readonly values?: ReadonlyArray<string>
}

/** The columns in the order a template lists them. */
export const pointsListColumns: ReadonlyArray<PointsListColumn> = [
  {
    name: "device",
    scope: "any",
    required: true,
    description: "The device's name; rows with the same name are one device"
  },
  {
    name: "point",
    scope: "any",
    required: true,
    description:
      "The point's name, unique within its device; its id (the topic) is the name as a slug. A slug (active-power) is shown as a name (Active power) unless the name column gives one"
  },
  {
    name: "name",
    scope: "any",
    required: false,
    description: "The name shown on the status page and in $meta, when point is an id (active-power)"
  },
  { name: "unit", scope: "any", required: false, description: "kW, kWh, °C, %, … or a QUDT name such as unit:KiloW" },
  {
    name: "interval_s",
    scope: "any",
    required: false,
    default: 5,
    description: "Seconds between reads, the same on every row of a device"
  },
  {
    name: "publish",
    scope: "any",
    required: false,
    default: "sample",
    values: ["sample", "aggregate", "change"],
    description: "Send every read (sample), a window's aggregate, or a value when it changes"
  },
  {
    name: "publish_s",
    scope: "any",
    required: false,
    description:
      "Seconds per message: the latest value (sample) or the window (aggregate, required there; 900 is 15 minutes)"
  },
  {
    name: "deadband",
    scope: "any",
    required: false,
    description: "The smallest change worth sending, in the point's unit; with publish empty or change"
  },
  {
    name: "alarm",
    scope: "any",
    required: false,
    values: ["on", "off"],
    description:
      "The point is an alarm, active when its value is on (true, not 0: a trip flag) or off (false, 0: a normally-closed contact); empty for a point that is no alarm"
  },
  { name: "scale", scope: "any", required: false, description: "value = raw × scale + offset" },
  { name: "offset", scope: "any", required: false, description: "value = raw × scale + offset" },
  {
    name: "host",
    scope: "modbus-tcp",
    required: true,
    description: "The device's IP address or host name; a row with a host is Modbus TCP"
  },
  { name: "port", scope: "modbus-tcp", required: false, default: 502, description: "The TCP port" },
  { name: "unit_id", scope: "modbus-tcp", required: false, default: 1, description: "The Modbus unit (slave) id" },
  {
    name: "profile",
    scope: "modbus-tcp",
    required: false,
    description:
      "A device profile (ot-gateway profiles list) or a .json draft next to the list: the row takes register, table, type, byte_order, scale and unit from it, and point names one of its points or * for all"
  },
  {
    name: "register",
    scope: "modbus-tcp",
    required: true,
    description: "The 0-based address: a data sheet's 40101 is usually holding register 100 (not with a profile)"
  },
  {
    name: "table",
    scope: "modbus-tcp",
    required: false,
    default: "holding",
    values: ["holding", "input", "coil", "discrete"],
    description: "The register table"
  },
  {
    name: "type",
    scope: "modbus-tcp",
    required: false,
    values: DataType.literals,
    description: "How to read the register(s); required for holding and input, bool for coil and discrete"
  },
  {
    name: "byte_order",
    scope: "modbus-tcp",
    required: false,
    default: "ABCD",
    values: ByteOrder.literals,
    description: "Word and byte order of values wider than one register"
  },
  {
    name: "device_instance",
    scope: "bacnet-ip",
    required: true,
    description: "The BACnet device instance; a row with one is BACnet/IP"
  },
  {
    name: "address",
    scope: "bacnet-ip",
    required: false,
    description: "The device's fixed IP address (ip or ip:port), when discovery cannot find it"
  },
  {
    name: "object_type",
    scope: "bacnet-ip",
    required: true,
    description: "The object type by its ASHRAE 135 name (analog-input, binary-value, …) or number"
  },
  { name: "object_instance", scope: "bacnet-ip", required: true, description: "The object's instance number" }
]

/** What every list follows, beyond its columns. */
export const pointsListRules: ReadonlyArray<string> = [
  "CSV with a header row and one row per point; commas, semicolons or tabs, as the header line uses",
  'Or JSON: an array with one object per point, the columns as keys ([{"device": "Meter", "point": "Active power", "register": 100, …}]); numbers may be JSON numbers; points schema --json-schema prints its JSON Schema',
  "Column names in any order and case; spaces and - count as _; unknown columns are named and ignored",
  "A row with host is Modbus TCP, a row with device_instance is BACnet/IP; one list can hold both",
  "A decimal comma is read as a point; a value that contains the delimiter (1,5 in a comma-separated list) goes in double quotes",
  "A row with a profile takes its registers from the profile; its other columns (unit, scale, byte_order, publish) still win",
  "A BACnet EDE file (the semicolon CSV engineering tools export) is read as a list too; points from-ede shows it as one",
  "Nothing is made writable: writes are set in the config, on purpose"
]

/** The columns whose values are numbers: in the JSON form, a JSON number or text that reads as one. */
const numberColumns: ReadonlySet<string> = new Set([
  "interval_s",
  "publish_s",
  "deadband",
  "scale",
  "offset",
  "port",
  "unit_id",
  "register",
  "device_instance",
  "object_instance"
])

/**
 * The JSON form as a JSON Schema (draft 2020-12), as `points schema --json-schema` prints it, for an agent or an
 * editor to check a list against before `import`: an array of rows, `device` and `point` required, the allowed
 * values of each column, and unknown keys allowed (import names and ignores them). What depends on other columns
 * (a host or a device_instance, a type for holding registers) stays with `import --dry-run`, which says it by line.
 */
export const pointsListJsonSchema = () => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: `OT Gateway points list, version ${pointsListVersion}`,
  description:
    "One object per point. A row with host is Modbus TCP, one with device_instance BACnet/IP. Values are listed as written here; import also reads them in any case.",
  type: "array",
  items: {
    type: "object",
    required: pointsListColumns.filter((column) => column.scope === "any" && column.required).map(({ name }) => name),
    properties: Object.fromEntries(
      pointsListColumns.map((column) => [
        column.name,
        {
          description: `${column.scope === "any" ? "" : `${column.scope === "modbus-tcp" ? "Modbus TCP" : "BACnet/IP"}: `}${column.description}`,
          // null and "" are an empty cell, as import reads them.
          ...(column.values !== undefined
            ? { enum: [...column.values, "", null] }
            : numberColumns.has(column.name) || column.name === "object_type"
              ? { type: ["number", "string", "null"] }
              : { type: ["string", "null"] }),
          ...(column.default === undefined ? {} : { default: column.default })
        }
      ])
    ),
    additionalProperties: true
  }
})

/** The schema as `points schema --json` prints it. */
export const pointsListSchema = () => ({
  format: "ot-gateway points list",
  version: pointsListVersion,
  rules: pointsListRules,
  columns: pointsListColumns.map((column) => ({
    ...column,
    aliases: Object.entries(columnAliases)
      .filter(([, target]) => target === column.name)
      .map(([alias]) => alias)
  }))
})

/** A description's first sentence, for `--brief`: what the column is, without the cases and examples after it. */
export const firstSentence = (description: string) => description.split(/\.\s+(?=[A-Z])/)[0] ?? description

/**
 * The schema as `points schema --brief --json` prints it: each column's name, scope, whether it is required, its
 * first sentence, and its default and allowed values where it has them; no aliases, which `import` reads anyway.
 */
export const briefPointsListSchema = () => ({
  format: "ot-gateway points list",
  version: pointsListVersion,
  rules: pointsListRules,
  columns: pointsListColumns.map((column) => ({
    name: column.name,
    scope: column.scope,
    required: column.required,
    description: firstSentence(column.description),
    ...(column.default === undefined ? {} : { default: column.default }),
    ...(column.values === undefined ? {} : { values: column.values })
  }))
})

/** The brief schema as JSON text, one column per line, so it reads in a few dozen lines instead of a few hundred. */
export const briefPointsListSchemaJson = () => {
  const { columns, ...head } = briefPointsListSchema()
  const headLines = JSON.stringify(head, null, 2).split("\n").slice(1, -1)
  const columnLines = columns.map(
    (column, index) => `    ${JSON.stringify(column)}${index < columns.length - 1 ? "," : ""}`
  )
  return [
    "{",
    ...headLines.map((line, index) => (index === headLines.length - 1 ? `${line},` : line)),
    '  "columns": [',
    ...columnLines,
    "  ]",
    "}"
  ].join("\n")
}

const scopes: ReadonlyArray<ColumnScope> = ["any", "modbus-tcp", "bacnet-ip"]

const scopeTitles: Record<ColumnScope, string> = {
  any: "Every row",
  "modbus-tcp": "Modbus TCP rows",
  "bacnet-ip": "BACnet/IP rows"
}

/** The schema as `points schema` prints it, for people; `brief` keeps each description's first sentence. */
export const describePointsListSchema = (options: { readonly brief?: boolean } = {}) => {
  const width = Math.max(...pointsListColumns.map((column) => column.name.length)) + 2
  const sections = scopes.map((scope) => [
    `${scopeTitles[scope]}:`,
    ...pointsListColumns
      .filter((column) => column.scope === scope)
      .map((column) => {
        const notes = [
          column.required ? "required" : undefined,
          column.default === undefined ? undefined : `default ${column.default}`,
          column.values === undefined ? undefined : column.values.join(" | ")
        ].filter((note) => note !== undefined)
        const description = options.brief === true ? firstSentence(column.description) : column.description
        return `  ${column.name.padEnd(width)}${description}${notes.length === 0 ? "" : ` (${notes.join("; ")})`}`
      })
  ])
  return [
    `ot-gateway points list, version ${pointsListVersion}`,
    "",
    ...pointsListRules.map((rule) => `- ${rule}`),
    "",
    ...sections.flatMap((lines) => [...lines, ""]),
    "ot-gateway points template > points.csv starts one; ot-gateway import points.csv --dry-run checks it."
  ].join("\n")
}

/** Meters on Modbus TCP and a heat pump on BACnet/IP: what `points template` fills in under the header. */
const templateRows: ReadonlyArray<Readonly<Record<string, string>>> = [
  {
    device: "Energy meter",
    point: "Active power",
    unit: "kW",
    interval_s: "5",
    deadband: "0.1",
    host: "192.168.1.50",
    unit_id: "1",
    register: "100",
    type: "float32",
    byte_order: "CDAB"
  },
  {
    device: "Energy meter",
    point: "Energy",
    unit: "kWh",
    interval_s: "5",
    publish: "aggregate",
    publish_s: "900",
    host: "192.168.1.50",
    unit_id: "1",
    register: "102",
    type: "uint32",
    byte_order: "CDAB",
    scale: "0.1"
  },
  {
    device: "Sub meter",
    point: "*",
    interval_s: "15",
    host: "192.168.1.60",
    unit_id: "2",
    profile: "eastron-sdm630"
  },
  {
    device: "Heat pump",
    point: "Flow temperature",
    unit: "°C",
    interval_s: "30",
    deadband: "0.2",
    device_instance: "2001",
    object_type: "analog-input",
    object_instance: "1"
  },
  {
    device: "Heat pump",
    point: "Compressor running",
    interval_s: "30",
    publish: "change",
    device_instance: "2001",
    object_type: "binary-input",
    object_instance: "4"
  }
]

/** The protocols a template can be narrowed to, as `points template --protocol` names them. */
export const templateProtocols = { modbus: "modbus-tcp", bacnet: "bacnet-ip" } as const
export type TemplateProtocol = keyof typeof templateProtocols

/** The protocol of a template row, by the reader's rule: a host is Modbus TCP, a device_instance is BACnet/IP. */
const rowScope = (row: Readonly<Record<string, string>>): ColumnScope =>
  row["host"] !== undefined ? "modbus-tcp" : row["device_instance"] !== undefined ? "bacnet-ip" : "any"

/**
 * A points list with a few example rows, to fill in: every column and both protocols, or with a protocol only its
 * rows and the columns they can use. Either way it is the one format: import takes one list after the other.
 */
export const pointsListTemplate = (protocol?: TemplateProtocol) => {
  const scope = protocol === undefined ? undefined : templateProtocols[protocol]
  const names = pointsListColumns
    .filter((column) => scope === undefined || column.scope === "any" || column.scope === scope)
    .map((column) => column.name)
  const rows = templateRows.filter((row) => scope === undefined || rowScope(row) === scope)
  return toCsv([names, ...rows.map((row) => names.map((name) => row[name] ?? ""))])
}

/** The format for the status page (`GET /api/points/format`): the template and the columns, without aliases. */
export const pointsListFormat = (): PointsListFormat => ({
  version: pointsListVersion,
  template: pointsListTemplate(),
  templates: { modbus: pointsListTemplate("modbus"), bacnet: pointsListTemplate("bacnet") },
  rules: pointsListRules,
  columns: pointsListColumns
})

/** The columns of a header the format does not know, as written. */
export const unknownColumns = (header: ReadonlyArray<string>) => {
  const known = new Set(pointsListColumns.map((column) => column.name))
  return header.filter((name) => name.trim() !== "" && !known.has(columnName(name)))
}
