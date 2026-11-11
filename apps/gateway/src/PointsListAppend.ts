/**
 * Rows added to a points list that exists already (`discover --points-list <file> --append`), so that Modbus rows
 * written by hand and BACnet rows found by discovery end up in the one list `import` reads.
 *
 * The list is read as `import` reads it (PointsList.ts: commas, semicolons or tabs, any column order or case,
 * aliases). Its header and rows are kept as they are; columns it lacks are added at the end of the header in the
 * order given, and a row of the list that is shorter than the new header gets empty fields at its end, so every
 * row has the header's column count, as a spreadsheet saves it. New rows use the list's separator and line breaks.
 *
 * A row is already in the list when its device has a point of the same name (both as import slugs them), or when
 * its BACnet object (device instance, object type, object instance) is. Those are skipped and counted. A device
 * the list has under another name with the same device instance keeps the list's name; a new device whose name
 * the list uses for another device gets its device instance as a suffix, so import never merges two devices.
 */
import { objectTypeNumber } from "@ot-gateway/bacnet"
import { Result } from "effect"
import { csvLine, toCsv } from "./Csv.ts"
import { detectDelimiter, headerColumns, readDelimited } from "./PointsList.ts"
import { slugify } from "./Slug.ts"

/** U+FEFF, which spreadsheet exports put before the header; spelled out because the character is invisible. */
const byteOrderMark = String.fromCharCode(0xfeff)

export interface AppendedPointsList {
  /** The whole list, to write in place of the old one. */
  readonly text: string
  /** Rows added, and how many devices they belong to. */
  readonly added: number
  readonly devices: number
  /** Rows left out because the list has them already. */
  readonly skipped: number
}

/** A BACnet object as a key: object types by number, so `analog-input`, `Analog Input` and `0` are one. */
const objectKey = (deviceInstance: string, objectType: string, objectInstance: string) => {
  const name = objectType
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
  return `${Number(deviceInstance)}/${objectTypeNumber(name) ?? name}/${Number(objectInstance)}`
}

const pointKey = (device: string, point: string) => `${slugify(device)}/${slugify(point)}`

/**
 * Where the header ends in `text`: the line break after the first line with a field, outside quotes. Leading
 * empty lines and a byte order mark are part of it, so they are kept as they are.
 */
const headerEnd = (text: string, separator: string) => {
  let quoted = false
  let content = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? ""
    if (char === '"') {
      quoted = !quoted
      content = true
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (content) return index
    } else if (char !== separator && char !== byteOrderMark && char.trim() !== "") content = true
  }
  return text.length
}

/**
 * `body` (rows of a delimited text, after its header) with empty fields added at the end of each row that has fewer
 * than `width`, outside quotes and before the line break. Lines with no field in them are left as they are.
 */
export const padRows = (body: string, separator: string, width: number) => {
  let result = ""
  let quoted = false
  let fields = 1
  let content = false
  const pad = () => (content && fields < width ? separator.repeat(width - fields) : "")
  for (let index = 0; index < body.length; index++) {
    const char = body[index] ?? ""
    if (char === '"') {
      quoted = !quoted
      content = true
    } else if (!quoted && (char === "\n" || char === "\r")) {
      // \r\n is one line break: pad before its \r, and the \n that follows ends an empty record.
      result += pad()
      fields = 1
      content = false
    } else if (!quoted && char === separator) fields++
    else if (char.trim() !== "") content = true
    result += char
  }
  return result + pad()
}

/** How many devices `rows` hold, by the slug of the field at `deviceColumn`. */
const devicesOf = (rows: ReadonlyArray<ReadonlyArray<string>>, deviceColumn: number) =>
  new Set(rows.map((fields) => slugify(fields[deviceColumn] ?? ""))).size

/**
 * `rows` (fields in the order of `columns`, canonical points list column names) added to the points list `text`,
 * or why the text is not a list to add to. A list with nothing in it becomes one with `columns` as its header.
 */
