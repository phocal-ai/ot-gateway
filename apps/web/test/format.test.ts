/**
 * Numbers and topics as the page writes them.
 */
import { describe, expect, it } from "@effect/vitest"
import { formatNumber, topicParts } from "../src/lib/format.ts"

describe("formatNumber", () => {
  it("groups thousands the same way in every browser", () => {
    expect(formatNumber(1500.25)).toBe("1,500.25")
    expect(formatNumber(1.5, 2)).toBe("1.50")
  })
})

describe("topicParts", () => {
  it("cuts a topic after each slash, so it wraps between names, and joins back to the topic", () => {
    const topic = "…/energy-meter/main-breaker-setpoint/$set"
    expect(topicParts(topic)).toEqual(["…/", "energy-meter/", "main-breaker-setpoint/", "$set"])
    expect(topicParts(topic).join("")).toBe(topic)
    expect(topicParts("power")).toEqual(["power"])
  })
})
