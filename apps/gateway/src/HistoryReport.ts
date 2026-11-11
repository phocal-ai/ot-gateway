/**
 * `ot-gateway history`: what a point did lately, from the running gateway's history (`/api/history`), without
 * working out epoch milliseconds by hand. The range ends at the gateway's own `now`, so a laptop's clock does not
 * shift it. Text is a table per point in local clock times: each bucket's average with the unit, its minimum,
 * maximum and number of reads, and a gap where no read came: before the gateway started, while the device failed
 * (from the events, with the device's error) or without a known cause. The gateway's answer holds every read up to
 * its `now`, the ones not written to its file yet too. A switch or an alarm (a point whose value is true or
 * false) reads as on or off per bucket, followed by when it changed, from every read. `--json` is the API's
 * series, with each point's name and unit and the gaps named.
 */
import {
  type EventLog,
  type HistoryBucket,
  type HistorySeries,
  MAX_VALUES_PER_REQUEST,
  type PointInfo,
  preciseDuration,
  unitLabel
} from "@ot-gateway/api"
import { Effect, Result, Schema } from "effect"
import { checkIdentity, gatewayName, type GatewayTarget } from "./GatewayTarget.ts"
import { localTime, printJson, printResult } from "./Output.ts"
import { askGateway, fetchGatewayEvents, fetchGatewayStatus } from "./StatusReport.ts"
import { closestMatch } from "./Suggest.ts"
import { withoutControls } from "./Discover.ts"

/** The history cannot answer: it is off, or the point is not the gateway's. `message` says what to do. */
export class HistoryError extends Schema.TaggedError<HistoryError>()("HistoryError", {
  message: Schema.String
}) {}

/** Buckets a text report has unless asked: one a minute over the default ten minutes. */
export const DEFAULT_TEXT_BUCKETS = 10

/** How often a gateway without `live` series wrote its reads to the history: its newest bucket lagged by this much. */
const FLUSH_MS = 30_000

/** Changes of a switch the text lists at most; `--json` has up to `HISTORY_CHANGES_MAX`. */
export const TEXT_CHANGES_MAX = 20

/** What `history` was asked for: `device/point`, or `device` for all of its points, comma-separated. */
export interface PointSelection {
  readonly device: string
  readonly point?: string | undefined
}

/** `meter/power,meter/energy` or `meter`: the selections, or undefined for an empty one. */
export const parseSelection = (text: string): ReadonlyArray<PointSelection> | undefined => {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
  if (parts.length === 0) return undefined
  return parts.map((part) => {
    const slash = part.indexOf("/")
    return slash < 0 ? { device: part } : { device: part.slice(0, slash), point: part.slice(slash + 1) }
  })
}

/** ` (did you mean x?)` when one of `candidates` is close to `word`. */
const suggestion = (word: string, candidates: Iterable<string>) => {
  const meant = closestMatch(word, candidates)
  return meant === undefined ? "" : ` (did you mean ${meant}?)`
}

/** The catalog's points that `selections` name, in the order asked, or why one names nothing. */
export const selectPoints = (
  catalog: ReadonlyArray<PointInfo>,
  selections: ReadonlyArray<PointSelection>
): Result.Result<ReadonlyArray<PointInfo>, HistoryError> => {
  const devices = new Set(catalog.map((point) => point.device))
  const chosen: Array<PointInfo> = []
  for (const selection of selections) {
    if (!devices.has(selection.device)) {
      return Result.fail(
        new HistoryError({
          message: `the gateway has no device ${selection.device}${suggestion(selection.device, devices)}; ot-gateway status lists them`
        })
      )
    }
    const ofDevice = catalog.filter((point) => point.device === selection.device)
    if (selection.point === undefined) {
      chosen.push(...ofDevice)
      continue
    }
    const point = ofDevice.find((candidate) => candidate.id === selection.point)
    if (point === undefined) {
      return Result.fail(
        new HistoryError({
          message: `${selection.device} has no point ${selection.point}${suggestion(
            selection.point,
            ofDevice.map((candidate) => candidate.id)
          )}; its points: ${ofDevice.map((candidate) => candidate.id).join(", ")}`
        })
      )
    }
    chosen.push(point)
  }
  return Result.succeed(chosen)
}

/** A stretch of the range without a read: `[from, to)` in Unix ms. */
export interface Gap {
  readonly from: number
  readonly to: number
}

