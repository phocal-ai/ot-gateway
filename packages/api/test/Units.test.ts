/** Units as the status page and `ot-gateway history` show them. */
import { describe, expect, it } from "@effect/vitest"
import { energyUnitInKwh, isEnergyUnit, unitLabel } from "../src/Units.ts"

describe("unitLabel", () => {
  it("writes common QUDT units as their symbols, others without the prefix, and none as nothing", () => {
    expect(unitLabel("unit:DEG_C")).toBe("°C")
    expect(unitLabel("unit:KiloW")).toBe("kW")
    expect(unitLabel("unit:HZ")).toBe("HZ")
    expect(unitLabel("rpm")).toBe("rpm")
    expect(unitLabel(undefined)).toBe("")
    expect(unitLabel("unit:W-HR")).toBe("Wh")
    expect(unitLabel("unit:MegaW-HR")).toBe("MWh")
  })
})

describe("energy units", () => {
  it("knows a counter's unit in kWh, and nothing for a unit that is no energy", () => {
    expect(energyUnitInKwh("unit:KiloW-HR")).toBe(1)
    expect(energyUnitInKwh("unit:W-HR")).toBe(0.001)
    expect(energyUnitInKwh("unit:MegaW-HR")).toBe(1000)
    expect(energyUnitInKwh("unit:MegaJ")).toBeCloseTo(1 / 3.6, 6)
    expect(energyUnitInKwh("kWh")).toBe(1)
    expect(energyUnitInKwh("unit:KiloW")).toBeUndefined()
    expect(energyUnitInKwh(undefined)).toBeUndefined()
    expect(isEnergyUnit("unit:GigaJ")).toBe(true)
    expect(isEnergyUnit("unit:DEG_C")).toBe(false)
  })
})
