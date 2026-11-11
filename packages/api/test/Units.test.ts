/** Units as the status page and `ot-gateway history` show them. */
import { describe, expect, it } from "@effect/vitest"
import { unitLabel } from "../src/Units.ts"

describe("unitLabel", () => {
  it("writes common QUDT units as their symbols, others without the prefix, and none as nothing", () => {
    expect(unitLabel("unit:DEG_C")).toBe("°C")
    expect(unitLabel("unit:KiloW")).toBe("kW")
    expect(unitLabel("unit:HZ")).toBe("HZ")
    expect(unitLabel("rpm")).toBe("rpm")
    expect(unitLabel(undefined)).toBe("")
  })
})
