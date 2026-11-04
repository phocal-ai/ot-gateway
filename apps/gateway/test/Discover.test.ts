/**
 * The `--discover` draft: slugs from free-text names, ids unique within the
 * draft and against the config, addresses only for devices on this network,
 * and a draft that the config schema accepts as it is.
 */
import { describe, expect, it } from "@effect/vitest"
import { type DescribedDevice, type DiscoveredDevice, parseDeviceAddress } from "@ot-gateway/bacnet"
import { parseConfig } from "@ot-gateway/core"
import { Effect, Result } from "effect"
import { draftDevices, printable, slugify } from "../src/Discover.ts"

const found = (instance: number, at: string, described: DescribedDevice, routed = false) => {
  const device: DiscoveredDevice = {
    instance,
    address: Result.getOrThrow(parseDeviceAddress(at)),
    maxApdu: 1476,
    segmentation: 3,
    vendorId: 260,
    ...(routed ? { network: { network: 5, address: new Uint8Array([7]) } } : {})
  }
  return { device, described }
}

describe("slugify", () => {
  it("turns object names into config slugs", () => {
    expect(slugify("AHU 2 Supply Air Temp")).toBe("ahu-2-supply-air-temp")
    expect(slugify("Kühlventil Stellung (%)")).toBe("kuhlventil-stellung")
    expect(slugify("  --Zone_3.Temp--  ")).toBe("zone_3-temp")
    expect(slugify("°C")).toBe("c")
    expect(slugify("★")).toBe("")
    expect(slugify("x".repeat(80))).toHaveLength(64)
  })
})

describe("printable", () => {
  it("keeps escape sequences a device put in its name off the terminal", () => {
    expect(printable("AHU 2\u001b]0;pwned\u0007\u001b[2J")).toBe("AHU 2?]0;pwned??[2J")
    expect(printable("Kühler\u200e")).toBe("Kühler?")
    expect(printable("x".repeat(500))).toHaveLength(120)
  })
})

describe("draftDevices", () => {
  it("keeps ids unique, falls back to type and instance, and gives addresses only on this network", () => {
    const draft = draftDevices(
      [
        found(2001, "10.0.0.5", {
          name: "AHU 2",
          listed: 5,
          objects: [
            { objectType: "analog-input", instance: 1, name: "Supply Temp", unit: "unit:DEG_C" },
            { objectType: "analog-input", instance: 2, name: "Supply Temp" },
            { objectType: "binary-output", instance: 3, name: "" },
            // The device's name again in front: the topic already has it.
            { objectType: "binary-input", instance: 4, name: "AHU 2 Fan Status" }
          ]
        }),
        found(2002, "10.0.0.6:47810", {
          name: "AHU 2",
          listed: 1,
          objects: [{ objectType: "analog-value", instance: 9, name: "Setpoint" }]
        }),
        found(3001, "10.0.0.1", { name: "", listed: 1, objects: [] }, true)
      ],
      ["main-meter"]
    )
    expect(draft).toEqual([
      {
        protocol: "bacnet-ip",
        id: "ahu-2",
        deviceInstance: 2001,
        address: "10.0.0.5",
        points: [
          {
            id: "supply-temp",
            name: "Supply Temp",
            unit: "unit:DEG_C",
            objectType: "analog-input",
            instance: 1
          },
          { id: "supply-temp-2", name: "Supply Temp", objectType: "analog-input", instance: 2 },
          { id: "binary-output-3", name: "binary-output-3", objectType: "binary-output", instance: 3 },
          { id: "fan-status", name: "AHU 2 Fan Status", objectType: "binary-input", instance: 4 }
        ]
      },
      {
        protocol: "bacnet-ip",
        id: "ahu-2-2002",
        deviceInstance: 2002,
        address: "10.0.0.6:47810",
        points: [{ id: "setpoint", name: "Setpoint", objectType: "analog-value", instance: 9 }]
      },
      // Behind a router: found by Who-Is, so no address.
      { protocol: "bacnet-ip", id: "device-3001", deviceInstance: 3001, points: [] }
    ])
  })

  it.effect("drafts devices the config schema accepts as they are", () =>
    Effect.gen(function* () {
      const draft = draftDevices([
        found(2001, "10.0.0.5", {
          name: "Boiler Plant",
          listed: 2,
          objects: [
            { objectType: "analog-input", instance: 1, name: "Flow Temp", unit: "unit:DEG_C" },
            { objectType: "multi-state-value", instance: 4, name: "Mode" }
          ]
        })
      ])
      const config = yield* parseConfig(
        JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://broker" }, devices: draft })
      )
      expect(config.devices.map((device) => device.id)).toEqual(["boiler-plant"])
      expect(config.devices[0]?.points.every((point) => !point.writable)).toBe(true)
    })
  )
})
