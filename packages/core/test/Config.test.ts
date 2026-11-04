import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { cycleTimeoutMs, parseConfig } from "../src/index.ts"

const minimal = {
  site: "vienna-hq",
  building: "b1",
  mqtt: { url: "mqtt://localhost:1883" },
  devices: [
    {
      protocol: "modbus-tcp",
      id: "meter-1",
      host: "192.168.1.50",
      points: [{ id: "active-power", name: "Active power", table: "holding", address: 100, dataType: "float32" }]
    }
  ]
}

/** A BACnet device as written in a config file, at `address` if given. */
const bacnetDevice = (address?: string) => ({
  protocol: "bacnet-ip",
  id: "ahu-2",
  deviceInstance: 1001,
  ...(address === undefined ? {} : { address }),
  points: [{ id: "supply-temp", name: "Supply temperature", objectType: "analog-input", instance: 1 }]
})

/** A config whose one BACnet point has `priority`, or none. */
const withPriority = (priority?: number) => {
  const [point] = bacnetDevice().points
  return JSON.stringify({
    ...minimal,
    devices: [{ ...bacnetDevice(), points: [{ ...point, ...(priority === undefined ? {} : { priority }) }] }]
  })
}

describe("parseConfig", () => {
  it.effect("applies defaults", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig(JSON.stringify(minimal))
      const device = config.devices[0]
      expect(device?.protocol).toBe("modbus-tcp")
      if (device?.protocol !== "modbus-tcp") return
      expect(device.port).toBe(502)
      expect(device.unitId).toBe(1)
      expect(device.pollIntervalMs).toBe(5000)
      expect(device.points[0]?.writable).toBe(false)
      expect(config.id).toBe("main")
      expect(config.healthIntervalMs).toBe(60_000)
    })
  )

  it.effect("rejects ids that are not valid topic segments", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(parseConfig(JSON.stringify({ ...minimal, site: "Vienna/HQ" })))
      expect(Exit.isFailure(exit)).toBe(true)
    })
  )

  it.effect("rejects out-of-range register addresses", () =>
    Effect.gen(function* () {
      const [device] = minimal.devices
      const bad = {
        ...minimal,
        devices: [{ ...device, points: device?.points.map((point) => ({ ...point, address: 70000 })) }]
      }
      const exit = yield* Effect.exit(parseConfig(JSON.stringify(bad)))
      expect(Exit.isFailure(exit)).toBe(true)
    })
  )

  it.effect("rejects a 32-bit register point that would run past address 65535", () =>
    Effect.gen(function* () {
      const [device] = minimal.devices
      const at = (address: number, table = "holding") => ({
        ...minimal,
        devices: [{ ...device, points: device?.points.map((point) => ({ ...point, table, address })) }]
      })
      // The minimal point is a float32: two registers.
      expect(Exit.isFailure(yield* Effect.exit(parseConfig(JSON.stringify(at(65535)))))).toBe(true)
      expect(Exit.isSuccess(yield* Effect.exit(parseConfig(JSON.stringify(at(65534)))))).toBe(true)
      // A bit occupies one address whatever its data type.
      expect(Exit.isSuccess(yield* Effect.exit(parseConfig(JSON.stringify(at(65535, "coil")))))).toBe(true)
      // A 64-bit value takes four registers.
      const wide = (address: number) => ({
        ...minimal,
        devices: [
          {
            ...device,
            points: device?.points.map((point) => ({ ...point, address, dataType: "uint64", byteOrder: "CDAB" }))
          }
        ]
      })
      expect(Exit.isFailure(yield* Effect.exit(parseConfig(JSON.stringify(wide(65533)))))).toBe(true)
      expect(Exit.isSuccess(yield* Effect.exit(parseConfig(JSON.stringify(wide(65532)))))).toBe(true)
    })
  )

  it.effect("takes one bit of a register as a read-only bool point, and nothing else", () =>
    Effect.gen(function* () {
      const [device] = minimal.devices
      const withPoint = (overrides: Record<string, unknown>) => ({
        ...minimal,
        devices: [{ ...device, points: device?.points.map((point) => ({ ...point, ...overrides })) }]
      })
      const outcome = (overrides: Record<string, unknown>) =>
        Effect.map(Effect.exit(parseConfig(JSON.stringify(withPoint(overrides)))), (exit) => exit._tag)
      expect(yield* outcome({ table: "holding", dataType: "bool", bit: 3 })).toBe("Success")
      expect(yield* outcome({ table: "input", dataType: "bool", bit: 15 })).toBe("Success")
      expect(yield* outcome({ table: "holding", dataType: "bool", bit: 16 })).toBe("Failure")
      expect(yield* outcome({ table: "holding", dataType: "uint16", bit: 3 })).toBe("Failure")
      expect(yield* outcome({ table: "coil", dataType: "bool", bit: 3 })).toBe("Failure")
      expect(yield* outcome({ table: "holding", dataType: "bool", bit: 3, writable: true })).toBe("Failure")
    })
  )

  it.effect("reads 32-bit values high word first unless byteOrder says otherwise, and refuses unknown orders", () =>
    Effect.gen(function* () {
      const [device] = minimal.devices
      const ordered = (byteOrder?: string) => ({
        ...minimal,
        devices: [
          {
            ...device,
            points: device?.points.map((point) => ({ ...point, ...(byteOrder === undefined ? {} : { byteOrder }) }))
          }
        ]
      })
      const parsed = yield* parseConfig(JSON.stringify(ordered()))
      const [first] = parsed.devices
      expect(first?.protocol === "modbus-tcp" ? first.points[0]?.byteOrder : undefined).toBe("ABCD")
      expect(Exit.isFailure(yield* Effect.exit(parseConfig(JSON.stringify(ordered("little")))))).toBe(true)
    })
  )

  it.effect("rejects values that would wrap on the wire or disable the buffer", () =>
    Effect.gen(function* () {
      const [device] = minimal.devices
      const invalid = [
        { ...minimal, devices: [{ ...device, unitId: 257 }] },
        { ...minimal, devices: [{ ...device, port: 0 }] },
        { ...minimal, buffer: { path: "b.sqlite", maxRows: 0 } }
      ]
      for (const config of invalid) {
        const exit = yield* Effect.exit(parseConfig(JSON.stringify(config)))
        expect(Exit.isFailure(exit)).toBe(true)
      }
      expect(
        Exit.isSuccess(yield* Effect.exit(parseConfig(JSON.stringify({ ...minimal, buffer: { path: "b" } }))))
      ).toBe(true)
    })
  )

  it.effect("defaults the BACnet endpoint and checks device addresses", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig(JSON.stringify({ ...minimal, devices: [bacnetDevice("192.168.1.20:47809")] }))
      expect(config.bacnet).toEqual({
        bindAddress: "0.0.0.0",
        port: 47_808,
        broadcastAddress: "255.255.255.255",
        requestTimeoutMs: 3_000,
        retries: 2,
        covLifetimeSeconds: 300
      })
      const device = config.devices[0]
      expect(device?.protocol === "bacnet-ip" && device.points[0]?.property).toBe("present-value")
      for (const address of ["ahu-2.local", "192.168.1.256", "10.0.0.1:", "::1", "10.0.0.1:0", "10.0.0.1:65536"]) {
        const exit = yield* Effect.exit(parseConfig(JSON.stringify({ ...minimal, devices: [bacnetDevice(address)] })))
        expect(Exit.isFailure(exit)).toBe(true)
      }
      const withPort = { ...minimal, bacnet: { broadcastAddress: "192.168.1.255:47809" } }
      expect((yield* parseConfig(JSON.stringify(withPort))).bacnet.broadcastAddress).toBe("192.168.1.255:47809")
      const badBroadcast = { ...minimal, bacnet: { broadcastAddress: "192.168.1.255:99999" } }
      expect(Exit.isFailure(yield* Effect.exit(parseConfig(JSON.stringify(badBroadcast))))).toBe(true)
      for (const covLifetimeSeconds of [0, 9, 86_401, 30.5]) {
        const exit = yield* Effect.exit(parseConfig(JSON.stringify({ ...minimal, bacnet: { covLifetimeSeconds } })))
        expect(Exit.isFailure(exit)).toBe(true)
      }
    })
  )

  it.effect("defaults a BACnet point's write priority to 8, and refuses 6 and anything outside 1 to 16", () =>
    Effect.gen(function* () {
      const device = (yield* parseConfig(withPriority())).devices[0]
      expect(device?.protocol === "bacnet-ip" && device.points[0]?.priority).toBe(8)
      for (const priority of [0, 6, 17, 1.5]) {
        expect(Exit.isFailure(yield* Effect.exit(parseConfig(withPriority(priority))))).toBe(true)
      }
      for (const priority of [1, 16])
        expect(Exit.isSuccess(yield* Effect.exit(parseConfig(withPriority(priority))))).toBe(true)
    })
  )

  it.effect("defaults the cycle deadline from the poll interval unless it is set", () =>
    Effect.gen(function* () {
      const [device] = minimal.devices
      const config = yield* parseConfig(
        JSON.stringify({
          ...minimal,
          devices: [
            { ...device, id: "fast", pollIntervalMs: 1_000 },
            { ...device, id: "slow", pollIntervalMs: 60_000 },
            { ...device, id: "set", cycleTimeoutMs: 120_000 }
          ]
        })
      )
      expect(config.devices.map(cycleTimeoutMs)).toEqual([31_000, 120_000, 120_000])
      const tooShort = { ...minimal, devices: [{ ...device, cycleTimeoutMs: 10 }] }
      expect(Exit.isFailure(yield* Effect.exit(parseConfig(JSON.stringify(tooShort))))).toBe(true)
    })
  )
})
