/**
 * Where a device is, in words, from the running config's entries.
 */
import { describe, expect, it } from "@effect/vitest"
import { type ConfigDevice, deviceAddress } from "../src/lib/device.ts"

const device = (protocol: string, entries: Record<string, string | number | boolean>): ConfigDevice => ({
  id: "meter",
  protocol,
  pointCount: 1,
  entries: Object.entries(entries).map(([key, value]) => ({ key, value }))
})

describe("deviceAddress", () => {
  it("gives a Modbus device's host, port and unit id", () => {
    expect(deviceAddress(device("modbus-tcp", { host: "10.0.1.1", port: 502, unitId: 1 }))).toBe(
      "10.0.1.1:502, unit id 1"
    )
    expect(deviceAddress(device("modbus-tcp", { host: "meter.local" }))).toBe("meter.local:502")
    expect(deviceAddress(device("modbus-tcp", {}))).toBeUndefined()
  })

  it("gives a BACnet device's instance, and its address or that it is found by broadcast", () => {
    expect(deviceAddress(device("bacnet-ip", { deviceInstance: 2001, address: "192.168.1.20" }))).toBe(
      "device instance 2001 at 192.168.1.20"
    )
    expect(deviceAddress(device("bacnet-ip", { deviceInstance: 2001, cov: true }))).toBe(
      "device instance 2001, found by broadcast (Who-Is)"
    )
  })

  it("says a simulated device runs in the gateway, and nothing for a protocol it does not know", () => {
    expect(deviceAddress(device("simulator", {}))).toBe("simulated in the gateway")
    expect(deviceAddress(device("opc-ua", { host: "x" }))).toBeUndefined()
  })
})
