/**
 * The page's helpers: what kind of message a topic carries, by its shape, and how fresh a device is.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DeviceStatus } from "@ot-gateway/api"
import {
  byAttention,
  clockTime,
  duration,
  every,
  failureLabel,
  fillPercent,
  formatValue,
  freshness,
  since,
  sinceClock,
  topicKind
} from "../src/lib/status.ts"

describe("topicKind", () => {
  it("tells values, metadata, health and command results apart", () => {
    expect(topicKind("demo-site/building-a/energy-meter/active-power")).toBe("value")
    expect(topicKind("demo-site/building-a/energy-meter/active-power/$meta")).toBe("metadata")
    expect(topicKind("demo-site/building-a/$gateway/main/health")).toBe("health")
    expect(topicKind("demo-site/building-a/ventilation-1/setpoint/$set/result")).toBe("command result")
    expect(topicKind("demo-site/building-a/something")).toBe("other")
  })
})

const device = (fields: Partial<DeviceStatus>): DeviceStatus => ({
  id: "energy-meter",
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

describe("byAttention", () => {
  const now = 1_793_881_441_000

  it("puts failing, then late, then starting devices before the ones that answer, each in config order", () => {
    const devices = [
      device({ id: "ok-1", lastSuccess: now }),
      device({ id: "late", lastSuccess: now - 60_000 }),
      device({ id: "failing", status: "failing", reason: "timeout" }),
      device({ id: "ok-2", lastSuccess: now }),
      device({ id: "starting", status: "starting" })
    ]
    expect(byAttention(devices, now).map((each) => each.id)).toEqual(["failing", "late", "starting", "ok-1", "ok-2"])
  })
})

describe("failureLabel", () => {
  it("says a failure reason in words, and passes an unknown one through", () => {
    expect(failureLabel("connection")).toBe("cannot connect")
    expect(failureLabel("cycle-timeout")).toBe("read hangs")
    expect(failureLabel("something-new")).toBe("something-new")
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
    expect(clockTime(new Date(2026, 10, 5, 14, 2, 31).getTime(), now)).toBe("14:02:31")
    expect(clockTime(new Date(2026, 10, 4, 9, 0, 0).getTime(), now)).toBe("Nov 4 09:00:00")
  })
})

describe("formatValue", () => {
  it("groups thousands with a comma and writes decimals with a dot, whatever the browser's locale", () => {
    expect(formatValue(1500)).toBe("1,500")
    expect(formatValue(1.5)).toBe("1.50")
    expect(formatValue(1234.5)).toBe("1,234.5")
    expect(formatValue(-0.125)).toBe("-0.13")
    expect(formatValue(42)).toBe("42")
    expect(formatValue(true)).toBe("on")
    expect(formatValue(undefined)).toBe("–")
  })
})

describe("fillPercent", () => {
  it("never shows a buffer that holds rows as 0 %", () => {
    expect(fillPercent(1, 1_000_000)).toBe("0.1 %")
    expect(fillPercent(4_000, 1_000_000)).toBe("0.4 %")
    expect(fillPercent(370_000, 1_000_000)).toBe("37 %")
    expect(fillPercent(1_000_000, 1_000_000)).toBe("100 %")
  })
})

describe("duration", () => {
  it("says seconds under two minutes, then minutes, hours and days, to the precision that matters", () => {
    expect(duration(0)).toBe("0 s")
    expect(duration(20_400)).toBe("20 s")
    expect(duration(61_000)).toBe("61 s")
    expect(duration(119_400)).toBe("119 s")
    expect(duration(180_000)).toBe("3 min")
    expect(duration(3_600_000)).toBe("1 h")
    expect(duration(7_500_000)).toBe("2 h 5 min")
    expect(duration(86_400_000)).toBe("1 d")
    expect(duration(3 * 86_400_000 + 4 * 3_600_000 + 60_000)).toBe("3 d 4 h")
  })

  it("never goes below zero when the clocks disagree", () => {
    expect(duration(-5000)).toBe("0 s")
  })
})

describe("sinceClock", () => {
  it("gives the local clock time and how long ago", () => {
    const at = new Date(2026, 10, 5, 12, 18, 20).getTime()
    expect(sinceClock(at, at + 180_000)).toBe("12:18:20 (3 min)")
    expect(sinceClock(at, at + 20_000)).toBe("12:18:20 (20 s)")
  })
})
