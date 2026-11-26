/**
 * A config's devices as a points list again (`ot-gateway points export`), the reverse of `import`: one row per
 * point, the same columns (PointsSchema.ts), so a config changed on the status page or by hand goes back to the
 * spreadsheet it started from instead of drifting away from it. `import` of the list gives the same devices.
 *
 * A points list says less than a config, by design: nothing in it is writable, and it has no columns for semantics,
 * a register's bit, a BACnet property other than the present value, or the settings a device rarely needs
 * (`requestGapMs`, `cov`, …). What the list cannot carry is named, device and point, so nobody re-imports a list
 * and loses a writable setpoint without being told. A point the list would describe wrongly (a bit of a register
 * read as the whole register) is left out rather than exported as something else.
 */
import {
  type BacnetDevice,
  type BacnetPoint,
  type Device,
  type GatewayConfig,
  isPresentValue,
  type ModbusDevice,
  type ModbusPoint,
  type Publish
} from "@ot-gateway/core"
import { csvLine } from "./Csv.ts"
import { qudtUnit, readableName, readColumns } from "./PointsList.ts"
import { slugify } from "./Slug.ts"

/** One row of the list, as the JSON form has it: the columns that have a value, numbers as numbers. */
export type ExportRow = Readonly<Record<string, string | number>>

/** Why a part of the config is not in the list, in one key per kind, so `--json` readers can group them. */
export type NotCarriedKind =
  | "simulator"
  | "bit"
  | "property"
  | "writable"
  | "limits"
  | "semantics"
  | "max-silence"
  | "priority"
  | "device-publish"
  | "device-setting"
  | "unit"
  | "id"

/**
 * What the list leaves out or says differently: on `device`, or on its `point`. `skipped`: the point (or the
 * device) is not in the list at all; otherwise its row is, without what `detail` names.
 */
export interface NotCarried {
  readonly kind: NotCarriedKind
  readonly device: string
  readonly point?: string
  readonly detail: string
  readonly skipped: boolean
}

export interface PointsExport {
  /** The columns in the list's order: `device` and `point` first, then every column a row has a value in. */
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<ExportRow>
  readonly devices: number
  readonly notCarried: ReadonlyArray<NotCarried>
}

const DEFAULT_POLL_MS = 5_000
const DEFAULT_MODBUS_PORT = 502
const DEFAULT_UNIT_ID = 1
const DEFAULT_PRIORITY = 8

/** Seconds as the list writes them: `interval_s` 5, `publish_s` 900, `0.5` for half a second. */
const seconds = (ms: number) => ms / 1000

/** A publish mode as the list's `publish`, `publish_s` and `deadband` columns. */
const publishColumns = (publish: Publish): Record<string, string | number> => {
  switch (publish.mode) {
    case "sample":
      return publish.intervalMs === undefined
        ? { publish: "sample" }
        : { publish: "sample", publish_s: seconds(publish.intervalMs) }
    case "aggregate":
      return { publish: "aggregate", publish_s: seconds(publish.intervalMs) }
    case "change":
      return publish.deadband === undefined ? { publish: "change" } : { publish: "change", deadband: publish.deadband }
  }
}

