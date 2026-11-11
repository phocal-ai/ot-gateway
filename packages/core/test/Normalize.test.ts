import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import {
  applyScaling,
  exceedsDeadband,
  metaTopic,
  pointTopic,
  shortestFloat32,
  withoutBinaryNoise
} from "../src/index.ts"

describe("applyScaling", () => {
  it("is the identity without scaling", () => {
    expect(applyScaling(42, undefined)).toBe(42)
  })
  it("applies factor and offset", () => {
    expect(applyScaling(215, { factor: 0.1, offset: -1.5 })).toBe(20)
  })
  it("drops the binary noise of the multiplication", () => {
    expect(3 * 0.1).toBe(0.30000000000000004)
    expect(applyScaling(3, { factor: 0.1, offset: 0 })).toBe(0.3)
    expect(applyScaling(1234, { factor: 0.1, offset: 0 })).toBe(123.4)
    expect(applyScaling(6.73, { factor: 0.1, offset: 0 })).toBe(0.673)
  })
})

describe("shortestFloat32", () => {
  it("gives the decimal the device holds, not the float64 its 32 bits are", () => {
    expect(Math.fround(6.73)).toBe(6.730000019073486)
    expect(shortestFloat32(Math.fround(6.73))).toBe(6.73)
    expect(shortestFloat32(Math.fround(50.13))).toBe(50.13)
    expect(shortestFloat32(Math.fround(72.4))).toBe(72.4)
  })
  it("keeps the same single-precision bits", () => {
    for (const value of [6.73, 50.13, 0.1, 1 / 3, 123456.789, -273.15, 3.4028234663852886e38, 1.401298464324817e-45]) {
      const single = Math.fround(value)
      expect(Math.fround(shortestFloat32(single))).toBe(single)
    }
  })
  it("is never longer than nine significant digits", () => {
    const sample = [Math.PI, Math.E, 1 / 3, 2 / 3, 16_777_217, 0.000_123_456_78].map(Math.fround)
    for (const single of sample) {
      expect(Math.fround(shortestFloat32(single))).toBe(single)
      expect(String(shortestFloat32(single)).replace(/^[-0.]+|e.*$|\./g, "").length).toBeLessThanOrEqual(9)
    }
  })
  it("leaves whole numbers and non-finite values alone", () => {
    expect(shortestFloat32(21.5)).toBe(21.5)
    expect(shortestFloat32(16_777_216)).toBe(16_777_216)
    expect(shortestFloat32(Number.NaN)).toBeNaN()
    expect(shortestFloat32(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("withoutBinaryNoise", () => {
  it("rounds to 15 significant digits", () => {
    expect(withoutBinaryNoise(0.1 + 0.2)).toBe(0.3)
    expect(withoutBinaryNoise(28.430000000000003)).toBe(28.43)
    expect(withoutBinaryNoise(1 / 3)).toBe(0.333333333333333)
  })
  it("keeps every digit of a whole number, and non-finite values", () => {
    expect(withoutBinaryNoise(9_007_199_254_740_991)).toBe(9_007_199_254_740_991)
    expect(withoutBinaryNoise(Number.NaN)).toBeNaN()
    expect(withoutBinaryNoise(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe("exceedsDeadband", () => {
  it("always publishes the first value", () => {
    expect(exceedsDeadband(Option.none(), 1, 10)).toBe(true)
  })
  it("suppresses changes smaller than the deadband", () => {
    expect(exceedsDeadband(Option.some(20), 20.2, 0.5)).toBe(false)
    expect(exceedsDeadband(Option.some(20), 20.5, 0.5)).toBe(true)
  })
  it("publishes any boolean change", () => {
    expect(exceedsDeadband(Option.some(true), true, undefined)).toBe(false)
    expect(exceedsDeadband(Option.some(true), false, undefined)).toBe(true)
  })
})

describe("topics", () => {
  const parts = { site: "site-1", building: "building-a", device: "ventilation-1", point: "supply-air-temp" }
  it("follows site/building/device/point", () => {
    expect(pointTopic(parts)).toBe("site-1/building-a/ventilation-1/supply-air-temp")
    expect(metaTopic(parts)).toBe("site-1/building-a/ventilation-1/supply-air-temp/$meta")
  })
})
