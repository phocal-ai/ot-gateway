/**
 * The `--discover` draft: slugs from free-text names, ids unique within the
 * draft and against the config, and addresses only for devices on this
 * network that no other address answered for. A draft of devices that each
 * answered from one address and have objects is accepted by the config
 * schema as it is; one drafted with `points: []` (behind a router with no
 * objects read, or claimed from several addresses) is not, until someone
 * fills it in. End to end on an in-memory network: devices answering Who-Is
 * for the same instance from different addresses, and devices already in
 * the config.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import {
  type DescribedDevice,
  type FoundDevice,
  makeSimulatedDevice,
  MAX_CONFLICTS,
  parseDeviceAddress,
  serveSimulatedDevice
} from "@ot-gateway/bacnet"
import { makeMemoryNetwork, parseConfig } from "@ot-gateway/core"
import { Effect, Fiber, FileSystem, Result } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import {
  discover,
  type DiscoverOptions,
  discoverToPointsList,
  draftDevices,
  draftPointsList,
  printable,
  slugify
} from "../src/Discover.ts"
import { devicesFromPointsList } from "../src/PointsList.ts"

const addressOf = (text: string) => Result.getOrThrow(parseDeviceAddress(text))

const found = (
  instance: number,
  at: string,
  described: DescribedDevice,
  options: { readonly routed?: boolean; readonly conflicts?: ReadonlyArray<string> } = {}
) => {
  const device: FoundDevice = {
    instance,
    address: addressOf(at),
    maxApdu: 1476,
    segmentation: 3,
    vendorId: 260,
    ...(options.routed === true ? { network: { network: 5, address: new Uint8Array([7]) } } : {}),
    conflicts: (options.conflicts ?? []).map((other) => ({ address: addressOf(other) }))
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
    expect(printable("Kühler‎")).toBe("Kühler?")
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
        found(3001, "10.0.0.1", { name: "", listed: 1, objects: [] }, { routed: true })
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
      found(2001, "10.0.0.5", { name: "", listed: 0, objects: [] }, { conflicts: ["10.0.0.9:47809"] })
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
      },
      { objectType: "binary-output", instance: 2, name: "Fan", presentValue: { type: "enumerated", value: 1 } }
    ]
  })

const supplyTemp = {
  id: "supply-temp",
  name: "Supply Temp",
  unit: "unit:DEG_C",
  objectType: "analog-input",
  instance: 1
}
const fan = { id: "fan", name: "Fan", objectType: "binary-output", instance: 2 }

/**
 * Serve an AHU with each instance from its own host, run `--discover` from
 * 10.0.0.1 with `devices` in the config, and return its stdout draft and
 * stderr.
 */
const run = Effect.fnUntraced(
  function* (
    hosts: ReadonlyArray<{ readonly ip: string; readonly instance: number; readonly port?: number }>,
    devices: ReadonlyArray<unknown> = [],
    options: DiscoverOptions = {}
  ) {
    const network = makeMemoryNetwork()
    yield* Effect.forEach(hosts, ({ ip, instance, port }) =>
      Effect.flatMap(network.host(ip).udp({ address: ip, port: port ?? 47_808 }), (socket) =>
        serveSimulatedDevice(socket, ahu(instance))
      )
    )
    const config = yield* parseConfig(
      JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://broker" }, devices })
    )
    const running = yield* discover(config, network.host("10.0.0.1"), options).pipe(Effect.forkChild)
    yield* TestClock.adjust("4 seconds")
    yield* Fiber.join(running)
    const [draft] = yield* TestConsole.logLines
    const errors = yield* TestConsole.errorLines
    const parsed: unknown = JSON.parse(String(draft))
    return {
      draft: parsed,
      errors: errors.map(String),
      warnings: errors.map(String).filter((line) => line.includes("WARNING"))
    }
  },
  Effect.scoped,
  Effect.provide(TestConsole.layer)
)

const twoHosts = [
  { ip: "10.0.2.1", instance: 2001 },
  { ip: "10.0.2.2", instance: 2001 }
]

