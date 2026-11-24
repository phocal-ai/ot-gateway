/**
 * The guided first run on the Status tab: which step is next, and when the guide shows.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DeviceStatus, GatewayStatus, PointInfo, PointReading } from "@ot-gateway/api"
import { FIRST_VALUES, firstRunView, firstValuePoints, showsGuide } from "../src/lib/first-run.ts"

const device = (fields: Partial<DeviceStatus> = {}): DeviceStatus => ({
  id: "heat-pump",
  protocol: "bacnet-ip",
  status: "starting",
  pollIntervalMs: 5000,
  pointCount: 1,
  points: [],
  ...fields
})

const gateway = (connected: boolean, devices: ReadonlyArray<DeviceStatus>): GatewayStatus => ({
  site: "site",
  building: "b",
  id: "main",
  since: 0,
  now: 1,
  configSince: 0,
  broker: { url: "mqtt://broker", connected, connects: 1, failedConnects: 0, published: 0, publishFailures: 0 },
  commands: [],
  devices
})

const point = (id: string): PointInfo => ({
  device: "heat-pump",
  id,
  name: id,
  writable: false,
  topic: `site/b/heat-pump/${id}`,
  source: "analog-input 1",
  read: "polled every 5 s",
  cov: false,
  publish: "every read"
})

const flow = point("flow")
const reading = (value: number): ReadonlyMap<string, PointReading> =>
  new Map([["heat-pump/flow", { device: "heat-pump", point: "flow", value, ts: 1 }]])

describe("firstRunView", () => {
  it("starts with the broker while it is not connected", () => {
    expect(firstRunView(gateway(false, []), new Map(), [])).toEqual({
      broker: false,
      devices: false,
      arrived: 0,
      answered: false,
      next: 1
    })
  })

  it("asks for devices once the broker is connected", () => {
    expect(firstRunView(gateway(true, []), new Map(), []).next).toBe(2)
  })

  it("waits for values until every device answered and one value arrived", () => {
    expect(firstRunView(gateway(true, [device()]), new Map(), [flow]).next).toBe(3)
    expect(firstRunView(gateway(true, [device({ lastSuccess: 1 })]), new Map(), [flow]).next).toBe(3)
    expect(firstRunView(gateway(true, [device()]), reading(41.5), [flow]).next).toBe(3)
    const done = firstRunView(gateway(true, [device({ lastSuccess: 1 })]), reading(41.5), [flow])
    expect(done).toMatchObject({ arrived: 1, answered: true, next: "done" })
  })

  it("is not done while a second device has never answered", () => {
    const devices = [device({ lastSuccess: 1 }), device({ id: "meter", protocol: "modbus-tcp" })]
    expect(firstRunView(gateway(true, devices), reading(41.5), [flow]).next).toBe(3)
  })
})

describe("showsGuide", () => {
  it("shows without devices, and with devices only while it was started", () => {
    expect(showsGuide(0, false)).toBe(true)
    expect(showsGuide(2, false)).toBe(false)
    expect(showsGuide(2, true)).toBe(true)
  })
})

describe("firstValuePoints", () => {
  it("keeps the first few points", () => {
    const points = Array.from({ length: FIRST_VALUES + 3 }, (_, index) => point(`p-${index}`))
    expect(firstValuePoints(points).map((each) => each.id)).toEqual(
      points.slice(0, FIRST_VALUES).map((each) => each.id)
    )
  })
})
