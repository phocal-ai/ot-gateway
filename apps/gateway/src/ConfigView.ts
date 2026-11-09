/**
 * `/api/config`: the running config for the Settings tab, as the file has it with every default filled in, and
 * without the points (the Points tab lists those); a device's publish mode is in words ("every read"). Built once;
 * the config does not change while the gateway runs.
 */
import type { ConfigEntry, ConfigView } from "@ot-gateway/api"
import { everyRead, GatewayConfig } from "@ot-gateway/core"
import { Schema } from "effect"
import { publishLabel } from "./PointCatalog.ts"

const encodeConfig = Schema.encodeSync(GatewayConfig)
/** The encoded config is plain JSON (it came from a JSON file); this says so to the type system. */
const asJson = Schema.decodeUnknownSync(Schema.Json)

const isObject = (value: Schema.Json): value is { readonly [key: string]: Schema.Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const entriesOf = (object: { readonly [key: string]: Schema.Json }, skip: ReadonlyArray<string> = []) =>
  Object.entries(object)
    .filter(([key]) => !skip.includes(key))
    .map(([key, value]): ConfigEntry => ({ key, value }))

export const configView = (config: GatewayConfig): ConfigView => {
  const encoded = asJson(encodeConfig(config))
  if (!isObject(encoded)) return { sections: [], devices: [] }
  const usesBacnet = config.devices.some((device) => device.protocol === "bacnet-ip")
  const top = Object.entries(encoded)
  const sections = [
    { key: "gateway", entries: top.filter(([, value]) => !isObject(value) && !Array.isArray(value)) },
    ...top
      .filter(([key, value]) => isObject(value) && (key !== "bacnet" || usesBacnet))
      .map(([key, value]) => ({ key, entries: isObject(value) ? Object.entries(value) : [] }))
  ].map((section) => ({
    key: section.key,
    entries: section.entries.map(([key, value]): ConfigEntry => ({ key, value }))
  }))
  const devices = config.devices.map((device, index) => {
    const raw = Array.isArray(encoded["devices"]) ? encoded["devices"][index] : undefined
    return {
      id: device.id,
      protocol: device.protocol,
      pointCount: device.points.length,
      // The publish mode in words, as the Points tab shows it, and the default spelled out when the file has none.
      entries: [
        ...(raw !== undefined && isObject(raw) ? entriesOf(raw, ["id", "protocol", "points", "publish"]) : []),
        { key: "publish", value: publishLabel(device.publish ?? everyRead) }
      ]
    }
  })
  return { sections, devices }
}
