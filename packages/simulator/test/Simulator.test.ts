import { describe, expect, it } from "@effect/vitest"
import type { SimulatedPoint } from "@ot-gateway/core"
import { waveformValue } from "../src/index.ts"

const base: SimulatedPoint = {
  id: "p",
  name: "p",
  writable: false,
  waveform: "sine",
  min: 10,
  max: 30,
  periodSeconds: 60
}

describe("waveformValue", () => {
  it("sine starts in the middle and peaks at a quarter period", () => {
    expect(waveformValue(base, 0)).toBeCloseTo(20)
    expect(waveformValue(base, 15_000)).toBeCloseTo(30)
  })
  it("ramp rises linearly and wraps", () => {
    const ramp = { ...base, waveform: "ramp" as const }
    expect(waveformValue(ramp, 30_000)).toBeCloseTo(20)
    expect(waveformValue(ramp, 60_000)).toBeCloseTo(10)
  })
  it("keeps three decimals, as a device reports them, not a double's float noise", () => {
    const inverter = { ...base, min: 0, max: 8 }
    for (let timeMs = 0; timeMs < 60_000; timeMs += 777) {
      for (const waveform of ["sine", "ramp"] as const) {
        const value = waveformValue({ ...inverter, waveform }, timeMs)
        expect(String(value).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(3)
      }
    }
    // 8 * (0.5 + 0.5 * sin(2π * 4 / 60)) is 5.62694…, published as 5.627.
    expect(waveformValue(inverter, 4_000)).toBe(5.627)
  })
  it("daily counts the day so far: never down within a day, from min at local midnight to max at the next", () => {
    const today = { ...base, waveform: "daily" as const, min: 0, max: 40 }
    const midnight = new Date(2026, 10, 25).getTime()
    const next = new Date(2026, 10, 26).getTime()
    expect(waveformValue(today, midnight)).toBe(0)
    let previous = -1
    // Every 2 s for the first ten minutes (a poll interval), then every 7 min to the end of the day.
    for (let timeMs = midnight; timeMs < next; timeMs += timeMs < midnight + 600_000 ? 2_000 : 420_000) {
      const value = waveformValue(today, timeMs)
      expect(value).toBeGreaterThanOrEqual(previous)
      expect(value).toBeLessThanOrEqual(40)
      previous = value
    }
    expect(waveformValue(today, next - 1_000)).toBeCloseTo(40, 2)
    expect(waveformValue(today, midnight + (next - midnight) / 2)).toBeCloseTo(20, 2)
    // It starts again only at the next local midnight.
    expect(waveformValue(today, next)).toBe(0)
  })
  it("constant stays at min", () => {
    expect(waveformValue({ ...base, waveform: "constant" }, 12_345)).toBe(10)
  })
})
