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
 *
 * `columns` picks who the list is for. `import` (the default) is the above. `all` is the same list for people
 * reading it: every column written, defaults too (the poll interval, the port, the unit id, the byte order), and
 * after the import columns the ones import does not read: `protocol`, `writable`, `min`, `max`, `priority` and the
 * point's MQTT `topic`. import ignores columns it does not read, so it reads an `all` list as the plain one.
 * `common` is every point of every protocol with only what they share (name, unit, protocol, writable, limits,
 * topic, publishing), no address, register or object: an overview, not a list to import.
 * `protocol` keeps only BACnet or Modbus devices.
 */
import {
  type BacnetDevice,
  type BacnetPoint,
  type Device,
  type GatewayConfig,
  isPresentValue,
  type ModbusDevice,
  type ModbusPoint,
  pointTopic,
  type Publish
} from "@ot-gateway/core"
import { Effect, FileSystem, Option, Schema } from "effect"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
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

/** Which devices an export keeps: the protocol as the CLI names it. */
export type ExportProtocol = "bacnet" | "modbus"

/** Who the list is for: import (the default), people (`all`), or an overview without protocol columns. */
export type ExportColumns = "import" | "all" | "common"

export const exportColumnChoices: ReadonlyArray<ExportColumns> = ["import", "all", "common"]

export interface ExportOptions {
  /** Only this protocol's devices (simulated ones are never in a list). */
  readonly protocol?: ExportProtocol | undefined
  readonly columns?: ExportColumns | undefined
}

/** The columns `all` adds after the import columns, in this order. import does not read them. */
export const detailColumns: ReadonlyArray<string> = ["protocol", "writable", "min", "max", "priority", "topic"]

/** The columns of `common`, in this order: what a point of any protocol has. */
export const commonColumnNames: ReadonlyArray<string> = [
  "device",
  "point",
  "name",
  "protocol",
  "unit",
  "writable",
  "min",
  "max",
  "topic",
  "interval_s",
  "publish",
  "publish_s",
  "deadband",
  "alarm"
]

const protocolOf: Readonly<Record<ExportProtocol, Device["protocol"]>> = {
  bacnet: "bacnet-ip",
  modbus: "modbus-tcp"
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
  notes: Array<NotCarried>,
  details: boolean
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
    ...(!details && point.name === readableName(point.id) ? {} : { name: point.name }),
    ...(point.unit === undefined ? {} : { unit: point.unit }),
    ...(!details && device.pollIntervalMs === DEFAULT_POLL_MS ? {} : { interval_s: seconds(device.pollIntervalMs) }),
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

/** The detail columns that every protocol has: the topic, and whether (and within what) it takes commands. */
const detailFields = (
  config: Pick<GatewayConfig, "site" | "building">,
  device: ModbusDevice | BacnetDevice,
  point: ModbusPoint | BacnetPoint
): Record<string, string | number> => ({
  protocol: device.protocol,
  writable: point.writable ? "yes" : "no",
  ...(point.limits === undefined ? {} : { min: point.limits.min, max: point.limits.max }),
  topic: pointTopic({ site: config.site, building: config.building, device: device.id, point: point.id })
})

/** How a device's rows are written: the notes they add to, and the config for the detail columns (undefined without). */
interface RowContext {
  readonly notes: Array<NotCarried>
  readonly details: Pick<GatewayConfig, "site" | "building"> | undefined
  /** Keep the points an importable list leaves out (a register's bit, another property): for `common`. */
  readonly everyPoint: boolean
}

const modbusRows = (device: ModbusDevice, { notes, details, everyPoint }: RowContext): ReadonlyArray<ExportRow> =>
  device.points.flatMap((point) => {
    if (point.bit !== undefined && !everyPoint) {
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
        ...commonColumns(device, point, notes, details !== undefined),
        host: device.host,
        ...(details === undefined && device.port === DEFAULT_MODBUS_PORT ? {} : { port: device.port }),
        ...(details === undefined && device.unitId === DEFAULT_UNIT_ID ? {} : { unit_id: device.unitId }),
        register: point.address,
        table: point.table,
        type: point.dataType,
        ...((point.table === "holding" || point.table === "input") &&
        (details !== undefined || point.byteOrder !== "ABCD")
          ? { byte_order: point.byteOrder }
          : {}),
        ...(details === undefined ? {} : detailFields(details, device, point))
      }
    ]
  })

const bacnetRows = (device: BacnetDevice, { notes, details, everyPoint }: RowContext): ReadonlyArray<ExportRow> =>
  device.points.flatMap((point) => {
    if (!isPresentValue(point) && !everyPoint) {
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
        ...commonColumns(device, point, notes, details !== undefined),
        device_instance: device.deviceInstance,
        ...(device.address === undefined ? {} : { address: device.address }),
        object_type: point.objectType,
        object_instance: point.instance,
        ...(details === undefined
          ? {}
          : { ...detailFields(details, device, point), ...(point.writable ? { priority: point.priority } : {}) })
      }
    ]
  })

