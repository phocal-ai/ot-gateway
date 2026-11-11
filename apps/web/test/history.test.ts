/** Drawing a history: where lines break, and the ticks on both axes. */
import { describe, expect, it } from "@effect/vitest"
import {
  axisFrom,
  bucketTime,
  gatewayTime,
  nearest,
  segments,
  timeLabel,
  timeTicks,
  valueTicks
} from "../src/lib/history"

const bucket = (t: number, avg = 1) => ({ t, min: avg, max: avg, avg, count: 1 })

describe("segments", () => {
  it("keeps consecutive buckets in one run", () => {
    expect(segments([bucket(0), bucket(10), bucket(20)], 10)).toHaveLength(1)
  })

  it("breaks the line where buckets are missing for more than two steps", () => {
    const runs = segments([bucket(0), bucket(10), bucket(50), bucket(60)], 10)
    expect(runs.map((run) => run.map((b) => b.t))).toEqual([
      [0, 10],
      [50, 60]
    ])
  })

  it("has no runs without buckets", () => {
    expect(segments([], 10)).toEqual([])
  })
})

describe("valueTicks", () => {
  it("steps by 1, 2 or 5 times a power of ten and covers the range", () => {
    expect(valueTicks(18.3, 23.9)).toEqual([18, 20, 22, 24])
    expect(valueTicks(0, 100)).toEqual([0, 50, 100])
    expect(valueTicks(-3, 7)).toEqual([-5, 0, 5, 10])
  })

  it("does not produce floating-point noise", () => {
    for (const tick of valueTicks(0.1, 0.7)) expect(String(tick).length).toBeLessThan(6)
  })

  it("pads a flat line so it has an axis", () => {
    const ticks = valueTicks(21, 21)
    expect(ticks[0]).toBeLessThan(21)
    expect(ticks.at(-1)).toBeGreaterThan(21)
  })

  it("ends for a range with no reads in it, whose min and max are ±Infinity", () => {
    expect(valueTicks(Math.min(), Math.max())).toEqual([0, 1])
    expect(valueTicks(Number.NaN, 1)).toEqual([0, 1])
  })
})

describe("timeTicks", () => {
  it("puts about five ticks on round times inside the range", () => {
    const from = Date.UTC(2026, 10, 5, 10, 7)
    const to = from + 3_600_000
    const { ticks, step } = timeTicks(from, to)
    expect(step).toBe(900_000)
    expect(ticks.length).toBeGreaterThanOrEqual(4)
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(from)
      expect(tick).toBeLessThanOrEqual(to)
    }
  })
})

describe("timeLabel and bucketTime", () => {
  it("use the 24-hour clock like the rest of the page", () => {
    const afternoon = new Date(2026, 10, 5, 14, 5, 24).getTime()
    expect(timeLabel(afternoon, 900_000)).toBe("14:05")
    expect(bucketTime(afternoon, 15_000)).toMatch(/14:05:24$/)
    expect(bucketTime(afternoon, 60_000)).toMatch(/14:05$/)
    expect(timeLabel(new Date(2026, 10, 5, 0, 30).getTime(), 900_000)).toBe("00:30")
  })
})

describe("axisFrom", () => {
  const to = 10_000_000
  const from = to - 3_600_000
  const step = 15_000
  const series = (times: ReadonlyArray<number>) => ({ from, to, stepMs: step, buckets: times.map((t) => bucket(t)) })

  it("starts where the gateway started when its history begins there", () => {
    const startedAt = to - 600_000
    expect(axisFrom(series([startedAt, startedAt + step]), startedAt)).toBe(startedAt)
  })

  it("keeps a few minutes of room for a line that just began", () => {
    const startedAt = to - 30_000
    expect(axisFrom(series([startedAt]), startedAt)).toBe(to - 300_000)
  })

  it("keeps the whole range when older history leaves a gap where the gateway was off", () => {
    const startedAt = to - 600_000
    expect(axisFrom(series([from, startedAt]), startedAt)).toBe(from)
  })

  it("keeps the whole range for a gateway that started before it, or without reads", () => {
    expect(axisFrom(series([to - 600_000]), from - 1)).toBe(from)
    expect(axisFrom(series([]), to - 600_000)).toBe(from)
    expect(axisFrom(series([to - 600_000]), undefined)).toBe(from)
  })
})

describe("nearest", () => {
  it("finds the bucket closest to a time", () => {
    expect(nearest([bucket(0), bucket(10), bucket(20)], 14)?.t).toBe(10)
    expect(nearest([], 14)).toBeUndefined()
  })
})

describe("gatewayTime", () => {
  it("is the gateway's last time, moved on by the monotonic time since it arrived", () => {
    // The browser's own clock (a day off here) plays no part.
    expect(gatewayTime({ now: 1_000_000, at: 500 }, 500)).toBe(1_000_000)
    expect(gatewayTime({ now: 1_000_000, at: 500 }, 2_500)).toBe(1_002_000)
  })
})