/** The columns every point has, whatever its protocol. */
const commonColumns = (
  device: ModbusDevice | BacnetDevice,
  point: ModbusPoint | BacnetPoint,
  notes: Array<NotCarried>
): Record<string, string | number> => {
  const at = { device: device.id, point: point.id, skipped: false }
  if (point.writable) {
    notes.push({
      ...at,
      kind: "writable",
      detail: `writable${point.limits === undefined ? "" : ` (${point.limits.min} to ${point.limits.max})`}`
    })
  } else if (point.limits !== undefined) {
    notes.push({ ...at, kind: "limits", detail: `limits ${point.limits.min} to ${point.limits.max}` })
  }
  if (point.unit !== undefined && qudtUnit(point.unit) !== point.unit) {
    notes.push({ ...at, kind: "unit", detail: `${point.unit} imports as ${qudtUnit(point.unit)}` })
  }
  if (point.semantics !== undefined) notes.push({ ...at, kind: "semantics", detail: "semantics (brick, haystack)" })
  if (slugify(point.id) !== point.id) {
    notes.push({ ...at, kind: "id", detail: `the id ${point.id} reads back as ${slugify(point.id)}` })
  }
  // The point's own mode, its deadband (the short form), or its device's mode written on each of its rows.
  const own =
    point.publish ?? (point.deadband === undefined ? undefined : { mode: "change" as const, deadband: point.deadband })
  const publish = own ?? device.publish
  if (publish?.mode === "change" && publish.maxSilenceMs !== undefined) {
    notes.push({ ...at, kind: "max-silence", detail: `maxSilenceMs ${publish.maxSilenceMs}` })
  }
  const factor = point.scaling?.factor ?? 1
  const offset = point.scaling?.offset ?? 0
  return {
    device: device.id,
    point: point.id,
    ...(point.name === readableName(point.id) ? {} : { name: point.name }),
    ...(point.unit === undefined ? {} : { unit: point.unit }),
    ...(device.pollIntervalMs === DEFAULT_POLL_MS ? {} : { interval_s: seconds(device.pollIntervalMs) }),
    ...(publish === undefined
      ? {}
      : point.publish === undefined && point.deadband !== undefined
        ? { deadband: point.deadband }
        : publishColumns(publish)),
    ...(point.alarmWhen === undefined ? {} : { alarm: point.alarmWhen }),
    ...(factor === 1 ? {} : { scale: factor }),
    ...(offset === 0 ? {} : { offset })
  }
}

/** The device settings a list has no column for, when they are not the defaults. */
const deviceSettings = (device: ModbusDevice | BacnetDevice): ReadonlyArray<string> => [
  ...(device.cycleTimeoutMs === undefined ? [] : [`cycleTimeoutMs ${device.cycleTimeoutMs}`]),
  ...(device.protocol === "modbus-tcp"
    ? [
        ...(device.requestGapMs === 0 ? [] : [`requestGapMs ${device.requestGapMs}`]),
        ...(device.maxRegistersPerRead === 125 ? [] : [`maxRegistersPerRead ${device.maxRegistersPerRead}`]),
        ...(device.maxBitsPerRead === 2000 ? [] : [`maxBitsPerRead ${device.maxBitsPerRead}`])
      ]
    : device.cov
      ? []
      : ["cov false"])
]

const modbusRows = (device: ModbusDevice, notes: Array<NotCarried>): ReadonlyArray<ExportRow> =>
  device.points.flatMap((point) => {
    if (point.bit !== undefined) {
      // Without a bit column, the row would read the whole register as one bool: a different point.
      notes.push({
        kind: "bit",
        device: device.id,
        point: point.id,
        detail: `bit ${point.bit} of ${point.table} ${point.address}`,
        skipped: true
      })
      return []
    }
    return [
      {
        ...commonColumns(device, point, notes),
        host: device.host,
        ...(device.port === DEFAULT_MODBUS_PORT ? {} : { port: device.port }),
        ...(device.unitId === DEFAULT_UNIT_ID ? {} : { unit_id: device.unitId }),
        register: point.address,
        table: point.table,
        type: point.dataType,
        ...((point.table === "holding" || point.table === "input") && point.byteOrder !== "ABCD"
          ? { byte_order: point.byteOrder }
          : {})
      }
    ]
  })

const bacnetRows = (device: BacnetDevice, notes: Array<NotCarried>): ReadonlyArray<ExportRow> =>
  device.points.flatMap((point) => {
    if (!isPresentValue(point)) {
      // Without a property column, the row would read the present value: a different point.
      notes.push({
        kind: "property",
        device: device.id,
        point: point.id,
        detail: `property ${point.property} of ${point.objectType} ${point.instance}`,
        skipped: true
      })
      return []
    }
    // The priority is the slot writes use: of a point that takes none, it says nothing.
    if (point.writable && point.priority !== DEFAULT_PRIORITY) {
      notes.push({
        kind: "priority",
        device: device.id,
        point: point.id,
        detail: `write priority ${point.priority}`,
        skipped: false
      })
    }
    return [
      {
        ...commonColumns(device, point, notes),
        device_instance: device.deviceInstance,
        ...(device.address === undefined ? {} : { address: device.address }),
        object_type: point.objectType,
        object_instance: point.instance
      }
    ]
  })