/** The bucket slots of `series` that have no read, merged where they follow each other. */
export const gapsOf = (series: HistorySeries): ReadonlyArray<Gap> => {
  const filled = new Set(series.buckets.map((bucket) => bucket.t))
  const gaps: Array<Gap> = []
  for (let start = series.from; start < series.to; start += series.stepMs) {
    if (filled.has(start)) continue
    const end = Math.min(start + series.stepMs, series.to)
    const previous = gaps.at(-1)
    if (previous !== undefined && previous.to === start) gaps[gaps.length - 1] = { from: previous.from, to: end }
    else gaps.push({ from: start, to: end })
  }
  return gaps
}

/** Why the newest reads can be missing, from a gateway whose answers do not hold the reads it has not written. */
const notYet = "the gateway writes reads to its history every 30 s"

/**
 * A device failing for a while, from the gateway's events: `[from, to)`, `to` absent while it still fails. `from` is
 * when the gateway called it failing; `lastReadAt`, when its data stopped (its last good read, a poll or more before).
 */
export interface Failure {
  readonly from: number
  readonly to?: number
  readonly error: string
  readonly lastReadAt?: number
}

/** Each device's failures in `log`, oldest first: a `device-failing` event up to the device's next recovery. */
export const failuresOf = (log: EventLog): ReadonlyMap<string, ReadonlyArray<Failure>> => {
  const failures = new Map<string, Array<Failure>>()
  const open = new Map<string, Failure>()
  for (const event of log.events) {
    if (event.type === "device-failing") {
      open.set(event.device, {
        from: event.at,
        error: event.error === "" ? event.reason : event.error,
        ...(event.lastReadAt === undefined ? {} : { lastReadAt: event.lastReadAt })
      })
    } else if (event.type === "device-recovered") {
      const started = open.get(event.device)
      if (started === undefined) continue
      open.delete(event.device)
      failures.set(event.device, [...(failures.get(event.device) ?? []), { ...started, to: event.at }])
    }
  }
  for (const [device, started] of open) failures.set(device, [...(failures.get(device) ?? []), started])
  return failures
}

/**
 * Why a stretch had no read, when the gateway knows: it ended at the gateway's start (what came before, in an earlier
 * run, the history cannot tell), or the device was failing.
 */
export type GapCause =
  | { readonly kind: "gateway-start"; readonly started: number }
  | { readonly kind: "device-failing"; readonly since: number; readonly error: string }
  | { readonly kind: "no-change" }

/**
 * A stretch without a read, with its cause when known. `from` and `to` are the real span: from the last read before
 * it to the first read after it (from the buckets' `first` and `last`), or the range's edge when there is no read
 * on that side, or the bucket's edge from a gateway or rollup without read times. `emptyFrom` and `emptyTo` are the
 * empty buckets it covers.
 */
export interface ExplainedGap extends Gap {
  readonly emptyFrom: number
  readonly emptyTo: number
  readonly cause?: GapCause
}

/** What `formatSeries` knows besides the series: whether the point is a switch, when the gateway started, failures. */
export interface SeriesContext {
  /** The point's values are true or false (a switch, an alarm): on and off instead of averages. */
  readonly boolean?: boolean
  /** Unix ms when the gateway started: the stretch before it is the gateway, not the device. */
  readonly since?: number
  /** The device's failures in this run, from the events: a gap while it failed says why. */
  readonly failures?: ReadonlyArray<Failure>
  /**
   * The point comes on change of value (BACnet COV, `PointInfo.cov`): a stretch without a read while its device
   * answers is one without a change (cause `no-change`), not an outage. A gap that a failure overlaps is split: the
   * failure's part runs from the device's last good read to its recovery, the rest is no change.
   */
  readonly cov?: boolean
}

/**
 * The gaps of `series` with their real span and their causes. A run of empty buckets is a gap; it reaches back to
 * the last read before it and on to the first read after it. When the gateway started inside it, the part before
 * the start ends at the start (why reads stopped in an earlier run is unknown), and the part after it is a gap of its
 * own only when the bucket the gateway started in had no read either (otherwise it is just the time to the first
 * poll). The rest of a gap names the first failure of the device that overlaps it, when there is one: a failure starts
 * at its last good read when the events say so, which is where the data stopped. A gap of a point that comes on
 * change of value, with neither cause, is one without a change.
 */
