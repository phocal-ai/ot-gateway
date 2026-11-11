/** The test bench's simulated values: in a range that fits their unit. */
import { describe, expect, it } from "@effect/vitest"
import { benchAnalogOf, benchBinaryOf, benchEnergyOf, benchSpread, benchValue } from "../src/TestBench.ts"

const sweep = (unit: string | undefined) => Array.from({ length: 240 }, (_, second) => benchValue(unit, second, 0))

describe("benchValue", () => {
  it("keeps a temperature in °C where a heat pump has it", () => {
    for (const value of sweep("unit:DEG_C")) {
      expect(value).toBeGreaterThanOrEqual(25)
      expect(value).toBeLessThanOrEqual(40)
    }
  })

  it("swings other units between 0 and 100", () => {
    const values = sweep("unit:PERCENT")
    expect(Math.min(...values)).toBeLessThan(1)
    expect(Math.max(...values)).toBeGreaterThan(99)
    expect(sweep(undefined)).toEqual(values)
  })
})

describe("the bench's heat pump", () => {
  // The heat pump of examples/gateway.json, as the demo and the bench run it.
  const heatPump = [
    { id: "flow-temp", unit: "unit:DEG_C", semantics: { haystack: ["leaving", "hot", "water", "temp", "sensor"] } },
    { id: "return-temp", unit: "unit:DEG_C", semantics: { haystack: ["entering", "hot", "water", "temp", "sensor"] } },
    { id: "compressor-running" }
  ]
  const flow = benchAnalogOf(heatPump, 0)
  const back = benchAnalogOf(heatPump, 1)
  const compressor = benchBinaryOf(heatPump, 2)
  const day = Array.from({ length: 24 * 3600 }, (_, second) => second)

  it("keeps flow 3 to 7 K above return through a simulated day", () => {
    for (const second of day) {
      const spread = flow(second) - back(second)
      expect(spread).toBeGreaterThanOrEqual(2.99)
      expect(spread).toBeLessThanOrEqual(7.01)
    }
  })

  it("runs the compressor while the spread is above 4 K, and only then", () => {
    const running = day.filter((second) => compressor(second))
    expect(running.length).toBeGreaterThan(day.length / 2)
    expect(running.length).toBeLessThan(day.length)
    for (const second of day) expect(compressor(second)).toBe(benchSpread(second) > 4)
  })

  it("matches a return to its flow by id when there are no Haystack tags", () => {
    const plain = [
      { id: "supply-temp", unit: "unit:DEG_C" },
      { id: "return-temp", unit: "unit:DEG_C" }
    ]
    const supply = benchAnalogOf(plain, 0)
    const plainReturn = benchAnalogOf(plain, 1)
    for (const second of day.slice(0, 600)) expect(supply(second)).toBeGreaterThan(plainReturn(second))
  })

  it("leaves a temperature without a flow beside it, and other binaries, as they were", () => {
    const alone = [{ id: "return-temp", unit: "unit:DEG_C" }]
    expect(benchAnalogOf(alone, 0)(42)).toBe(benchValue("unit:DEG_C", 42, 0))
    expect(benchBinaryOf(alone, 0)(10)).toBe(true)
    expect(benchBinaryOf(alone, 0)(40)).toBe(false)
  })
})

describe("benchEnergyOf", () => {
  const meter = [
    { id: "active-power", unit: "unit:KiloW" },
    { id: "energy", unit: "unit:KiloW-HR" },
    { id: "breaker-tripped" }
  ]

  it("counts the energy the meter's power delivers, never backwards", () => {
    const energy = benchEnergyOf(meter, 1)
    expect(energy).toBeDefined()
    if (energy === undefined) return
    // A minute of power read every second, summed: what the counter must have added, in kWh.
    let summed = 0
    for (let second = 0; second < 60; second += 0.01) summed += (benchValue("unit:KiloW", second, 0) * 0.01) / 3600
    expect(energy(0, 60)).toBeCloseTo(summed, 2)
    // 0 to 100 kW, 50 kW on average: about 50 kWh an hour, not the 360 kWh it counted before.
    expect(energy(0, 3600)).toBeCloseTo(50, 0)
    for (let second = 0; second < 240; second++) expect(energy(0, second + 1)).toBeGreaterThanOrEqual(energy(0, second))
  })

  it("counts in the counter's own unit, and only for a counter on a device with a power point", () => {
    const inWattHours = benchEnergyOf([meter[0] ?? { id: "p" }, { id: "energy", unit: "unit:W-HR" }], 1)
    expect(inWattHours?.(0, 3600)).toBeCloseTo(50_000, -1)
    expect(benchEnergyOf(meter, 0)).toBeUndefined()
    expect(benchEnergyOf([{ id: "energy", unit: "unit:KiloW-HR" }], 0)).toBeUndefined()
  })
})
