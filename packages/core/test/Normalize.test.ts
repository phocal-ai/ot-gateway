import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import { applyScaling, exceedsDeadband, metaTopic, pointTopic } from "../src/index.ts"

describe("applyScaling", () => {
  it("is the identity without scaling", () => {
    expect(applyScaling(42, undefined)).toBe(42)
  })
  it("applies factor and offset", () => {
    expect(applyScaling(215, { factor: 0.1, offset: -1.5 })).toBeCloseTo(20)
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
  const parts = { site: "site-1", building: "building-a", device: "ahu-1", point: "sat" }
  it("follows site/building/device/point", () => {
    expect(pointTopic(parts)).toBe("site-1/building-a/ahu-1/sat")
    expect(metaTopic(parts)).toBe("site-1/building-a/ahu-1/sat/$meta")
  })
})
