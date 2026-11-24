/**
 * The points page's helpers: matching the search, joining live values, and the filter in the URL.
 */
import { describe, expect, it } from "@effect/vitest"
import type { GatewayStatus, PointInfo } from "@ot-gateway/api"
import {
  chunkKeys,
  devicesById,
  devicesOf,
  filterFromSearch,
  filterToSearch,
  matches,
  matchesWords,
  noFilter,
  pointKey,
  pointTitle,
  titledById,
  withReadings
} from "../src/lib/points.ts"

const point = (fields: Partial<PointInfo>): PointInfo => ({
  device: "ahu-1",
  id: "supply-temp",
  name: "Supply air temperature",
  writable: false,
  topic: "site/b/ahu-1/supply-temp",
  source: "analog-input 3 · present-value",
  read: "on change of value where the device supports it, polled every 5 s otherwise",
  cov: true,
  publish: "every read",
  ...fields
})

describe("matches", () => {
  it("finds a point by every word of the query, anywhere in what it is, case ignored", () => {
    const supply = point({ brick: "Supply_Air_Temperature_Sensor", haystack: ["discharge", "air", "temp"] })
    expect(matches(supply, { ...noFilter, query: "AHU temp" })).toBe(true)
    expect(matches(supply, { ...noFilter, query: "analog-input 3" })).toBe(true)
    expect(matches(supply, { ...noFilter, query: "supply_air" })).toBe(true)
    expect(matches(supply, { ...noFilter, query: "discharge" })).toBe(true)
    expect(matches(supply, { ...noFilter, query: "ahu humidity" })).toBe(false)
    expect(matches(supply, { ...noFilter, query: "   " })).toBe(true)
  })

  it("narrows by device", () => {
    expect(matches(point({}), { ...noFilter, device: "ahu-1" })).toBe(true)
    expect(matches(point({}), { ...noFilter, device: "meter" })).toBe(false)
  })
})

describe("devicesById and withReadings", () => {
  it("looks devices up by id, and keeps what was read before under what was read now", () => {
    const status: GatewayStatus = {
      site: "site",
      building: "b",
      id: "main",
      since: 0,
      now: 1,
      configSince: 0,
      broker: {
        url: "mqtt://broker",
        connected: true,
        connects: 1,
        failedConnects: 0,
        published: 0,
        publishFailures: 0
      },
      commands: [],
      devices: [
        { id: "ahu-1", protocol: "bacnet-ip", status: "failing", pollIntervalMs: 5000, pointCount: 1, points: [] }
      ]
    }
    expect(devicesById(status).get("ahu-1")?.status).toBe("failing")
    expect(devicesById(undefined).size).toBe(0)

    const first = withReadings(new Map(), [
      { device: "ahu-1", point: "supply-temp", value: 21.5, ts: 1 },
      { device: "ahu-1", point: "fan", value: true, ts: 1 }
    ])
    const second = withReadings(first, [{ device: "ahu-1", point: "supply-temp", value: 22, ts: 2 }])
    expect(second.get(pointKey(point({})))?.value).toBe(22)
    expect(second.get("ahu-1/fan")?.value).toBe(true)
    // The earlier map is left as it was: React state.
    expect(first.get("ahu-1/supply-temp")?.value).toBe(21.5)
  })
})

describe("chunkKeys", () => {
  it("splits keys into requests by count and by URL length, in order", () => {
    const keys = ["a/1", "a/2", "a/3", "a/4", "a/5"]
    expect(chunkKeys(keys, { maxKeys: 2, maxChars: 1000 })).toEqual([["a/1", "a/2"], ["a/3", "a/4"], ["a/5"]])
    expect(chunkKeys(keys, { maxKeys: 100, maxChars: 8 })).toEqual([["a/1", "a/2"], ["a/3", "a/4"], ["a/5"]])
    expect(chunkKeys([])).toEqual([])
  })

  it("keeps every request under 500 keys by default", () => {
    const keys = Array.from({ length: 1200 }, (_, index) => `d/${index}`)
    const chunks = chunkKeys(keys)
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true)
    expect(chunks.flat()).toEqual(keys)
  })
})

describe("the filter in the URL", () => {
  it("leaves defaults out and reads back what it wrote", () => {
    expect(filterToSearch(noFilter, undefined)).toBe("")
    const filter = { query: "supply temp", device: "ahu-1" }
    const search = filterToSearch(filter, "ahu-1/supply-temp")
    expect(search).toBe("?q=supply+temp&device=ahu-1&point=ahu-1%2Fsupply-temp")
    expect(filterFromSearch(search)).toEqual({ filter, open: "ahu-1/supply-temp" })
    expect(filterFromSearch("")).toEqual({ filter: noFilter })
  })
})

describe("devicesOf", () => {
  it("lists each device once, in config order, with its number of points", () => {
    const catalog = { points: [point({ device: "b" }), point({ device: "a" }), point({ device: "b", id: "x" })] }
    expect(devicesOf(catalog)).toEqual([
      { id: "b", points: 2 },
      { id: "a", points: 1 }
    ])
  })
})

describe("matchesWords", () => {
  it("needs every word somewhere in the text, in any order and case", () => {
    expect(matchesWords("heat-pump BACnet/IP", "bacnet heat")).toBe(true)
    expect(matchesWords("heat-pump BACnet/IP", "modbus")).toBe(false)
    expect(matchesWords("anything", "")).toBe(true)
  })
})

describe("pointTitle", () => {
  it("is the name people read, the id when there is no name", () => {
    expect(pointTitle(point({}))).toBe("Supply air temperature")
    expect(pointTitle(point({ name: "  " }))).toBe("supply-temp")
    expect(titledById(point({ name: "" }))).toBe(true)
    expect(titledById(point({ name: "supply-temp" }))).toBe(true)
    expect(titledById(point({}))).toBe(false)
  })
})