export const explainGaps = (series: HistorySeries, context: SeriesContext = {}): ReadonlyArray<ExplainedGap> => {
  const since = context.since
  const byStart = new Map(series.buckets.map((bucket) => [bucket.t, bucket]))
  const failed = (gap: Omit<ExplainedGap, "cause">): ReadonlyArray<ExplainedGap> => {
    const failure = context.failures?.find(
      (each) => (each.lastReadAt ?? each.from) < gap.to && (each.to === undefined || each.to > gap.from)
    )
    if (failure === undefined) return [context.cov === true ? { ...gap, cause: { kind: "no-change" } } : gap]
    const cause: GapCause = { kind: "device-failing", since: failure.from, error: failure.error }
    if (context.cov !== true) return [{ ...gap, cause }]
    // On change of value, only the failure's own stretch is the failure: from the device's last good read to its
    // recovery. Before it and after it the device answered, and the point had nothing new to say.
    const down = Math.max(gap.from, failure.lastReadAt ?? failure.from)
    const back = Math.min(gap.to, failure.to ?? gap.to)
    const quiet = (from: number, to: number): ReadonlyArray<ExplainedGap> =>
      from < to ? [{ ...gap, from, to, cause: { kind: "no-change" } }] : []
    return [...quiet(gap.from, down), { ...gap, from: down, to: back, cause }, ...quiet(back, gap.to)]
  }
  return gapsOf(series).flatMap((empty): ReadonlyArray<ExplainedGap> => {
    const from = byStart.get(empty.from - series.stepMs)?.last ?? empty.from
    // Without read times, a gap that the gateway's start ends reaches at least to the start.
    const startsNext = since !== undefined && since >= empty.to && since < empty.to + series.stepMs
    const to = byStart.get(empty.to)?.first ?? (startsNext ? since : empty.to)
    const buckets = { emptyFrom: empty.from, emptyTo: empty.to }
    if (since === undefined || since <= from || since > to) return failed({ from, to, ...buckets })
    return [
      { from, to: since, ...buckets, cause: { kind: "gateway-start", started: since } },
      ...(since < empty.to && since < to ? failed({ from: since, to, ...buckets }) : [])
    ]
  })
}

/** A number as the table shows it: up to three decimals, no trailing zeros. */
const number = (value: number) => String(Number(value.toFixed(3)))

/** `1 min`, `5 s`, `15 min`: a bucket's width. */
const width = (stepMs: number) => (stepMs % 60_000 === 0 ? `${stepMs / 60_000} min` : `${number(stepMs / 1000)} s`)

/** What a bucket of a switch says: on or off throughout, or how many of its reads were on. */
const switchBucket = (bucket: HistoryBucket) => {
  if (bucket.count === 1) return `${bucket.max === 1 ? "on" : "off"}  (1 read)`
  if (bucket.min === bucket.max) return `${bucket.max === 1 ? "on" : "off"}, all ${bucket.count} reads`
  // The average of 0 and 1 is the share of reads that were on.
  return `on in ${Math.round(bucket.avg * bucket.count)} of ${bucket.count} reads`
}

/** The lines that say when a switch changed: the first read in the range, then every change. */
const changeLines = (series: HistorySeries, now: number) => {
  const changes = series.changes
  if (changes === undefined) return ["  changes: only kept for the last day"]
  if (changes.list.length === 0) return []
  const shown = changes.list.slice(0, TEXT_CHANGES_MAX)
  const more = changes.list.length - shown.length
  return [
    "  changes, from every read:",
    ...shown.map(
      (change, index) =>
        `    ${localTime(change.t, now)}  ${index === 0 ? `${change.value === 1 ? "on" : "off"} at the first read in this range` : change.value === 1 ? "switched on" : "switched off"}`
    ),
    ...(more > 0 || changes.truncated
      ? [`    and ${changes.truncated ? "more" : more} later, see --json or a shorter --since`]
      : [])
  ]
}

/**
 * When a bucket's line says it starts: its start, or the gateway's start for the bucket the gateway started in
 * when all of its reads came after that, so no line claims a time before the gateway ran.
 */
export const labelOf = (bucket: HistoryBucket, stepMs: number, since: number | undefined) =>
  since !== undefined &&
  since > bucket.t &&
  since < bucket.t + stepMs &&
  (bucket.first === undefined || bucket.first >= since)
    ? since
    : bucket.t

