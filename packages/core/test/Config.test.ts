import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { parseConfig } from "../src/index.ts"

const minimal = {
  site: "vienna-hq",
  building: "b1",
  mqtt: { url: "mqtt://localhost:1883" },
  devices: [
    {
      protocol: "modbus-tcp",
      id: "meter-1",
      host: "192.168.1.50",
      points: [
        { id: "active-power", name: "Active power", table: "holding", address: 100, dataType: "float32" }
      ]
    }
  ]
}

describe("parseConfig", () => {
  it.effect("applies defaults", () =>
    Effect.gen(function*() {
      const config = yield* parseConfig(JSON.stringify(minimal))
      const device = config.devices[0]
      expect(device?.protocol).toBe("modbus-tcp")
      if (device?.protocol !== "modbus-tcp") return
      expect(device.port).toBe(502)
      expect(device.unitId).toBe(1)
      expect(device.pollIntervalMs).toBe(5000)
      expect(device.points[0]?.writable).toBe(false)
    }))

  it.effect("rejects ids that are not valid topic segments", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(parseConfig(JSON.stringify({ ...minimal, site: "Vienna/HQ" })))
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("rejects out-of-range register addresses", () =>
    Effect.gen(function*() {
      const bad = structuredClone(minimal)
      bad.devices[0]!.points[0]!.address = 70000
      const exit = yield* Effect.exit(parseConfig(JSON.stringify(bad)))
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})
