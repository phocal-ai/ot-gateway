/**
 * What a value means at a glance: alarms, stale against unchanged (COV) reads, and the few points a device row shows.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DeviceStatus, PointInfo, PointReading } from "@ot-gateway/api"
import {
  activeAlarms,
  alarmActive,
  alarmCount,
  alarmNote,
  alarmWhen,
  glanceKeys,
  glancePoints,
  isAlarm,
  pointFreshness,
  readLabel,
  readsOnChange,
  shownAlarms
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

  it("takes the config's alarmWhen over semantics: off is active when false or 0", () => {
    expect(isAlarm({ alarmWhen: "on" })).toBe(true)
    expect(alarmWhen({ alarmWhen: "off", brick: "Alarm" })).toBe("off")
    expect(alarmWhen({ haystack: ["alarm"] })).toBe("on")
    expect(alarmWhen({ brick: "Run_Status" })).toBeUndefined()
    const contact = { alarmWhen: "off" } as const
    expect(alarmActive(contact, false)).toBe(true)
    expect(alarmActive(contact, 0)).toBe(true)
    expect(alarmActive(contact, true)).toBe(false)
    expect(alarmActive(contact, 1)).toBe(false)
    expect(alarmActive(contact, undefined)).toBe(false)
    expect(alarmActive({ alarmWhen: "on" }, true)).toBe(true)
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

describe("readLabel", () => {
  const ts = new Date(2026, 10, 11, 15, 58, 4).getTime()
  const sameDay = new Date(2026, 10, 11, 16, 0, 0).getTime()

  it("says a stale value is the last one read, with its time to the second", () => {
    expect(readLabel(ts, sameDay, true)).toBe("last read 15:58:04")
    expect(readLabel(ts, sameDay, false)).toBe("read 15:58:04")
  })

  it("says when nothing was read", () => {
    expect(readLabel(undefined, sameDay, true)).toBe("nothing read yet")
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

const clock = (hours: number, minutes: number) => new Date(2026, 10, 11, hours, minutes, 0).getTime()

describe("shownAlarms", () => {
  const later = clock(16, 5)
  const tripped = point({ device: "energy-meter", id: "breaker", name: "Main breaker tripped", alarmWhen: "on" })
  const smoke = point({ device: "ahu-1", id: "smoke", name: "Smoke detected", alarmWhen: "on" })
  const reads = new Map<string, PointReading>([
    ["energy-meter/breaker", { device: "energy-meter", point: "breaker", value: true, ts: clock(15, 57) }],
    ["ahu-1/smoke", { device: "ahu-1", point: "smoke", value: true, ts: later - 1000 }]
  ])
  const ahu = device({ id: "ahu-1", lastSuccess: later - 1000 })
  const failingMeter = device({
    id: "energy-meter",
    status: "failing",
    reason: "timeout",
    failingSince: clock(15, 58),
    lastSuccess: clock(15, 57)
  })

  it("lists an alarm of a device that does not answer as last known, after the ones known to be on", () => {
    const devices = new Map([
      ["energy-meter", failingMeter],
      ["ahu-1", ahu]
    ])
    expect(shownAlarms([tripped, smoke], reads, devices, later, false)).toEqual([
      { point: smoke },
      { point: tripped, lastKnown: "device not answering since 15:58" }
    ])
  })

  it("lists an alarm as active while its device answers", () => {
    const answering = device({ id: "energy-meter", lastSuccess: later - 1000 })
    const fresh = new Map(reads).set("energy-meter/breaker", {
      device: "energy-meter",
      point: "breaker",
      value: true,
      ts: later - 1000
    })
    expect(shownAlarms([tripped], fresh, new Map([["energy-meter", answering]]), later, false)).toEqual([
      { point: tripped }
    ])
  })

  it("says why else a value is stale: a late device, or the gateway out of reach", () => {
    const late = device({ id: "energy-meter", lastSuccess: clock(15, 57) })
    expect(shownAlarms([tripped], reads, new Map([["energy-meter", late]]), later, false)).toEqual([
      { point: tripped, lastKnown: "device late, last read 15:57" }
    ])
    expect(shownAlarms([smoke], reads, new Map([["ahu-1", ahu]]), later, true)).toEqual([
      { point: smoke, lastKnown: "gateway not answering, last read 16:04" }
    ])
  })

  it("says last known after the name only when the headline does not", () => {
    const stale = { point: tripped, lastKnown: "device not answering since 15:58" }
    expect(alarmNote(stale, 0)).toBe("device not answering since 15:58")
    expect(alarmNote(stale, 1)).toBe("last known active, device not answering since 15:58")
    expect(alarmNote({ point: smoke }, 1)).toBeUndefined()
  })

  it("counts the last known apart from the ones known to be on", () => {
    expect(alarmCount(1)).toBe("1 alarm active")
    expect(alarmCount(0, 1)).toBe("1 alarm last known active")
    expect(alarmCount(0, 2)).toBe("2 alarms last known active")
    expect(alarmCount(2, 1)).toBe("2 alarms active, 1 last known active")
  })
})