describe("discover", () => {
  it.effect("drafts one device without an address, and warns, when two addresses answer for its instance", () =>
    Effect.gen(function* () {
      const { draft, warnings } = yield* run(twoHosts)
      expect(draft).toEqual({
        devices: [{ protocol: "bacnet-ip", id: "device-2001", deviceInstance: 2001, points: [] }]
      })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("device 2001")
      expect(warnings[0]).toContain("10.0.2.1:47808, 10.0.2.2:47808.")
      expect(warnings[0]).toContain("Two devices may share instance 2001, or one device answers on several addresses.")
      expect(warnings[0]).toContain("Its draft entry has no address and no points.")
      expect(warnings[0]).toContain("a source you trust")
      expect(warnings[0]).toContain("the list only says which hosts to check")
    })
  )

  it.effect("says that the list may be incomplete once MAX_CONFLICTS other addresses answered", () =>
    Effect.gen(function* () {
      const hosts = Array.from({ length: MAX_CONFLICTS + 2 }, (_, index) => ({
        ip: `10.0.2.${index + 1}`,
        instance: 2001
      }))
      const { warnings } = yield* run(hosts)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.match(/10\.0\.2\.\d+:47808/g)).toHaveLength(MAX_CONFLICTS + 1)
      expect(warnings[0]).toContain(" and possibly more.")
    })
  )

  it.effect("tells how to fix a device in the config that several addresses answer for, without a draft entry", () =>
    Effect.gen(function* () {
      const configured = { protocol: "bacnet-ip", id: "ahu", deviceInstance: 2001, points: [supplyTemp] }
      const { draft, errors, warnings } = yield* run(twoHosts, [configured])
      expect(draft).toEqual({ devices: [] })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("It is in the config as ahu: set its address from a source you trust")
      expect(warnings[0]).not.toContain("draft entry")
      expect(errors.some((line) => line.includes("already in the config as ahu"))).toBe(true)
    })
  )

  it.effect("reads a device in the config at its address and drafts the objects it has no point for", () =>
    Effect.gen(function* () {
      // The configured point names its type by number, and has the id the new point would get.
      const configured = {
        protocol: "bacnet-ip",
        id: "ahu",
        deviceInstance: 2001,
        address: "10.0.2.1",
        points: [{ id: "fan", name: "Supply Temp", objectType: "0", instance: 1 }]
      }
      const { draft, errors, warnings } = yield* run([{ ip: "10.0.2.1", instance: 2001 }], [configured])
      expect(draft).toEqual({
        devices: [
          {
            protocol: "bacnet-ip",
            id: "ahu",
            deviceInstance: 2001,
            address: "10.0.2.1",
            points: [{ ...fan, id: "fan-2" }]
          }
        ]
      })
      expect(warnings).toEqual([])
      expect(errors.some((line) => line.includes("in the config as ahu, read at 10.0.2.1: 1 point(s)"))).toBe(true)
    })
  )

  it.effect("drafts a device that one address answered for with that address and its points", () =>
    Effect.gen(function* () {
      const { draft, warnings } = yield* run([{ ip: "10.0.2.1", instance: 2001 }])
      expect(draft).toEqual({
        devices: [
          {
            protocol: "bacnet-ip",
            id: "ahu-2",
            deviceInstance: 2001,
            address: "10.0.2.1",
            points: [supplyTemp, fan]
          }
        ]
      })
      expect(warnings).toEqual([])
    })
  )
})

describe("discover --address", () => {
  const twoPorts = [
    { ip: "10.0.2.1", instance: 2001 },
    { ip: "10.0.2.2", instance: 2002, port: 47_809 }
  ]

  it.effect("asks the one device at a known address, on a port a broadcast does not reach", () =>
    Effect.gen(function* () {
      const { draft, errors } = yield* run(twoPorts, [], { address: "10.0.2.2:47809" })
      expect(draft).toMatchObject({ devices: [{ id: "ahu-2", deviceInstance: 2002, address: "10.0.2.2:47809" }] })
      expect(errors[0]).toContain("Who-Is to 10.0.2.2:47809")
    })
  )

  it.effect("names the address and what to check when that device does not answer", () =>
    Effect.gen(function* () {
      const { draft, errors } = yield* run(twoPorts, [], { address: "10.0.2.9" })
      expect(draft).toEqual({ devices: [] })
      expect(errors.some((line) => line.includes("No device answered at 10.0.2.9"))).toBe(true)
    })
  )

  it.effect("points at --address when a broadcast finds nothing", () =>
    Effect.gen(function* () {
      const { errors } = yield* run([{ ip: "10.0.2.2", instance: 2002, port: 47_809 }])
      expect(errors.some((line) => line.includes("discover --address ip[:port]"))).toBe(true)
    })
  )

  it.effect("refuses an address that is not ip or ip:port", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig(
        JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://broker" }, devices: [] })
      )
      const error = yield* discover(config, makeMemoryNetwork().host("10.0.0.1"), { address: "ahu.local" }).pipe(
        Effect.flip
      )
      expect(error.message).toContain("--address takes ip or ip:port")
    }).pipe(Effect.provide(TestConsole.layer))
  )
})

