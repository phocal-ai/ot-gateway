/**
 * A point's history for the point panel: fetched from `/api/history`, and the pure parts of drawing it (ranges,
 * ticks, gaps), kept here so they are tested without a browser.
 */
import { type GatewayEvent, type HistoryBucket, type HistorySeries, OtGatewayApi } from "@ot-gateway/api"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { StatusUnavailable } from "./status"

export const ranges = [
  { id: "15m", label: "15 min", ms: 900_000 },
  { id: "1h", label: "1 h", ms: 3_600_000 },
  { id: "24h", label: "24 h", ms: 86_400_000 },
  { id: "7d", label: "7 days", ms: 604_800_000 }
] as const
export type Range = (typeof ranges)[number]

/** About one bucket per 2.5 px of a dialog-wide chart. */
const BUCKETS = 240

/** What the dialog can show for a point: its series, or why the gateway keeps none. */
export type PointHistory =
  | { readonly _tag: "series"; readonly series: HistorySeries }
  | { readonly _tag: "off"; readonly message: string }

const gateway = HttpApiClient.make(OtGatewayApi, {
  baseUrl: typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin
})

/** The gateway's time as last reported (`now`) and the monotonic time (`performance.now()`) when it arrived. */
export interface GatewayClock {
  readonly now: number
  readonly at: number
}

/**
 * The gateway's time at `monotonicNow`: its last reported time moved on by the monotonic time since. History is
 * kept by the gateway's wall clock, which on a device without network time can be far from the browser's.
 */
export const gatewayTime = (clock: GatewayClock, monotonicNow: number) => clock.now + (monotonicNow - clock.at)

/** The last `range` of a point, up to `now` (the gateway's time, see `gatewayTime`); `off` when the gateway keeps no history. */
export const fetchHistory = (device: string, point: string, range: Range, now: number) =>
  gateway.pipe(
    Effect.flatMap((client) =>
      client.status.history({ query: { device, point, from: now - range.ms, to: now, buckets: BUCKETS } })
    ),
    Effect.map((series): PointHistory => ({ _tag: "series", series })),
    Effect.catchTags({
      HistoryUnavailable: (error) => Effect.succeed<PointHistory>({ _tag: "off", message: error.message }),
      HistoryQueryInvalid: (error) => Effect.succeed<PointHistory>({ _tag: "off", message: error.message })
    }),
    Effect.mapError((error) => new StatusUnavailable({ message: error.message })),
    Effect.provide(FetchHttpClient.layer),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new StatusUnavailable({ message: "no answer within 5 s" }))
    })
  )

/** The buckets as runs without gaps: a gap of more than two steps (the device did not answer) breaks the line. */
export const segments = (buckets: ReadonlyArray<HistoryBucket>, stepMs: number) => {
  const runs: Array<Array<HistoryBucket>> = []
  let run: Array<HistoryBucket> = []
  for (const bucket of buckets) {
    const previous = run.at(-1)
    if (previous !== undefined && bucket.t - previous.t > 2 * stepMs) {
      runs.push(run)
      run = []
    }
    run.push(bucket)
  }
  if (run.length > 0) runs.push(run)
  return runs
}

/** About `count` round values covering `[min, max]`: 1, 2 or 5 times a power of ten apart. */
export const valueTicks = (min: number, max: number, count = 4): ReadonlyArray<number> => {
  // No reads (the min and max of nothing are ±Infinity) or a value no axis can show: a plain 0 to 1, not a loop that
  // never reaches `max`.
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return [0, 1]
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1
    return valueTicks(min - pad, max + pad, count)
  }
  const raw = (max - min) / count
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 5, 10].find((factor) => factor * power >= raw) ?? 10) * power
  const first = Math.floor(min / step) * step
  const ticks: Array<number> = []
  // Up to the first tick at or above `max`, so the band never runs off the top.
  for (let index = 0; ; index++) {
    const tick = Number((first + index * step).toPrecision(12))
    ticks.push(tick)
    if (tick >= max) return ticks
  }
}

const TIME_STEPS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 86_400_000]

