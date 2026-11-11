/** Drawing a history: where lines break, and the ticks on both axes. */
import { describe, expect, it } from "@effect/vitest"
import {
  axisFrom,
  bucketTime,
  chartGaps,
  failuresOf,
  gapAt,
  gapSentence,
  gatewayTime,
  heldUntil,
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

const event = (id: number, at: number, type: "device-failing" | "device-recovered", device = "energy-meter") =>
  type === "device-failing"
    ? ({ id, at, type, device, reason: "timeout", error: "" } as const)
    : ({ id, at, type, device, downMs: 0 } as const)

const clock = (hours: number, minutes: number) => new Date(2026, 10, 11, hours, minutes).getTime()

describe("failuresOf", () => {
  it("pairs each failure with the next recovery of the same device, the last one open while it fails", () => {
    const events = [
      event(1, 100, "device-failing"),
      event(2, 150, "device-failing", "heat-pump"),
      event(3, 200, "device-recovered"),
      event(4, 300, "device-failing")
    ]
    expect(failuresOf(events, "energy-meter")).toEqual([{ from: 100, to: 200 }, { from: 300 }])
    expect(failuresOf(events, "heat-pump")).toEqual([{ from: 150 }])
    expect(failuresOf(events, "boiler")).toEqual([])
  })
})

describe("chartGaps", () => {
  const step = 10_000
  const series = (buckets: ReadonlyArray<number>, from = 0, to = 300_000) => ({
    device: "energy-meter",
    point: "power",
    from,
    to,
    stepMs: step,
    resolution: "read" as const,
    buckets: buckets.map((t) => bucket(t))
  })
  const every = (from: number, to: number) =>
    Array.from({ length: (to - from) / step }, (_, index) => from + index * step)

  it("finds where the line breaks and names a device failure that overlaps it", () => {
    const gaps = chartGaps(series([...every(0, 100_000), ...every(220_000, 300_000)]), 0, {
      failures: [{ from: 105_000, to: 215_000 }]
    })
    expect(gaps).toEqual([{ from: 100_000, to: 220_000, cause: { kind: "device-failing" } }])
  })

  it("leaves a gap without a known cause unexplained, and ignores a single missing bucket, as the line does", () => {
    const gaps = chartGaps(series([...every(0, 100_000), ...every(110_000, 200_000), ...every(250_000, 300_000)]), 0)
    expect(gaps).toEqual([{ from: 200_000, to: 250_000 }])
  })

  it("runs a gap to the end of the range while the device still fails", () => {
    const gaps = chartGaps(series(every(0, 200_000)), 0, { failures: [{ from: 205_000 }] })
    expect(gaps).toEqual([{ from: 200_000, to: 300_000, cause: { kind: "device-failing" } }])
  })

  it("splits a gap at the gateway's start when older history is on the axis, claiming only the restart", () => {
    const gaps = chartGaps(series([...every(0, 50_000), ...every(200_000, 300_000)]), 0, {
      startedAt: 120_000,
      failures: [{ from: 125_000, to: 195_000 }]
    })
    expect(gaps).toEqual([
      { from: 50_000, to: 120_000, cause: { kind: "gateway-restart", at: 120_000 } },
      { from: 120_000, to: 200_000, cause: { kind: "device-failing" } }
    ])
  })

  it("gives a gap that ends where the gateway restarted the restart, not a whole span of not running", () => {
    // The device stopped answering at 100 s in the previous run; the gateway restarted at 220 s and read at once.
    const exact = {
      ...series([]),
      buckets: [
        ...every(0, 100_000).map((t) => ({ ...bucket(t), first: t + 1_000, last: t + 1_000 })),
        ...every(220_000, 300_000).map((t) => ({ ...bucket(t), first: t + 500, last: t + 500 }))
      ]
    }
    expect(chartGaps(exact, 0, { startedAt: 220_200 })).toEqual([
      { from: 91_000, to: 220_500, cause: { kind: "gateway-restart", at: 220_200 } }
    ])
    // Without read times, the next bucket starts a little before the start: still the restart.
    expect(chartGaps(series([...every(0, 100_000), ...every(220_000, 300_000)]), 0, { startedAt: 224_000 })).toEqual([
      { from: 100_000, to: 220_000, cause: { kind: "gateway-restart", at: 224_000 } }
    ])
  })

  it("gives no cause to a gap inside an older run: the page has no events from it", () => {
    const gaps = chartGaps(series([...every(0, 50_000), ...every(100_000, 150_000), ...every(250_000, 300_000)]), 0, {
      startedAt: 250_000
    })
    expect(gaps).toEqual([
      { from: 50_000, to: 100_000 },
      { from: 150_000, to: 250_000, cause: { kind: "gateway-restart", at: 250_000 } }
    ])
  })

  it("adds no gateway-not-running band when the axis starts at the gateway's start (its note says so)", () => {
    const answer = series(every(200_000, 300_000), 0, 300_000)
    // A gateway that started at 150 s, its device answering from 200 s: the axis starts at the start.
    const from = 150_000
    expect(chartGaps(answer, from, { startedAt: 150_000 })).toEqual([{ from: 150_000, to: 200_000 }])
    const soon = series(every(160_000, 300_000), 0, 300_000)
    expect(chartGaps(soon, from, { startedAt: 150_000 })).toEqual([])
  })

  it("runs a gap from the last read before it to the first read after it when the buckets say when they came", () => {
    const exact = {
      ...series([]),
      buckets: [
        ...every(0, 100_000).map((t) => ({ ...bucket(t), first: t + 1_000, last: t + 6_000 })),
        ...every(220_000, 300_000).map((t) => ({ ...bucket(t), first: t + 3_000, last: t + 8_000 }))
      ]
    }
    expect(chartGaps(exact, 0, { failures: [{ from: 97_000, to: 223_000 }] })).toEqual([
      { from: 96_000, to: 223_000, cause: { kind: "device-failing" } }
    ])
  })

  it("falls back to the bucket edges on a side whose bucket does not say when its read came", () => {
    const mixed = {
      ...series([]),
      buckets: [...every(0, 100_000).map((t) => bucket(t)), { ...bucket(220_000), first: 224_500, last: 224_500 }]
    }
    expect(chartGaps(mixed, 0)).toEqual([
      { from: 100_000, to: 224_500 },
      { from: 224_500, to: 300_000 }
    ])
  })

  it("has no gaps without buckets (the chart says there are no reads)", () => {
    expect(chartGaps(series([]), 0)).toEqual([])
  })

  it("finds the gap under the pointer", () => {
    const gaps = [{ from: 100, to: 200 }]
    expect(gapAt(gaps, 150)).toEqual({ from: 100, to: 200 })
    expect(gapAt(gaps, 200)).toBeUndefined()
  })
})

describe("gapSentence", () => {
  it("says when there were no reads and why", () => {
    const gap = { from: clock(15, 58), to: clock(16, 0), cause: { kind: "device-failing" } as const }
    expect(gapSentence(gap, "energy-meter", clock(16, 10))).toBe("No reads 15:58–16:00: energy-meter not answering")
    expect(
      gapSentence(
        { from: clock(9, 0), to: clock(9, 30), cause: { kind: "gateway-restart", at: clock(9, 30) } },
        "m",
        clock(16, 0)
      )
    ).toBe("No reads 09:00–09:30, until the gateway restarted at 09:30")
    expect(gapSentence({ from: clock(15, 0), to: clock(15, 5) }, "m", clock(16, 0))).toBe("No reads 15:00–15:05")
  })

  it("gives the exact edges of a gap from read times to the second when it is short", () => {
    const last = new Date(2026, 10, 11, 15, 58, 13).getTime()
    const first = new Date(2026, 10, 11, 15, 59, 41).getTime()
    expect(gapSentence({ from: last, to: first, cause: { kind: "device-failing" } }, "m", clock(16, 10))).toBe(
      "No reads 15:58:13–15:59:41: m not answering"
    )
  })

  it("gives the restart to the second for a short gap", () => {
    const from = new Date(2026, 10, 11, 18, 6, 22).getTime()
    const at = new Date(2026, 10, 11, 18, 7, 40).getTime()
    expect(gapSentence({ from, to: at, cause: { kind: "gateway-restart", at } }, "m", clock(18, 10))).toBe(
      "No reads 18:06:22–18:07:40, until the gateway restarted at 18:07:40"
    )
  })

  it("gives seconds for a gap under two minutes", () => {
    const from = new Date(2026, 10, 11, 16, 8, 20).getTime()
    expect(gapSentence({ from, to: from + 40_000 }, "m", clock(16, 10))).toBe("No reads 16:08:20–16:09:00")
  })

  it("says since when for a gap that lasts, and the weekday for another day", () => {
    expect(gapSentence({ from: clock(15, 58), to: clock(16, 10) }, "m", clock(16, 10))).toBe("No reads since 15:58")
    const yesterday = new Date(2026, 10, 10, 23, 0).getTime()
    expect(gapSentence({ from: yesterday, to: clock(1, 0) }, "m", clock(16, 0))).toBe("No reads Tue 23:00–01:00")
  })
})

describe("a point read on change of value", () => {
  const step = 10_000
  const covSeries = (buckets: ReadonlyArray<number>, to = 300_000) => ({
    device: "heat-pump",
    point: "supply-temp",
    from: 0,
    to,
    stepMs: step,
    resolution: "read" as const,
    buckets: buckets.map((t) => bucket(t))
  })

  it("has no gap where it kept still while its device answered, and its line goes on across it", () => {
    const series = covSeries([0, 10_000, 150_000, 160_000])
    const gaps = chartGaps(series, 0, { cov: true })
    expect(gaps).toEqual([])
    expect(segments(series.buckets, step, gaps)).toHaveLength(1)
    expect(heldUntil(series.buckets, gaps, series.to, true)).toBe(300_000)
    // The same stretch on a polled point is a gap that breaks the line.
    expect(chartGaps(series, 0)).toEqual([
      { from: 20_000, to: 150_000 },
      { from: 170_000, to: 300_000 }
    ])
    expect(heldUntil(series.buckets, chartGaps(series, 0), series.to, false)).toBeUndefined()
  })

  it("keeps only the failure's part of a quiet stretch, from the last good read to the recovery", () => {
    const series = covSeries([0, 10_000, 250_000])
    const failures = [{ from: 108_000, to: 200_000, lastReadAt: 100_000 }]
    const gaps = chartGaps(series, 0, { cov: true, failures })
    expect(gaps).toEqual([{ from: 100_000, to: 200_000, cause: { kind: "device-failing" } }])
    // The failure breaks the line; the quiet stretch after it, to the end, does not.
    expect(segments(series.buckets, step, gaps)).toHaveLength(2)
    const [before, after] = segments(series.buckets, step, gaps)
    // Its value holds up to the failure's last good read, and after the recovery to the end.
    expect(heldUntil(before ?? [], gaps, series.to, true)).toBe(100_000)
    expect(heldUntil(after ?? [], gaps, series.to, true)).toBe(300_000)
  })

  it("holds only up to its last good read while its device still fails", () => {
    const series = covSeries([0, 10_000])
    const gaps = chartGaps(series, 0, { cov: true, failures: [{ from: 200_000, lastReadAt: 190_000 }] })
    expect(gaps).toEqual([{ from: 190_000, to: 300_000, cause: { kind: "device-failing" } }])
    expect(heldUntil(series.buckets, gaps, series.to, true)).toBe(190_000)
  })

  it("takes the last good read from the failure or else its recovery", () => {
    const failing = { ...event(1, 100, "device-failing"), lastReadAt: 90 }
    const recovered = { ...event(2, 200, "device-recovered"), lastReadAt: 80 }
    expect(failuresOf([failing, recovered], "energy-meter")).toEqual([{ from: 100, to: 200, lastReadAt: 90 }])
    expect(failuresOf([event(1, 100, "device-failing"), recovered], "energy-meter")).toEqual([
      { from: 100, to: 200, lastReadAt: 80 }
    ])
  })
})
