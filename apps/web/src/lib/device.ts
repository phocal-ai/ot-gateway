/**
 * Where a device is, in words, from the running config (`/api/config`, the device's entries with defaults filled
 * in): "10.0.1.1:502, unit id 1" for Modbus TCP, "device instance 2001 at 192.168.1.20" for BACnet/IP. Pure, so it
 * is tested without a browser.
 */
import type { ConfigView } from "@ot-gateway/api"

export type ConfigDevice = ConfigView["devices"][number]

/** A setting of the device, when it is a string or a number. */
const setting = (device: ConfigDevice, key: string): string | number | undefined => {
  const value = device.entries.find((entry) => entry.key === key)?.value
  return typeof value === "string" || typeof value === "number" ? value : undefined
}

/** The device's address as someone on site would check it; undefined when the config does not say. */
export const deviceAddress = (device: ConfigDevice): string | undefined => {
  switch (device.protocol) {
    case "modbus-tcp": {
      const host = setting(device, "host")
      if (host === undefined) return undefined
      const port = setting(device, "port") ?? 502
      const unitId = setting(device, "unitId")
      return `${host}:${port}${unitId === undefined ? "" : `, unit id ${unitId}`}`
    }
    case "bacnet-ip": {
      const instance = setting(device, "deviceInstance")
      if (instance === undefined) return undefined
      const address = setting(device, "address")
      return address === undefined
        ? `device instance ${instance}, found by broadcast (Who-Is)`
        : `device instance ${instance} at ${address}`
    }
    case "simulator":
      return "simulated in the gateway"
    default:
      return undefined
  }
}