/** About `count` times in `[from, to]` on round minutes, hours or days of the local clock. */
export const timeTicks = (from: number, to: number, count = 5) => {
  const step = TIME_STEPS.find((candidate) => (to - from) / candidate <= count) ?? 86_400_000
  const offset = new Date(from).getTimezoneOffset() * 60_000
  const ticks: Array<number> = []
  for (let tick = Math.ceil((from - offset) / step) * step + offset; tick <= to; tick += step) ticks.push(tick)
  return { ticks, step }
}

/**
 * A tick's label: the clock time on the 24-hour clock (14:05) like every other time on the page (`clockTime`), or
 * the day for day-wide steps; the same words in every locale.
 */
export const timeLabel = (at: number, step: number) =>
  step >= 86_400_000
    ? new Date(at).toLocaleDateString("en-US", { weekday: "short", day: "numeric" })
    : new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })

/** A bucket's time for the hover: the weekday and the 24-hour clock time, with seconds for buckets under a minute. */
export const bucketTime = (at: number, stepMs: number) =>
  new Date(at).toLocaleString("en-US", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(stepMs < 60_000 ? { second: "2-digit" as const } : {})
  })

/** The shortest time axis: a line that just began still gets a few minutes of room. */
const MIN_AXIS_MS = 300_000

/**
 * Where the time axis starts. A gateway that started within the range has no history before it unless an earlier
 * run left some: when the first bucket is from this run, the axis starts where the gateway started (at most
 * `MIN_AXIS_MS` before `to`), so five minutes of data fill the chart instead of its right edge. When there is older
 * history the axis keeps the whole range, so the time the gateway was off stays a gap.
 */
export const axisFrom = (series: HistorySeries, startedAt: number | undefined) => {
  const first = series.buckets[0]
  if (startedAt === undefined || first === undefined || startedAt <= series.from) return series.from
  if (first.t < startedAt - series.stepMs) return series.from
  return Math.max(series.from, Math.min(startedAt, first.t, series.to - MIN_AXIS_MS))
}

/** The bucket nearest to `at`, for the hover. */
export const nearest = (buckets: ReadonlyArray<HistoryBucket>, at: number) => {
  let best: HistoryBucket | undefined
  for (const bucket of buckets) if (best === undefined || Math.abs(bucket.t - at) < Math.abs(best.t - at)) best = bucket
  return best
}

/** A device failing for a while, from the gateway's events: `[from, to)`, `to` absent while it still fails. */
export interface Failure {
  readonly from: number
  readonly to?: number
}

/**
 * A device's failures in `events` (oldest first): each `device-failing` up to its next `device-recovered`, the last
 * one open while it still fails. The same pairing as `ot-gateway history` (apps/gateway/src/HistoryReport.ts).
 */
export const failuresOf = (events: ReadonlyArray<GatewayEvent>, device: string): ReadonlyArray<Failure> => {
  const failures: Array<Failure> = []
  let open: number | undefined
  for (const event of events) {
    if (event.type === "device-failing" && event.device === device) open ??= event.at
    else if (event.type === "device-recovered" && event.device === device && open !== undefined) {
      failures.push({ from: open, to: event.at })
      open = undefined
    }
  }
  if (open !== undefined) failures.push({ from: open })
  return failures
}

/** Why a stretch of the chart has no reads, when the page knows: the gateway was not running, or the device failed. */
export type GapCause = { readonly kind: "gateway-not-running" } | { readonly kind: "device-failing" }

/**
 * A stretch of the time axis without reads, `[from, to)` in Unix ms: from the last read before it to the first read
 * after it (or the end of the range), with its cause when known. Buckets from gateways that do not say when their
 * reads came (`first`, `last`) give the end of the bucket before it and the start of the bucket after it instead.
 */
export interface ChartGap {
  readonly from: number
  readonly to: number
  readonly cause?: GapCause
}

/**
 * The stretches of `[from, series.to)` without reads that break the line (more than two steps, as `segments`), each
 * with its cause: before `startedAt` the gateway was not running; after it, a failure of the device that overlaps
 * the stretch. Nothing before `from`: an axis that starts where the gateway started (`axisFrom`) already says so in
 * its note, so that gets no band.
 */
