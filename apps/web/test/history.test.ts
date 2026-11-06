/** Drawing a history: where lines break, and the ticks on both axes. */
import { describe, expect, it } from "@effect/vitest"
import { nearest, segments, timeTicks, valueTicks } from "../src/lib/history"

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

describe("nearest", () => {
  it("finds the bucket closest to a time", () => {
    expect(nearest([bucket(0), bucket(10), bucket(20)], 14)?.t).toBe(10)
    expect(nearest([], 14)).toBeUndefined()
  })
})
