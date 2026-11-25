/**
 * The upload panel's logic, apart from its looks: the changes a person makes to an uploaded list's devices before
 * adding them (another id, host or address; the file itself is not changed), the gateway's words about a device put
 * in the page's, and the template as a file to download.
 */
import type { ImportDevice, ImportRename, PointsListColumn } from "@ot-gateway/api"

/** What a person typed for one device of the list: empty fields keep what the file says. */
export interface DeviceChange {
  readonly id: string
  /** The host of a Modbus TCP device, or the address (ip or ip:port) of a BACnet/IP one. */
  readonly where: string
}

/** Changes by the device's name as the list writes it (the check's `name`). */
export type DeviceChanges = Readonly<Record<string, DeviceChange>>

/** What the change form starts with for `device`: empty, so leaving a field alone keeps the file's value. */
export const emptyChange: DeviceChange = { id: "", where: "" }

/** The changes as the gateway takes them: only devices with something typed, host or address by protocol. */
export const renamesOf = (
  changes: DeviceChanges,
  devices: ReadonlyArray<Pick<ImportDevice, "name" | "protocol">>
): ReadonlyArray<ImportRename> =>
  devices.flatMap((device) => {
    const change = changes[device.name]
    if (change === undefined) return []
    const id = change.id.trim()
    const where = change.where.trim()
    if (id === "" && where === "") return []
    const place = where === "" ? {} : device.protocol === "bacnet-ip" ? { address: where } : { host: where }
    return [{ name: device.name, ...(id === "" ? {} : { id }), ...place }]
  })

/** What the field for a device's place is called: a host for Modbus TCP, an address for BACnet/IP. */
export const whereLabel = (protocol: ImportDevice["protocol"]) => (protocol === "bacnet-ip" ? "Address" : "Host")

/**
 * A device's mistake in the page's words. The gateway's text is the command line's (it names "the config"); on the
 * page, the devices are on this gateway, and the fix is the change form.
 */
export const pageError = (error: string) =>
  error.replace(
    /^device id "([^"]+)" is already in the config$/,
    'A device with the id "$1" is already on this gateway: give this one another id with Change id or host.'
  )

/** The template as a link a browser downloads as a file: a `data:` URL, so it needs no server of its own. */
export const templateHref = (template: string) => `data:text/csv;charset=utf-8,${encodeURIComponent(template)}`

/** Which rows a column applies to, in words. */
export const scopeLabel: Readonly<Record<PointsListColumn["scope"], string>> = {
  any: "Every row",
  "modbus-tcp": "Modbus TCP rows",
  "bacnet-ip": "BACnet/IP rows"
}

/** A column's notes: required, its default and its values. */
export const columnNotes = (column: PointsListColumn) =>
  [
    column.required ? "required" : undefined,
    column.default === undefined ? undefined : `default ${column.default}`,
    column.values === undefined ? undefined : column.values.join(", ")
  ].filter((note) => note !== undefined)
