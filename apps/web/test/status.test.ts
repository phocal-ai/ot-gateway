/**
 * The page's helpers: what kind of message a topic carries, by its shape, and how fresh a device is.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DeviceStatus } from "@ot-gateway/api"
import { clockTime, every, freshness, since, topicKind } from "../src/lib/status.ts"

describe("topicKind", () => {
  it("tells values, metadata, health and command results apart", () => {
    expect(topicKind("demo-site/b1/main-meter/active-power")).toBe("value")
    expect(topicKind("demo-site/b1/main-meter/active-power/$meta")).toBe("metadata")
    expect(topicKind("demo-site/b1/$gateway/main/health")).toBe("health")
    expect(topicKind("demo-site/b1/ahu-1/setpoint/$set/result")).toBe("command result")
    expect(topicKind("demo-site/b1/something")).toBe("other")
  })
})

const device = (fields: Partial<DeviceStatus>): DeviceStatus => ({
  id: "main-meter",
  protocol: "modbus-tcp",
  status: "ok",
  pollIntervalMs: 5000,
  points: [],
  ...fields
})

describe("freshness", () => {
  const now = 1_793_881_441_000

  it("is live while reads come on schedule, with no time to count", () => {
    expect(freshness(device({ lastSuccess: now - 2000 }), now)).toEqual({ _tag: "live" })
    expect(freshness(device({ lastSuccess: now - 15_000 }), now)).toEqual({ _tag: "live" })
  })

  it("is late after three intervals without a read, though the gateway still says ok", () => {
    expect(freshness(device({ lastSuccess: now - 16_000 }), now)).toEqual({ _tag: "late", lastSuccess: now - 16_000 })
    expect(freshness(device({}), now)).toEqual({ _tag: "late", lastSuccess: undefined })
  })

  it("waits at least 15 s for a fast device, so one slow cycle doesn't flag it", () => {
    expect(freshness(device({ pollIntervalMs: 1000, lastSuccess: now - 10_000 }), now)).toEqual({ _tag: "live" })
  })

  it("takes failing and starting from the gateway", () => {
    expect(freshness(device({ status: "failing", reason: "timeout", lastSuccess: now - 1000 }), now)).toEqual({
      _tag: "failing",
      reason: "timeout",
      lastSuccess: now - 1000
    })
    expect(freshness(device({ status: "starting" }), now)).toEqual({ _tag: "starting" })
  })
})

describe("the words for time", () => {
  it("says how often a device is read", () => {
    expect(every(5000)).toBe("every 5 s")
    expect(every(2500)).toBe("every 2.5 s")
    expect(every(120_000)).toBe("every 2 min")
  })

  it("counts an outage in steps that don't tick every second", () => {
    const now = 1_793_881_441_000
    expect(since(now - 12_000, now)).toBe("under a minute")
    expect(since(now - 59_000, now)).toBe("under a minute")
    expect(since(now - 4 * 60_000 - 30_000, now)).toBe("4 min")
    expect(since(now - 3 * 3_600_000, now)).toBe("3 h")
    expect(since(undefined, now)).toBe("never")
  })

  it("gives a clock time, with the date only when it isn't today", () => {
    const now = new Date(2026, 10, 5, 14, 30).getTime()
    expect(clockTime(new Date(2026, 10, 5, 14, 2, 31).getTime(), now)).toMatch(/14:02:31|2:02:31/)
    expect(clockTime(new Date(2026, 10, 4, 9, 0, 0).getTime(), now)).toMatch(/Nov.*4|4.*Nov/)
  })
})
