/**
 * The lists beside the points list (`points export`, PointsExport.ts), each one row per thing, CSV or JSON, written
 * the same way (`writeExport`) and with no live values in them:
 *
 * - `devices export`: the config's devices, one row each: protocol, where it is, how often it is read, how many
 *   points it has and how many take commands, and the topics its values arrive on.
 * - `topics export`: the config's topic map, one row per MQTT topic the gateway publishes or listens on: the health
 *   topic, and for each point its value, `$meta` and, when it is writable, `$set` and `$set/result` (a command to a
 *   read-only point is answered on `$set/result` too, with a rejection: the map lists the topics that take commands). Each row says
 *   which message of the contract it carries, its direction, retain flag and QoS (from `contractTopics`), and for a
 *   point's topics its device, point, name, unit, whether the value is a number or a boolean, and how it publishes.
 * - `gateways export`: the gateways a broker keeps health of (Fleet.ts), one row each: where, online or offline,
 *   its contract, since when it runs, its last heartbeat and its devices by status.
 */
import {
  bacnetValueKind,
  contractTopics,
  type ContractMessage,
  type Device,
  type GatewayConfig,
  healthTopic,
  isPresentValue,
  metaTopic,
  pointTopic,
  publishOf
} from "@ot-gateway/core"
import type { FleetGateway } from "./Fleet.ts"
import type { ExportRow } from "./PointsExport.ts"

/** A list as the exports write it: its columns in order, and its rows with the columns they have a value in. */
export interface ExportList {
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<ExportRow>
}

/** The columns of `order` that some row has, `always` kept even when none has. */
const listOf = (order: ReadonlyArray<string>, rows: ReadonlyArray<ExportRow>, always: ReadonlyArray<string>) => {
  const used = new Set(rows.flatMap((row) => Object.keys(row)))
  return { columns: order.filter((column) => always.includes(column) || used.has(column)), rows }
}

const seconds = (ms: number) => ms / 1000

// ---------------------------------------------------------------------------------------------------------------
// Devices

export const deviceColumns: ReadonlyArray<string> = [
  "device",
  "protocol",
  "host",
  "port",
  "unit_id",
  "device_instance",
  "address",
  "cov",
  "interval_s",
  "publish",
  "points",
  "writable",
  "topics"
]

/** Where a device is, in the points list's column names. */
const whereColumns = (device: Device): Record<string, string | number> => {
  switch (device.protocol) {
    case "modbus-tcp":
      return { host: device.host, port: device.port, unit_id: device.unitId }
    case "bacnet-ip":
      return {
        device_instance: device.deviceInstance,
        ...(device.address === undefined ? {} : { address: device.address }),
        cov: device.cov ? "yes" : "no"
      }
    case "simulator":
      return {}
  }
}

/** The config's devices, one row each, in the config's order. */
export const exportDevices = (config: Pick<GatewayConfig, "site" | "building" | "devices">): ExportList =>
  listOf(
    deviceColumns,
    config.devices.map((device): ExportRow => ({
      device: device.id,
      protocol: device.protocol,
      ...whereColumns(device),
      interval_s: seconds(device.pollIntervalMs),
      publish: (device.publish ?? { mode: "sample" }).mode,
      points: device.points.length,
      writable: device.points.filter((point) => point.writable).length,
      topics: pointTopic({ site: config.site, building: config.building, device: device.id, point: "+" })
    })),
    ["device", "protocol"]
  )

// ---------------------------------------------------------------------------------------------------------------
// Topics

export const topicColumns: ReadonlyArray<string> = [
  "topic",
  "message",
  "direction",
  "retained",
  "qos",
  "device",
  "point",
  "name",
  "unit",
  "value",
  "writable",
  "publish"
]

/** The contract's columns for a message: who sends it, retained or not, its QoS. */
const contractColumns = (message: ContractMessage): Record<string, string | number> => {
  const topic = contractTopics.find((entry) => entry.message === message)
  return topic === undefined
    ? {}
    : { message, direction: topic.direction, retained: topic.retained ? "yes" : "no", qos: topic.qos }
}

/**
 * What a point's value is on the wire: true or false, or a number. Undefined for a BACnet property other than the
 * present value, which the device's answer types (a BOOLEAN such as out-of-service is published as true or false).
 */
