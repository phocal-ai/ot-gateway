/**
 * A point's history for the point panel: fetched from `/api/history`, and the pure parts of drawing it (ranges,
 * ticks, gaps), kept here so they are tested without a browser.
 */
import { type HistoryBucket, type HistorySeries, OtGatewayApi } from "@ot-gateway/api"
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

/** The last `range` of a point, up to `now`; `off` when the gateway keeps no history. */
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

/** A tick's label: the clock time, or the day for day-wide steps. */
export const timeLabel = (at: number, step: number) =>
  step >= 86_400_000
    ? new Date(at).toLocaleDateString([], { weekday: "short", day: "numeric" })
    : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/** The bucket nearest to `at`, for the hover. */
export const nearest = (buckets: ReadonlyArray<HistoryBucket>, at: number) => {
  let best: HistoryBucket | undefined
  for (const bucket of buckets) if (best === undefined || Math.abs(bucket.t - at) < Math.abs(best.t - at)) best = bucket
  return best
}