const deviceRows = (device: Device, context: RowContext): ReadonlyArray<ExportRow> => {
  const { notes } = context
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
  return device.protocol === "modbus-tcp" ? modbusRows(device, context) : bacnetRows(device, context)
}

/**
 * The config's devices as a points list: its rows, its columns, and what it leaves out. With `protocol`, only that
 * protocol's devices; `columns` says which columns (see the top of this file).
 */
export const exportPointsList = (
  config: Pick<GatewayConfig, "devices" | "site" | "building">,
  options: ExportOptions = {}
): PointsExport => {
  const notes: Array<NotCarried> = []
  const view = options.columns ?? "import"
  const context: RowContext = {
    notes,
    details: view === "import" ? undefined : config,
    everyPoint: view === "common"
  }
  const wanted = options.protocol === undefined ? undefined : protocolOf[options.protocol]
  const devices = wanted === undefined ? config.devices : config.devices.filter((device) => device.protocol === wanted)
  const full = devices.flatMap((device) => deviceRows(device, context))
  const rows =
    view === "common"
      ? full.map((row): ExportRow =>
          Object.fromEntries(
            commonColumnNames.flatMap((column) => {
              const value = row[column]
              return value === undefined ? [] : [[column, value] as const]
            })
          )
        )
      : full
  const used = new Set(rows.flatMap((row) => Object.keys(row)))
  const order =
    view === "common" ? commonColumnNames : view === "all" ? [...readColumns, ...detailColumns] : readColumns
  return {
    columns: order.filter((column) => column === "device" || column === "point" || used.has(column)),
    rows,
    devices: new Set(rows.map((row) => row["device"])).size,
    // An overview is not for import: only what is not in it at all (simulated devices) is worth saying.
    notCarried: view === "common" ? notes.filter((note) => note.skipped) : notes
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

/** Why `points export --output` wrote nothing: `code` for scripts, `hint` for what to do next. */
export class PointsExportError extends Schema.TaggedError<PointsExportError>()("PointsExportError", {
  message: Schema.String,
  code: Schema.String,
  hint: Schema.String
}) {}

/** A path as a person or an agent types it: `~` is the home folder (no shell expands it in an MCP call). */
export const outputPath = (path: string, home = homedir()) =>
  resolve(path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path)

const failure = (code: string, message: string, hint: string) => new PointsExportError({ code, message, hint })

export interface WriteExportOptions {
  /** Write over a file that is there. */
  readonly force: boolean
  /**
   * The one folder of the host this process sees, when it runs in a container (the Docker wrapper mounts the
   * current folder and nothing else): a file anywhere else would be written into the container and thrown away.
   */
  readonly visibleFolder?: string | undefined
}

/**
 * The list written to `path` (`~/Downloads/bacnet-points.csv`): never over a file that is there unless `force` (the
 * file is created exclusively, so a file or a dangling link that appears meanwhile is not followed), never into a
 * folder that is not there, so a typo in the path is said instead of making folders, and in a container only into
 * the folder it shares with the host. Returns the absolute path and the bytes written.
 */
export const writeExport = Effect.fn("writeExport")(function* (
  path: string,
  text: string,
  options: WriteExportOptions
) {
  const fs = yield* FileSystem.FileSystem
  const absolute = outputPath(path)
  const folder = dirname(absolute)
  const inside = options.visibleFolder === undefined ? "" : relative(options.visibleFolder, absolute)
  if (options.visibleFolder !== undefined && (inside === "" || inside.startsWith("..") || isAbsolute(inside))) {
    return yield* failure(
      "output-outside-folder",
      `${path} is outside the folder this command sees: it runs in Docker, which shares only the current folder. Nothing was written.`,
      `name a file in the current folder (--output ${basename(absolute)}), then move it: mv ${basename(absolute)} ${folder}/`
    )
  }
  const stat = yield* fs.stat(folder).pipe(Effect.option)
  if (Option.isNone(stat) || stat.value.type !== "Directory") {
    return yield* failure(
      "output-folder-missing",
      `${folder} is not a folder that exists. Nothing was written.`,
      "name a folder that exists, such as ~/Downloads"
    )
  }
  yield* fs
    .writeFileString(absolute, text, { flag: options.force ? "w" : "wx" })
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          error.reason._tag === "AlreadyExists"
            ? failure(
                "output-exists",
                `${absolute} exists. Nothing was written.`,
                "add --force to write over it, or name another file"
              )
            : failure(
                "output-unwritable",
                `${absolute} cannot be written: ${error.message}`,
                "name a file in a folder you can write to, not a folder itself"
              )
        )
      )
    )
  return { path: absolute, bytes: Buffer.byteLength(text) }
})

/**
 * The folder a containerised CLI shares with the host: the current one, when this runs in Docker (the wrapper
 * mounts it and nothing else); undefined on the host, where every folder is the user's.
 */
export const visibleFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const inContainer = yield* fs.exists("/.dockerenv").pipe(Effect.orElseSucceed(() => false))
  return inContainer ? process.cwd() : undefined
})