export const chartGaps = (
  series: HistorySeries,
  from: number,
  context: { readonly startedAt?: number | undefined; readonly failures?: ReadonlyArray<Failure> } = {}
): ReadonlyArray<ChartGap> => {
  const { buckets, stepMs, to } = series
  if (buckets.length === 0) return []
  const holes: Array<{ readonly from: number; readonly to: number }> = []
  // Where the line breaks: two buckets (or a bucket and an edge of the axis) more than two steps apart. The hole runs
  // from the last read before it to the first read after it, when the buckets say when those came (`last`, `first`);
  // otherwise from the end of the bucket before it to the start of the bucket after it, up to a step too wide.
  const edges: ReadonlyArray<{ readonly t: number; readonly first: number; readonly last: number }> = [
    { t: from - stepMs, first: from, last: from },
    ...buckets.map((bucket) => ({
      t: bucket.t,
      first: bucket.first ?? bucket.t,
      last: bucket.last ?? bucket.t + stepMs
    })),
    { t: to, first: to, last: to }
  ]
  for (let index = 1; index < edges.length; index++) {
    const previous = edges[index - 1]
    const next = edges[index]
    if (previous === undefined || next === undefined || next.t - previous.t <= 2 * stepMs) continue
    holes.push({ from: Math.max(from, previous.last), to: Math.min(to, next.first) })
  }
  const startedAt = context.startedAt
  const failed = (hole: { readonly from: number; readonly to: number }): ChartGap => {
    const failure = context.failures?.find(
      (each) => each.from < hole.to && (each.to === undefined || each.to > hole.from)
    )
    return failure === undefined ? hole : { ...hole, cause: { kind: "device-failing" } }
  }
  // An axis moved up to the gateway's start has a note that says there is nothing before it: no band repeats that.
  if (startedAt !== undefined && from > series.from) {
    return holes.flatMap((hole) => {
      const after = { from: Math.max(hole.from, startedAt), to: hole.to }
      return after.to - after.from > 2 * stepMs ? [failed(after)] : []
    })
  }
  return holes.flatMap((hole): ReadonlyArray<ChartGap> => {
    if (startedAt === undefined || startedAt <= hole.from) return [failed(hole)]
    if (startedAt >= hole.to) return [{ ...hole, cause: { kind: "gateway-not-running" } }]
    return [
      { from: hole.from, to: startedAt, cause: { kind: "gateway-not-running" } },
      ...(hole.to - startedAt > 2 * stepMs ? [failed({ from: startedAt, to: hole.to })] : [])
    ]
  })
}

/**
 * A gap's time: 15:58 on the 24-hour clock, to the second for a gap under two minutes (15:58:20), with the weekday
 * when it is not the day of `now`.
 */
const gapTime = (at: number, now: number, seconds: boolean) => {
  const moment = new Date(at)
  const time = moment.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(seconds ? { second: "2-digit" as const } : {})
  })
  return moment.toDateString() === new Date(now).toDateString()
    ? time
    : `${moment.toLocaleDateString("en-US", { weekday: "short" })} ${time}`
}

/**
 * A gap in words, for the line under the chart and the hover: "No reads 15:58–16:00: energy-meter not answering";
 * "No reads since 15:58" while it lasts (it reaches the end of the range); "the gateway was not running" before it
 * started.
 */
export const gapSentence = (gap: ChartGap, device: string, to: number) => {
  const seconds = gap.to - gap.from < 120_000
  const when =
    gap.to >= to
      ? `since ${gapTime(gap.from, to, seconds)}`
      : `${gapTime(gap.from, to, seconds)}–${gapTime(gap.to, to, seconds)}`
  const why =
    gap.cause?.kind === "device-failing"
      ? `: ${device} not answering`
      : gap.cause?.kind === "gateway-not-running"
        ? ": the gateway was not running"
        : ""
  return `No reads ${when}${why}`
}

/** The gap that `at` falls in, for the hover. */
export const gapAt = (gaps: ReadonlyArray<ChartGap>, at: number) => gaps.find((gap) => gap.from <= at && at < gap.to)