const deviceRows = (device: Device, notes: Array<NotCarried>): ReadonlyArray<ExportRow> => {
  if (device.protocol === "simulator") {
    notes.push({ kind: "simulator", device: device.id, detail: "a simulated device", skipped: true })
    return []
  }
  if (slugify(device.id) !== device.id) {
    notes.push({
      kind: "id",
      device: device.id,
      detail: `the id ${device.id} reads back as ${slugify(device.id)}`,
      skipped: false
    })
  }
  const settings = deviceSettings(device)
  if (settings.length > 0) {
    notes.push({ kind: "device-setting", device: device.id, detail: settings.join(", "), skipped: false })
  }
  if (device.publish !== undefined) {
    notes.push({
      kind: "device-publish",
      device: device.id,
      detail: "its publish mode, written on each of its points instead",
      skipped: false
    })
  }
  return device.protocol === "modbus-tcp" ? modbusRows(device, notes) : bacnetRows(device, notes)
}

/** The config's devices as a points list: its rows, its columns, and what it leaves out. */
export const exportPointsList = (config: Pick<GatewayConfig, "devices">): PointsExport => {
  const notes: Array<NotCarried> = []
  const rows = config.devices.flatMap((device) => deviceRows(device, notes))
  const used = new Set(rows.flatMap((row) => Object.keys(row)))
  return {
    columns: readColumns.filter((column) => column === "device" || column === "point" || used.has(column)),
    rows,
    devices: new Set(rows.map((row) => row["device"])).size,
    notCarried: notes
  }
}

/** The list as CSV, the header first: what `import` and a spreadsheet read. */
export const exportCsv = (list: Pick<PointsExport, "columns" | "rows">) =>
  `${[list.columns, ...list.rows.map((row) => list.columns.map((column) => row[column] ?? ""))]
    .map((fields) => csvLine(fields))
    .join("\n")}\n`

/** The list in its JSON form: an array of rows, each with the columns it has a value in. */
export const exportJson = (list: Pick<PointsExport, "rows">) => `${JSON.stringify(list.rows, null, 2)}\n`

/** What each kind of note means for the list, in one sentence, after the points it names. */
const kindText: Readonly<Record<NotCarriedKind, string>> = {
  simulator: "simulated devices have no points list columns; left out",
  bit: "a bit of a register has no column; left out, as the row would read the whole register",
  property: "a property other than present-value has no column; left out, as the row would read the present value",
  writable: "import never makes a point writable: set writable and limits in the config again",
  limits: "limits have no column",
  semantics: "semantics have no column",
  "max-silence": "maxSilenceMs has no column",
  priority: "the write priority has no column",
  "device-publish": "a device's publish mode is written on each of its points",
  "device-setting": "these device settings have no column",
  unit: "import writes these units as QUDT names; put the QUDT name in the config to keep them alike",
  id: "an id that is not one slugify keeps imports under another id"
}

const listed = (names: ReadonlyArray<string>, most = 4) =>
  names.length <= most ? names.join(", ") : `${names.slice(0, most).join(", ")} and ${names.length - most} more`

/** The notes for people: one line per kind, the points (or devices) it names, and what that means. */
export const describeNotCarried = (notes: ReadonlyArray<NotCarried>): ReadonlyArray<string> => {
  const kinds = [...new Set(notes.map((note) => note.kind))]
  return kinds.map((kind) => {
    const named = notes
      .filter((note) => note.kind === kind)
      .map((note) =>
        kind === "writable" || kind === "bit" || kind === "property" || kind === "device-setting" || kind === "unit"
          ? `${note.point === undefined ? note.device : `${note.device}/${note.point}`} ${note.detail.replace(/^writable ?/, "")}`.trim()
          : note.point === undefined
            ? note.device
            : `${note.device}/${note.point}`
      )
    const mark = notes.some((note) => note.kind === kind && note.skipped) ? "✗" : "!"
    return `${mark} ${kindText[kind]}: ${listed(named)}`
  })
}