export const valueKind = (device: Device, point: Device["points"][number]): "boolean" | "number" | undefined => {
  if (device.protocol === "modbus-tcp" && "dataType" in point) {
    return point.dataType === "bool" || point.table === "coil" || point.table === "discrete" ? "boolean" : "number"
  }
  if (device.protocol === "bacnet-ip" && "objectType" in point) {
    if (!isPresentValue(point)) return undefined
    return bacnetValueKind(point) === "binary" ? "boolean" : "number"
  }
  return "number"
}

/**
 * The config's topics, one row each: its health topic first, then each device's points in the config's order, each
 * with its value and `$meta` topic, and its `$set` and `$set/result` topic when it takes commands.
 */
export const exportTopics = (config: Pick<GatewayConfig, "site" | "building" | "id" | "devices">): ExportList => {
  const health: ExportRow = {
    topic: healthTopic(config.site, config.building, config.id),
    ...contractColumns("health"),
    name: `Health of gateway ${config.id}`
  }
  const points = config.devices.flatMap((device) =>
    device.points.flatMap((point): ReadonlyArray<ExportRow> => {
      const parts = { site: config.site, building: config.building, device: device.id, point: point.id }
      const value = pointTopic(parts)
      const kind = valueKind(device, point)
      const about = {
        device: device.id,
        point: point.id,
        name: point.name,
        ...(point.unit === undefined ? {} : { unit: point.unit }),
        ...(kind === undefined ? {} : { value: kind }),
        writable: point.writable ? "yes" : "no",
        publish: publishOf(device.publish, point).mode
      }
      return [
        { topic: value, ...contractColumns("value"), ...about },
        { topic: metaTopic(parts), ...contractColumns("meta"), ...about },
        ...(point.writable
          ? [
              { topic: `${value}/$set`, ...contractColumns("command"), ...about },
              { topic: `${value}/$set/result`, ...contractColumns("command-result"), ...about }
            ]
          : [])
      ]
    })
  )
  return listOf(topicColumns, [health, ...points], ["topic", "message"])
}

// ---------------------------------------------------------------------------------------------------------------
// Gateways

export const gatewayColumns: ReadonlyArray<string> = [
  "gateway",
  "site",
  "building",
  "id",
  "status",
  "reason",
  "contract",
  "since",
  "heartbeat",
  "devices",
  "ok",
  "failing",
  "starting",
  "health_topic"
]

/** A time from the broker as ISO 8601, or undefined when there is none or it is past what a Date holds. */
const isoTime = (ms: number | undefined) => {
  if (ms === undefined) return undefined
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** The gateways a broker keeps health of, one row each, by name. Times are ISO 8601 in UTC. */
export const exportGateways = (gateways: ReadonlyArray<FleetGateway>): ExportList =>
  listOf(
    gatewayColumns,
    gateways.map((gateway): ExportRow => {
      const inState = (status: FleetGateway["devices"][number]["status"]) =>
        gateway.devices.filter((device) => device.status === status).length
      const since = isoTime(gateway.since)
      const heartbeat = isoTime(gateway.ts)
      return {
        gateway: gateway.name,
        site: gateway.site,
        building: gateway.building,
        id: gateway.id,
        status: gateway.status,
        ...(gateway.reason === undefined ? {} : { reason: gateway.reason }),
        ...(gateway.contract === undefined ? {} : { contract: gateway.contract }),
        ...(since === undefined ? {} : { since }),
        ...(heartbeat === undefined ? {} : { heartbeat }),
        ...(gateway.status === "online"
          ? {
              devices: gateway.devices.length,
              ok: inState("ok"),
              failing: inState("failing"),
              starting: inState("starting")
            }
          : {}),
        health_topic: healthTopic(gateway.site, gateway.building, gateway.id)
      }
    }),
    ["gateway", "status"]
  )

/**
 * A list for a spreadsheet whose text came from the broker, where any client can publish: a field that starts with
 * `=`, `+`, `-`, `@`, a tab or a carriage return would be read as a formula, so it gets a leading `'` (OWASP, CSV
 * injection). Numbers stay numbers. For the CSV only; the JSON keeps the text as it came.
 */
export const spreadsheetSafe = (list: ExportList): ExportList => ({
  columns: list.columns,
  rows: list.rows.map((row): ExportRow =>
    Object.fromEntries(
      Object.entries(row).map(([column, value]) => [
        column,
        typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
      ])
    )
  )
})