describe("draftPointsList", () => {
  it("writes one row per object that import turns back into the same devices and point ids", () =>
    Effect.gen(function* () {
      const drafts = draftDevices([
        found(2001, "10.0.0.5", {
          name: "AHU 2",
          listed: 4,
          objects: [
            { objectType: "analog-input", instance: 1, name: "Supply Temp, °C", unit: "unit:DEG_C" },
            { objectType: "analog-input", instance: 2, name: "Supply Temp, °C" },
            { objectType: "binary-input", instance: 3, name: '=HYPERLINK("x")' },
            { objectType: "binary-output", instance: 4, name: "Fan" }
          ]
        })
      ])
      const list = draftPointsList(drafts)
      expect(list.split("\n")[0]).toBe("device,point,unit,device_instance,address,object_type,object_instance")
      expect(list).toContain('ahu-2,"Supply Temp, °C",unit:DEG_C,2001,10.0.0.5,analog-input,1')
      expect(list).not.toContain("=HYPERLINK")
      const [device] = yield* devicesFromPointsList(list)
      expect(device?.id).toBe("ahu-2")
      expect(device?.points.map((point) => point.id)).toEqual(drafts[0]?.points.map((point) => point.id))
    }).pipe(Effect.runSync))
})

describe("discover --points-list", () => {
  it.effect("writes the devices not in the config yet, and leaves an existing file alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const path = `${directory}/points.csv`
      const network = makeMemoryNetwork()
      yield* Effect.forEach([2001, 2002], (instance, index) =>
        Effect.flatMap(
          network.host(`10.0.2.${index + 1}`).udp({ address: `10.0.2.${index + 1}`, port: 47_808 }),
          (socket) => serveSimulatedDevice(socket, ahu(instance))
        )
      )
      const config = yield* parseConfig(
        JSON.stringify({
          site: "s",
          building: "b",
          mqtt: { url: "mqtt://broker" },
          devices: [
            {
              protocol: "bacnet-ip",
              id: "ahu",
              deviceInstance: 2002,
              address: "10.0.2.2",
              points: [{ ...fan, objectType: "binary-output" }]
            }
          ]
        })
      )
      const running = yield* discoverToPointsList(config, path, network.host("10.0.0.1")).pipe(Effect.forkChild)
      // The file check before discovery is real I/O, so virtual time moves in steps until the fiber listens.
      for (let step = 0; step < 30; step++) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2)))
        yield* TestClock.adjust("200 millis")
      }
      yield* Fiber.join(running)
      const list = yield* fs.readFileString(path)
      const devices = yield* devicesFromPointsList(list, ["ahu"])
      expect(devices.map((device) => device.id)).toEqual(["ahu-2"])
      expect(devices[0]?.points.map((point) => point.id)).toEqual(["supply-temp", "fan"])
      const errors = (yield* TestConsole.errorLines).map(String)
      expect(errors.some((line) => line.includes("1 device(s) already in the config are left out"))).toBe(true)
      expect(errors.some((line) => line.includes(`ot-gateway import ${path}`))).toBe(true)

      yield* discoverToPointsList(config, path, network.host("10.0.0.1"))
      expect(yield* fs.readFileString(path)).toBe(list)
    }).pipe(Effect.scoped, Effect.provide([TestConsole.layer, NodeServices.layer]))
  )

  it.effect("writes no file when nothing answered", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const path = `${directory}/points.csv`
      const config = yield* parseConfig(
        JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://broker" }, devices: [] })
      )
      const running = yield* discoverToPointsList(config, path, makeMemoryNetwork().host("10.0.0.1")).pipe(
        Effect.forkChild
      )
      for (let step = 0; step < 30; step++) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2)))
        yield* TestClock.adjust("200 millis")
      }
      yield* Fiber.join(running)
      expect(yield* fs.exists(path)).toBe(false)
      const errors = (yield* TestConsole.errorLines).map(String)
      expect(errors.some((line) => line.includes("was not written"))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide([TestConsole.layer, NodeServices.layer]))
  )
})