/** The lines of one point's series: a heading, then a bucket or a gap per line, oldest first. */
export const formatSeries = (point: PointInfo, series: HistorySeries, now: number, context: SeriesContext = {}) => {
  const unit = unitLabel(point.unit)
  const withUnit = (value: number) => (unit === "" ? number(value) : `${number(value)} ${unit}`)
  const source = series.resolution === "read" ? "from every read" : "from the per-minute rollups"
  const rows: Array<{ readonly t: number; readonly line: string }> = series.buckets.map((bucket) => {
    // A minute rollup that runs past the end of the range is the current minute, still filling.
    const soFar = bucket.t + series.stepMs > series.to ? "  so far" : ""
    const values =
      context.boolean === true
        ? switchBucket(bucket)
        : bucket.count === 1
          ? `${withUnit(bucket.avg)}  (1 read)`
          : `avg ${withUnit(bucket.avg)}  min ${number(bucket.min)}  max ${number(bucket.max)}  (${bucket.count} reads)`
    return { t: bucket.t, line: `${localTime(labelOf(bucket, series.stepMs, context.since), now)}  ${values}${soFar}` }
  })
  const heading = `${point.device}/${point.id} (${point.name}${unit === "" ? "" : `, ${unit}`}): ${width(series.stepMs)} buckets ${source}`
  const live = series.live === true
  const failing = (cause: GapCause | undefined) =>
    cause?.kind === "device-failing"
      ? `: ${point.device} failing: ${withoutControls(cause.error)}`
      : cause?.kind === "no-change"
        ? ": it comes on change of value, so no change while its device answered"
        : ""
  const gaps = explainGaps(series, context)
  if (series.buckets.length === 0) {
    const start = gaps.find((gap) => gap.cause?.kind === "gateway-start")?.cause
    const failure = gaps.find((gap) => gap.cause?.kind === "device-failing")?.cause
    const why =
      start?.kind === "gateway-start"
        ? ` before the gateway started at ${localTime(start.started, now)}${failing(failure)}`
        : failing(failure)
    const quiet = context.cov === true && failure === undefined && start === undefined
    return [
      heading,
      live
        ? quiet
          ? "  no reads in this range: it comes on change of value, so no change while its device answered"
          : `  no reads in this range${why}`
        : `  no reads in this range (${notYet})`
    ]
  }
  for (const gap of gaps) {
    const atEnd = gap.to >= series.to
    const cause = gap.cause
    const line =
      cause?.kind === "gateway-start"
        ? `no reads until the gateway started at ${localTime(cause.started, now)}`
        : cause?.kind === "no-change"
          ? // A change-of-value point that kept still: nothing missing, so not "no reads".
            atEnd
            ? "no change since then (it comes on change of value)"
            : `no change for ${preciseDuration(gap.to - gap.from)}, until ${localTime(gap.to, now)} (it comes on change of value)`
          : live
            ? atEnd
              ? gap.emptyFrom >= series.to - series.stepMs
                ? `no read yet in this bucket${failing(cause)}`
                : `no reads since then${failing(cause)}`
              : `no reads for ${preciseDuration(gap.to - gap.from)}, until ${localTime(gap.to, now)}${failing(cause)}`
            : // A gateway without live answers wrote its reads every 30 s: a short gap at the end is that.
              atEnd && gap.emptyFrom >= series.to - FLUSH_MS - series.stepMs
              ? "not written yet"
              : atEnd
                ? `no reads since then (${notYet})${failing(cause)}`
                : `no reads for ${preciseDuration(gap.to - gap.from)}, until ${localTime(gap.to, now)}${failing(cause)}`
    rows.push({ t: gap.from, line: `${localTime(gap.from, now)}  ${line}` })
  }
  return [
    heading,
    ...rows.toSorted((left, right) => left.t - right.t).map((row) => `  ${row.line}`),
    ...(context.boolean === true ? changeLines(series, now) : [])
  ]
}

/**
 * What `history --json` prints for one point: the API's series with the point's name and unit, and its gaps, each
 * with its `cause` when known (`gateway-start`, `device-failing`).
 */
export const seriesJson = (point: PointInfo, series: HistorySeries, context: SeriesContext = {}) => ({
  ...series,
  name: point.name,
  ...(context.boolean === true ? { boolean: true } : {}),
  ...(point.unit === undefined ? {} : { unit: point.unit, unitLabel: unitLabel(point.unit) }),
  gaps: explainGaps(series, context)
})

