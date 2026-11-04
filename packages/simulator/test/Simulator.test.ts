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
  it("constant stays at min", () => {
    expect(waveformValue({ ...base, waveform: "constant" }, 12_345)).toBe(10)
  })
})
