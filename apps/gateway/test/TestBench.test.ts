/** The test bench's simulated values: in a range that fits their unit. */
import { describe, expect, it } from "@effect/vitest"
import { benchValue } from "../src/TestBench.ts"

const sweep = (unit: string | undefined) => Array.from({ length: 240 }, (_, second) => benchValue(unit, second, 0))

describe("benchValue", () => {
  it("keeps a temperature in °C where a building has it", () => {
    for (const value of sweep("unit:DEG_C")) {
      expect(value).toBeGreaterThanOrEqual(12)
      expect(value).toBeLessThanOrEqual(24)
    }
  })

  it("swings other units between 0 and 100", () => {
    const values = sweep("unit:PERCENT")
    expect(Math.min(...values)).toBeLessThan(1)
    expect(Math.max(...values)).toBeGreaterThan(99)
    expect(sweep(undefined)).toEqual(values)
  })
})
