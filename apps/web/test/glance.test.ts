/**
 * What a value means at a glance: alarms, stale against unchanged (COV) reads, and the few points a device row shows.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DeviceStatus, PointInfo, PointReading } from "@ot-gateway/api"
import {
  activeAlarms,
  alarmActive,
  alarmCount,
  glanceKeys,
  glancePoints,
  isAlarm,
  pointFreshness,
  readsOnChange
} from "../src/lib/glance.ts"

const polled = { read: "polled every 5 s", cov: false }
const cov = { read: "on change of value where the device supports it, polled every 5 s otherwise", cov: true }

const point = (fields: Partial<PointInfo>): PointInfo => ({
  device: "meter",
  id: "power",
  name: "Active power",
  writable: false,
  topic: "site/b/meter/power",
  source: "holding 0 · float32",
  ...polled,
  publish: "every read",
  ...fields
})

const now = 1_000_000

const device = (fields: Partial<DeviceStatus> = {}): DeviceStatus => ({
  id: "meter",
  protocol: "bacnet-ip",
  status: "ok",
  pollIntervalMs: 5000,
  lastSuccess: now - 1000,
  pointCount: 1,
  points: [],
  ...fields
})

const readings = (entries: ReadonlyArray<readonly [PointInfo, number | boolean]>) =>
  new Map<string, PointReading>(
    entries.map(([p, value]) => [`${p.device}/${p.id}`, { device: p.device, point: p.id, value, ts: now }])
  )

describe("isAlarm and alarmActive", () => {
  it("knows an alarm by its Brick class or its Haystack tag", () => {
    expect(isAlarm({ brick: "Alarm" })).toBe(true)
    expect(isAlarm({ brick: "Smoke_Detection_Alarm" })).toBe(true)
    expect(isAlarm({ haystack: ["elec", "breaker", "alarm"] })).toBe(true)
    expect(isAlarm({ brick: "Run_Status", haystack: ["compressor", "run", "sensor"] })).toBe(false)
    expect(isAlarm({})).toBe(false)
  })

  it("calls an alarm on when it is true or a number other than 0, and a running compressor never", () => {
    const breaker = { brick: "Alarm" }
    expect(alarmActive(breaker, true)).toBe(true)
    expect(alarmActive(breaker, 1)).toBe(true)
    expect(alarmActive(breaker, false)).toBe(false)
    expect(alarmActive(breaker, 0)).toBe(false)
    expect(alarmActive(breaker, undefined)).toBe(false)
    expect(alarmActive({ brick: "Run_Status" }, true)).toBe(false)
  })
})

describe("readsOnChange", () => {
  it("reads the catalog's flag", () => {
    expect(readsOnChange(cov)).toBe(true)
    expect(readsOnChange(polled)).toBe(false)
  })
})

const at = (ts: number) => ({ value: 1, ts })

describe("pointFreshness", () => {
  it("is fresh while read on schedule, and none before the first read", () => {
    expect(pointFreshness(point({}), { value: at(now - 2000), device: device() }, now, false)._tag).toBe("fresh")
    expect(pointFreshness(point({}), { value: undefined, device: device() }, now, false)._tag).toBe("none")
  })

  it("calls an old COV read unchanged while its device answers, and an old polled read stale", () => {
    const old = { value: at(now - 10 * 60_000), device: device() }
    expect(pointFreshness(point(cov), old, now, false)).toEqual({ _tag: "unchanged", ts: now - 10 * 60_000 })
    expect(pointFreshness(point(polled), old, now, false)._tag).toBe("stale")
  })

  it("calls every read stale while its device fails or is late, or the gateway is not reached", () => {
    const value = at(now - 2000)
    const failing = device({ status: "failing", reason: "timeout" })
    const late = device({ lastSuccess: now - 60_000 })
    expect(pointFreshness(point(cov), { value, device: failing }, now, false)._tag).toBe("stale")
    expect(pointFreshness(point(cov), { value, device: late }, now, false)._tag).toBe("stale")
    expect(pointFreshness(point(cov), { value, device: device() }, now, true)._tag).toBe("stale")
  })

  it("does not dim the reads of a device that is only starting", () => {
    const starting = device({ status: "starting" })
    expect(pointFreshness(point({}), { value: at(now - 60_000), device: starting }, now, false)._tag).toBe("fresh")
  })
})

describe("glanceKeys, glancePoints and activeAlarms", () => {
  const meter = [1, 2, 3, 4, 5, 6].map((n) => point({ id: `p${n}` }))
  const breaker = point({ id: "breaker-tripped", brick: "Alarm" })
  const heatPump = [point({ device: "heat-pump", id: "flow-temp" }), point({ device: "heat-pump", id: "running" })]
  const catalog = [...meter, breaker, ...heatPump]

  it("asks for the first few points of the listed devices and every alarm point", () => {
    expect(glanceKeys(catalog, ["heat-pump"], 4)).toEqual([
      "heat-pump/flow-temp",
      "heat-pump/running",
      "meter/breaker-tripped"
    ])
    expect(glanceKeys(catalog, ["meter"], 2)).toEqual(["meter/p1", "meter/p2", "meter/breaker-tripped"])
  })

  it("puts an alarm that is on first, and counts the rest for the Points tab", () => {
    const devicePoints = [...meter, breaker]
    expect(glancePoints(devicePoints, readings([[breaker, false]]), 4)).toEqual({
      shown: meter.slice(0, 4),
      more: 3
    })
    expect(glancePoints(devicePoints, readings([[breaker, true]]), 4)).toEqual({
      shown: [breaker, ...meter.slice(0, 3)],
      more: 3
    })
    expect(glancePoints(heatPump, new Map(), 4)).toEqual({ shown: heatPump, more: 0 })
  })

  it("lists the alarms that are on", () => {
    expect(activeAlarms(catalog, readings([[breaker, true]]))).toEqual([breaker])
    expect(activeAlarms(catalog, readings([[breaker, false]]))).toEqual([])
    expect(alarmCount(1)).toBe("1 alarm active")
    expect(alarmCount(2)).toBe("2 alarms active")
  })
})
