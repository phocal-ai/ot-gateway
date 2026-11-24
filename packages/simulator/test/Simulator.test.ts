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
  it("constant stays at min", () => {
    expect(waveformValue({ ...base, waveform: "constant" }, 12_345)).toBe(10)
  })
})
