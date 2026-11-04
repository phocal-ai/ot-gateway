/**
 * The `--discover` draft: slugs from free-text names, ids unique within the
 * draft and against the config, addresses only for devices on this network
 * that no other address answered for, and a draft that the config schema
 * accepts as it is. End to end on an in-memory network: devices answering
 * Who-Is for the same instance from different addresses.
 */
import { describe, expect, it } from "@effect/vitest"
import {
  type DescribedDevice,
  type FoundDevice,
  makeSimulatedDevice,
  parseDeviceAddress,
  serveSimulatedDevice
} from "@ot-gateway/bacnet"
import { makeMemoryNetwork, parseConfig } from "@ot-gateway/core"
import { Effect, Fiber, Result } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { discover, draftDevices, printable, slugify } from "../src/Discover.ts"

const found = (
  instance: number,
  at: string,
  described: DescribedDevice,
  routed = false,
  conflicts: Array<string> = []
) => {
  const device: FoundDevice = {
    instance,
    address: Result.getOrThrow(parseDeviceAddress(at)),
    maxApdu: 1476,
    segmentation: 3,
    vendorId: 260,
    ...(routed ? { network: { network: 5, address: new Uint8Array([7]) } } : {}),
    conflicts: conflicts.map((other) => ({ address: Result.getOrThrow(parseDeviceAddress(other)) }))
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

  it("leaves the address out for a device that more than one address answered for", () => {
    const [draft] = draftDevices([
      found(2001, "10.0.0.5", { name: "", listed: 0, objects: [] }, false, ["10.0.0.9:47809"])
    ])
    expect(draft).toEqual({ protocol: "bacnet-ip", id: "device-2001", deviceInstance: 2001, points: [] })
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

const ahu = (instance: number) =>
  makeSimulatedDevice({
    instance,
    name: "AHU 2",
    objects: [
      {
        objectType: "analog-input",
        instance: 1,
        name: "Supply Temp",
        presentValue: { type: "real", value: 18.5 },
        units: 62
      }
    ]
  })

/** Serve each device from its own host, run `--discover` from 10.0.0.1, and return its stdout draft and stderr. */
const run = Effect.fnUntraced(
  function* (devices: ReadonlyArray<{ readonly ip: string; readonly instance: number }>) {
    const network = makeMemoryNetwork()
    yield* Effect.forEach(devices, ({ ip, instance }) =>
      Effect.flatMap(network.host(ip).udp({ address: ip, port: 47_808 }), (socket) =>
        serveSimulatedDevice(socket, ahu(instance))
      )
    )
    const config = yield* parseConfig(
      JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://broker" }, devices: [] })
    )
    const running = yield* discover(config, network.host("10.0.0.1")).pipe(Effect.forkChild)
    yield* TestClock.adjust("4 seconds")
    yield* Fiber.join(running)
    const [draft] = yield* TestConsole.logLines
    const errors = yield* TestConsole.errorLines
    const parsed: unknown = JSON.parse(String(draft))
    return { draft: parsed, errors: errors.map(String) }
  },
  Effect.scoped,
  Effect.provide(TestConsole.layer)
)

describe("discover", () => {
  it.effect("drafts one device without an address, and warns, when two addresses answer for its instance", () =>
    Effect.gen(function* () {
      const { draft, errors } = yield* run([
        { ip: "10.0.2.1", instance: 2001 },
        { ip: "10.0.2.2", instance: 2001 }
      ])
      expect(draft).toEqual({
        devices: [{ protocol: "bacnet-ip", id: "device-2001", deviceInstance: 2001, points: [] }]
      })
      const warnings = errors.filter((line) => line.includes("WARNING"))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("device 2001")
      expect(warnings[0]).toContain("10.0.2.1:47808")
      expect(warnings[0]).toContain("10.0.2.2:47808")
      expect(warnings[0]).toContain("a source you trust")
    })
  )

  it.effect("drafts a device that one address answered for with that address and its points", () =>
    Effect.gen(function* () {
      const { draft, errors } = yield* run([{ ip: "10.0.2.1", instance: 2001 }])
      expect(draft).toEqual({
        devices: [
          {
            protocol: "bacnet-ip",
            id: "ahu-2",
            deviceInstance: 2001,
            address: "10.0.2.1",
            points: [
              { id: "supply-temp", name: "Supply Temp", unit: "unit:DEG_C", objectType: "analog-input", instance: 1 }
            ]
          }
        ]
      })
      expect(errors.some((line) => line.includes("WARNING"))).toBe(false)
    })
  )
})