/** How the gateway's answer that it keeps no history reads on the command line. */
export const historyOff = (reason: string) =>
  `the gateway keeps no history (${reason}). Add "history": {"path": "history.sqlite"} to its config and restart it; from then on it keeps every read for a day and per-minute values for 7 days`

/** One point's series from the gateway at `url`, with the gateway's refusals as `HistoryError`. */
const fetchSeries = (
  url: string,
  point: PointInfo,
  range: { readonly from: number; readonly to: number },
  buckets: number,
  changes: boolean
) =>
  askGateway(url, (client) =>
    client.status
      .history({
        query: {
          device: point.device,
          point: point.id,
          from: range.from,
          to: range.to,
          buckets,
          ...(changes ? { changes: "true" as const } : {})
        }
      })
      .pipe(
        Effect.map((series) => Result.succeed(series)),
        Effect.catchTags({
          HistoryUnavailable: (error) =>
            Effect.succeed(Result.fail(new HistoryError({ message: historyOff(error.message) }))),
          HistoryQueryInvalid: (error) => Effect.succeed(Result.fail(new HistoryError({ message: error.message })))
        })
      )
  ).pipe(Effect.flatMap(Effect.fromResult))

export interface HistoryOptions {
  readonly since: string
  readonly sinceMs: number
  readonly buckets?: number | undefined
  readonly json?: boolean
}

/** Prints the history of the points `selections` names over the last `since`, from the gateway `target` expects. */
export const historyReport = Effect.fn("historyReport")(function* (
  target: GatewayTarget,
  selections: ReadonlyArray<PointSelection>,
  options: HistoryOptions
) {
  const status = yield* fetchGatewayStatus(target.url, "none")
  yield* checkIdentity(target, status)
  const catalog = yield* askGateway(target.url, (client) => client.status.points())
  const points = yield* Effect.fromResult(selectPoints(catalog.points, selections))
  // A switch: an alarm point, or a point whose last value is true or false. Only the chosen points' values.
  const keys = points.map((point) => `${point.device}/${point.id}`)
  const readings = yield* Effect.forEach(
    Array.from({ length: Math.ceil(keys.length / MAX_VALUES_PER_REQUEST) }, (_, index) =>
      keys.slice(index * MAX_VALUES_PER_REQUEST, (index + 1) * MAX_VALUES_PER_REQUEST)
    ),
    (chunk) => askGateway(target.url, (client) => client.status.values({ query: { points: chunk.join(",") } })),
    { concurrency: 1 }
  )
  const switches = new Set([
    ...readings
      .flatMap((answer) => answer.readings)
      .filter((reading) => typeof reading.value === "boolean")
      .map((reading) => `${reading.device}/${reading.point}`),
    ...(status.alarms ?? []).map((alarm) => `${alarm.device}/${alarm.point}`)
  ])
  // Why a device had no reads: its failures in this run, from the events the gateway keeps.
  const failures = failuresOf(yield* fetchGatewayEvents(target.url))
  const range = { from: status.now - options.sinceMs, to: status.now }
  const buckets = options.buckets ?? DEFAULT_TEXT_BUCKETS
  const answers = yield* Effect.forEach(
    points,
    (point) => {
      const boolean = switches.has(`${point.device}/${point.id}`)
      const context: SeriesContext = {
        boolean,
        since: status.since,
        failures: failures.get(point.device) ?? [],
        ...(point.cov ? { cov: true } : {})
      }
      return Effect.map(fetchSeries(target.url, point, range, buckets, boolean), (series) => ({
        point,
        series,
        context
      }))
    },
    { concurrency: 4 }
  )
  const gateway = { site: status.site, building: status.building, id: status.id }
  if (options.json === true) {
    return yield* printJson({
      ok: true,
      gateway,
      now: status.now,
      since: options.since,
      series: answers.map(({ point, series, context }) => seriesJson(point, series, context))
    })
  }
  yield* printResult(
    [
      `${gatewayName(gateway)} at ${target.url}: the last ${options.since}, until ${localTime(status.now)}`,
      ...answers.flatMap(({ point, series, context }) => ["", ...formatSeries(point, series, status.now, context)])
    ].join("\n")
  )
})
