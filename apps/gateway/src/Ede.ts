/**
 * BACnet EDE files (Engineering Data Exchange, the BIG-EU layout 2.x that most BACnet engineering tools export)
 * read as a points list. `import`, `init --points` and `points from-ede` recognise one by its `keyname` header row
 * and translate it into the standard list (PointsSchema.ts), which then goes through the same checks as one made
 * by hand.
 *
 * An EDE file starts with a few `PROJECT_NAME;…` lines, then a header row (`# keyname;device obj.-instance;
 * object-name;object-type;object-instance;…;unit-code;…`), then one row per object, separated by semicolons.
 * Columns are found by their names, so a tool that adds or reorders columns still reads. Rows of the device
 * objects (type 8) name the devices; objects that are not points (schedules, trend logs, notification classes,
 * files…) are skipped and counted. EDE has no device addresses, so devices are found by discovery. `settable`
 * makes nothing writable: writes are set in the config, on purpose.
 */
import { ObjectType, POINT_TYPES, qudtUnits } from "@ot-gateway/bacnet"
import { Effect } from "effect"
import { toCsv } from "./Csv.ts"
import { slugify } from "./Discover.ts"
import { parseDelimited, PointsListError } from "./PointsList.ts"

/** A header field as compared: letters and digits only, lower case (`# device obj.-instance` → `deviceobjinstance`). */
const headerKey = (field: string) => field.toLowerCase().replace(/[^a-z0-9]/g, "")

/** The line of the header row, the one that starts with `keyname`, or -1. */
const headerLine = (lines: ReadonlyArray<string>) =>
  lines.findIndex((line) => headerKey(line.split(/[;,\t]/, 1)[0] ?? "") === "keyname")

/** Whether `text` is an EDE file rather than a points list. */
export const isEde = (text: string) => headerLine(text.split(/\r?\n/)) >= 0

const typeNames = new Map<number, string>(Object.entries(ObjectType).map(([name, number]) => [number, name]))
const pointTypes = new Set<string>(POINT_TYPES)

/** An object type as EDE writes it, a number (usually) or a name, as its ASHRAE 135 name. */
const typeName = (field: string) => {
  const trimmed = field.trim()
  return /^\d+$/.test(trimmed) ? (typeNames.get(Number(trimmed)) ?? `type ${trimmed}`) : trimmed.toLowerCase()
}

export interface EdeTranslation {
  /** The objects as a points list, in the standard columns. */
  readonly list: string
  readonly devices: number
  readonly points: number
  /** Objects that are not points, by type, e.g. `{ schedule: 3, "trend-log": 12 }`. */
  readonly skipped: Readonly<Record<string, number>>
}

const fail = (message: string) => Effect.fail(new PointsListError({ message }))

/** `name`, or `name` with a suffix when its slug is taken already. */
const uniqueName = (taken: Set<string>, name: string, suffix: string) => {
  const chosen = taken.has(slugify(name)) || slugify(name) === "" ? `${name} ${suffix}`.trim() : name
  taken.add(slugify(chosen))
  return chosen
}

/** Translates an EDE file into a points list. Fails, naming the line, on a row it cannot read. */
export const edeToPointsList = Effect.fn("edeToPointsList")(function* (text: string) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/)
  const start = headerLine(lines)
  if (start < 0) return yield* fail("not an EDE file: no keyname header row")
  const headerText = lines[start] ?? ""
  // The header row decides the separator: the project lines above it may hold commas in a name.
  const delimiter = [";", "\t", ","].reduce((best, candidate) =>
    headerText.split(candidate).length > headerText.split(best).length ? candidate : best
  )
  const [header = [], ...records] = parseDelimited(lines.slice(start).join("\n"), delimiter)
  const columns = header.map(headerKey)
  const column = (name: string) => columns.indexOf(name)
  const at = {
    device: column("deviceobjinstance"),
    name: column("objectname"),
    type: column("objecttype"),
    instance: column("objectinstance"),
    unit: column("unitcode")
  }
  for (const [name, index] of Object.entries({
    "device obj.-instance": at.device,
    "object-name": at.name,
    "object-type": at.type,
    "object-instance": at.instance
  })) {
    if (index < 0) return yield* fail(`the EDE header has no ${name} column`)
  }

  interface EdeObject {
    readonly line: number
    readonly device: number
    readonly name: string
    readonly type: string
    readonly instance: number
    readonly unit: string | undefined
  }
  const objects: Array<EdeObject> = []
  for (const [index, fields] of records.entries()) {
    const line = start + index + 2
    if ((fields[0] ?? "").trim().startsWith("#")) continue
    const field = (position: number) => (fields[position] ?? "").trim()
    const device = Number(field(at.device))
    const instance = Number(field(at.instance))
    if (
      !Number.isInteger(device) ||
      !Number.isInteger(instance) ||
      field(at.device) === "" ||
      field(at.instance) === ""
    ) {
      return yield* fail(`EDE line ${line}: device obj.-instance and object-instance must be whole numbers`)
    }
    const unitCode = at.unit < 0 ? "" : field(at.unit)
    objects.push({
      line,
      device,
      name: field(at.name),
      type: typeName(field(at.type)),
      instance,
      unit: /^\d+$/.test(unitCode) ? qudtUnits.get(Number(unitCode)) : undefined
    })
  }

  // Device names from the device objects; a name two devices share gets each one's instance.
  const named = new Map(
    objects.filter((object) => object.type === "device").map((object) => [object.device, object.name])
  )
  const nameCount = new Map<string, number>()
  for (const name of named.values()) nameCount.set(slugify(name), (nameCount.get(slugify(name)) ?? 0) + 1)
  const deviceName = (instance: number) => {
    const name = named.get(instance) ?? ""
    return name === "" || slugify(name) === "" || (nameCount.get(slugify(name)) ?? 0) > 1
      ? `${name} device ${instance}`.trim()
      : name
  }

  const skipped: Record<string, number> = {}
  const pointNames = new Map<number, Set<string>>()
  const rows: Array<ReadonlyArray<string | number>> = []
  for (const object of objects) {
    if (object.type === "device") continue
    if (!pointTypes.has(object.type)) {
      skipped[object.type] = (skipped[object.type] ?? 0) + 1
      continue
    }
    const taken = pointNames.get(object.device) ?? new Set<string>()
    pointNames.set(object.device, taken)
    rows.push([
      deviceName(object.device),
      uniqueName(taken, object.name, `${object.type} ${object.instance}`),
      object.unit ?? "",
      object.device,
      object.type,
      object.instance
    ])
  }
  return {
    list: toCsv([["device", "point", "unit", "device_instance", "object_type", "object_instance"], ...rows]),
    devices: pointNames.size,
    points: rows.length,
    skipped
  } satisfies EdeTranslation
})

/** What a translation says on stderr: how much was read and what was left out. */
export const describeTranslation = (path: string, translation: EdeTranslation) => {
  const skipped = Object.entries(translation.skipped)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ")
  return `${path}: an EDE file, ${translation.points} point(s) of ${translation.devices} device(s)${skipped === "" ? "" : `; skipped what is not a point: ${skipped}`}`
}
