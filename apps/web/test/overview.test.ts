import { describe, expect, it } from "@effect/vitest"
import type { BufferStatus, DeviceStatus } from "@ot-gateway/api"
import {
  addSample,
  type BufferSample,
  bufferRate,
  bufferView,
  deviceCounts,
  dropReasons,
  protocolCounts,
  reconnects,
  roughly
} from "../src/lib/overview.ts"

const device = (fields: Partial<DeviceStatus>): DeviceStatus => ({
  id: "meter",
  protocol: "modbus-tcp",
  status: "ok",
  pollIntervalMs: 5000,
  lastSuccess: 100_000,
  pointCount: 3,
  points: [],
  ...fields
})

describe("deviceCounts", () => {
  it("counts devices as the list shows them, a stalled one as late", () => {
    const now = 100_000
    expect(
      deviceCounts(
        [
          device({}),
          device({ id: "b", status: "starting" }),
          device({ id: "c", lastSuccess: now - 60_000 }),
          device({ id: "d", status: "failing", reason: "timeout" })
        ],
        now
      )
    ).toEqual({ live: 1, starting: 1, late: 1, failing: 1 })
  })
})

describe("protocolCounts", () => {
  it("adds up devices and points per protocol, the most devices first", () => {
    expect(
      protocolCounts([
        device({ protocol: "bacnet-ip", pointCount: 4 }),
        device({ id: "b", pointCount: 2 }),
        device({ id: "c", pointCount: 5 })
      ])
    ).toEqual([
      { protocol: "modbus-tcp", name: "Modbus TCP", devices: 2, points: 7 },
      { protocol: "bacnet-ip", name: "BACnet/IP", devices: 1, points: 4 }
    ])
  })
})

describe("dropReasons", () => {
  it("names the reasons something was dropped for, most first, and leaves out the rest", () => {
    expect(dropReasons({ overflow: 2, rejected: 5, lost: 0, mystery: 1 })).toEqual([
      { reason: "rejected", count: 5, words: "the broker refused them" },
      { reason: "overflow", count: 2, words: "the buffer was full, so the oldest were dropped" },
      { reason: "mystery", count: 1, words: "mystery" }
    ])
  })
})

describe("reconnects", () => {
  it("counts every connect after the first", () => {
    expect(reconnects(0)).toBe(0)
    expect(reconnects(1)).toBe(0)
    expect(reconnects(4)).toBe(3)
  })
})

const buffer = (fields: Partial<BufferStatus>): BufferStatus => ({
  path: "/data/buffer.sqlite",
  rows: 0,
  maxRows: 1_000_000,
  dropped: 0,
  written: 0,
  delivered: 0,
  droppedBy: {},
  failures: 0,
  disabled: false,
  ...fields
})

/** Polls every 2 s from `rows`, growing by `perPoll`. */
const polls = (count: number, rows: number, perPoll: number) => {
  let samples: ReadonlyArray<BufferSample> = []
  for (let index = 0; index < count; index++)
    samples = addSample(samples, { at: 1_000_000 + index * 2000, since: 1, rows: rows + index * perPoll })
  return samples
}

describe("bufferRate", () => {
  it("is unknown until the polls span ten seconds", () => {
    expect(bufferRate(polls(3, 0, 100))).toBeUndefined()
    expect(bufferRate(polls(6, 0, 100))).toBe(50)
  })

  it("keeps a minute of polls, so a burst long ago does not count", () => {
    const samples = polls(60, 0, 100)
    expect(samples).toHaveLength(31)
    expect(bufferRate(samples)).toBe(50)
  })

  it("starts over when the gateway restarted or its clock went back", () => {
    const samples = polls(10, 0, 100)
    expect(addSample(samples, { at: 2_000_000, since: 2, rows: 0 })).toHaveLength(1)
    expect(addSample(samples, { at: 900_000, since: 1, rows: 0 })).toHaveLength(1)
  })

  it("does not count the same poll twice", () => {
    const samples = polls(3, 0, 100)
    expect(addSample(samples, { at: 1_004_000, since: 1, rows: 200 })).toBe(samples)
  })
})

describe("roughly", () => {
  it("rounds a time ahead to what an estimate can say", () => {
    expect(roughly(20_000)).toBe("under a minute")
    expect(roughly(4.4 * 60_000)).toBe("about 4 min")
    expect(roughly(3 * 3_600_000)).toBe("about 3 h")
    expect(roughly(3 * 86_400_000)).toBe("about 3 days")
  })
})

describe("bufferView", () => {
  it("says nothing waits while the broker takes everything", () => {
    expect(bufferView(buffer({}), true, undefined)).toEqual({
      title: "Nothing waiting",
      note: "values go straight to the broker",
      bad: false,
      dropped: 0
    })
  })

  it("says when it will be full while the broker is away", () => {
    // 900,000 rows of room at 5 a second: 50 hours.
    expect(bufferView(buffer({ rows: 100_000 }), false, 5)).toMatchObject({
      title: "100,000 waiting",
      note: "full in about 2 days at this rate"
    })
    expect(bufferView(buffer({ rows: 100_000 }), false, undefined).note).toBe("for the broker to be back")
  })

  it("says how long the backlog takes once the broker is back", () => {
    expect(bufferView(buffer({ rows: 12_000 }), true, -100).note).toBe("sending, about 2 min left")
    expect(bufferView(buffer({ rows: 12_000 }), true, 3).note).toBe("sending to the broker")
  })

  it("calls a full or failed buffer bad, and no buffer bad only while the broker is away", () => {
    expect(bufferView(buffer({ rows: 1_000_000, dropped: 40 }), false, 5)).toEqual({
      title: "Full",
      note: "the oldest values are being dropped",
      bad: true,
      dropped: 40
    })
    expect(bufferView(buffer({ disabled: true }), true, undefined)).toMatchObject({ title: "Failed", bad: true })
    expect(bufferView(undefined, true, undefined)).toMatchObject({ title: "Off", bad: false })
    expect(bufferView(undefined, false, undefined)).toMatchObject({ title: "Off", bad: true })
  })

  it("keeps past drops apart from what waits now", () => {
    expect(bufferView(buffer({ dropped: 2300 }), true, undefined)).toMatchObject({
      title: "Nothing waiting",
      bad: false,
      dropped: 2300
    })
  })
})