export const appendToPointsList = (
  text: string,
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
): Result.Result<AppendedPointsList, string> => {
  const read = readDelimited(text)
  if (Result.isFailure(read)) return Result.fail(`line ${read.failure.line}: a quote opened here is never closed`)
  const [headerRecord, ...records] = read.success
  if (headerRecord === undefined) {
    return Result.succeed({
      text: toCsv([columns, ...rows]),
      added: rows.length,
      devices: devicesOf(rows, columns.indexOf("device")),
      skipped: 0
    })
  }
  const header = headerColumns(headerRecord.fields)
  if (!header.includes("device") || !header.includes("point")) {
    return Result.fail(
      `its header has no device and point columns (it has ${headerRecord.fields.join(", ")}); is it a points list?`
    )
  }
  const field = (fields: ReadonlyArray<string>, column: string) => fields[header.indexOf(column)]?.trim() ?? ""
  const given = (fields: ReadonlyArray<string>, column: string) => fields[columns.indexOf(column)]?.trim() ?? ""

  // What the list has: device names by slug, device instances, points by name and BACnet objects.
  const names = new Map<string, string>()
  const instances = new Map<string, string>()
  for (const fields of records.map((record) => record.fields)) {
    const device = field(fields, "device")
    const slug = slugify(device)
    if (slug === "") continue
    if (!names.has(slug)) names.set(slug, device)
    const instance = field(fields, "device_instance")
    if (instance !== "" && !instances.has(slug)) instances.set(slug, instance)
  }
  const byInstance = new Map<string, string>()
  for (const [slug, instance] of instances) {
    if (!byInstance.has(String(Number(instance)))) byInstance.set(String(Number(instance)), names.get(slug) ?? slug)
  }
  const points = new Set<string>()
  const objects = new Set<string>()
  for (const fields of records.map((record) => record.fields)) {
    const device = field(fields, "device")
    points.add(pointKey(device, field(fields, "point")))
    const instance = instances.get(slugify(device))
    const [objectType, objectInstance] = [field(fields, "object_type"), field(fields, "object_instance")]
    if (instance !== undefined && objectType !== "" && objectInstance !== "") {
      objects.add(objectKey(instance, objectType, objectInstance))
    }
  }

  // Each new device's name in the list, decided once per device.
  const renamed = new Map<string, string>()
  const nameFor = (device: string, instance: string) => {
    const known = renamed.get(device)
    if (known !== undefined) return known
    const listed = instance === "" ? undefined : byInstance.get(String(Number(instance)))
    let name = listed ?? device
    if (listed === undefined && names.has(slugify(device))) {
      name = `${device}-${instance}`
      for (let n = 2; names.has(slugify(name)); n++) name = `${device}-${instance}-${n}`
    }
    renamed.set(device, name)
    names.set(slugify(name), name)
    if (instance !== "") byInstance.set(String(Number(instance)), name)
    return name
  }

  const newColumns = columns.filter((column) => !header.includes(column))
  const target = [...header, ...newColumns]
  const added: Array<ReadonlyArray<string>> = []
  let skipped = 0
  for (const fields of rows) {
    const instance = given(fields, "device_instance")
    const device = nameFor(given(fields, "device"), instance)
    const point = pointKey(device, given(fields, "point"))
    const [objectType, objectInstance] = [given(fields, "object_type"), given(fields, "object_instance")]
    const object =
      instance !== "" && objectType !== "" && objectInstance !== ""
        ? objectKey(instance, objectType, objectInstance)
        : undefined
    if (points.has(point) || (object !== undefined && objects.has(object))) {
      skipped++
      continue
    }
    points.add(point)
    if (object !== undefined) objects.add(object)
    // Only the first column of a name gets the value; the reader refuses a known column named twice anyway.
    added.push(
      target.map((column, index) =>
        column === "device" ? device : target.indexOf(column) === index ? given(fields, column) : ""
      )
    )
  }
  if (added.length === 0) return Result.succeed({ text, added: 0, devices: 0, skipped })

  const separator = detectDelimiter(text.startsWith(byteOrderMark) ? text.slice(1) : text)
  const newline = text.includes("\r\n") ? "\r\n" : "\n"
  const end = headerEnd(text, separator)
  const headerText = text.slice(0, end) + (newColumns.length === 0 ? "" : separator + csvLine(newColumns, separator))
  const body = padRows(text.slice(end).replace(/[\r\n]+$/, ""), separator, target.length)
  const lines = added.map((fields) => csvLine(fields, separator))
  return Result.succeed({
    text: `${headerText}${body}${newline}${lines.join(newline)}${newline}`,
    added: added.length,
    devices: devicesOf(added, target.indexOf("device")),
    skipped
  })
}
