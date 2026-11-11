/**
 * `ot-gateway history`: what a point did lately, from the running gateway's history (`/api/history`), without
 * working out epoch milliseconds by hand. The range ends at the gateway's own `now`, so a laptop's clock does not
 * shift it. Text is a table per point in local clock times: each bucket's average with the unit, its minimum,
 * maximum and number of reads, and a gap where no read came. `--json` is the API's series, with each point's name
 * and unit and the gaps named.
 */
import { type HistorySeries, type PointInfo, unitLabel } from "@ot-gateway/api"
import { Effect, Result, Schema } from "effect"
import { checkIdentity, gatewayName, type GatewayTarget } from "./GatewayTarget.ts"
import { localTime, printJson, printResult } from "./Output.ts"
import { ago, askGateway, fetchGatewayStatus } from "./StatusReport.ts"
import { closestMatch } from "./Suggest.ts"

/** The history cannot answer: it is off, or the point is not the gateway's. `message` says what to do. */
export class HistoryError extends Schema.TaggedError<HistoryError>()("HistoryError", {
  message: Schema.String
}) {}

/** Buckets a text report has unless asked: one a minute over the default ten minutes. */
export const DEFAULT_TEXT_BUCKETS = 10

/** How often the gateway writes its reads to the history: the newest bucket can lag by this much. */
const FLUSH_MS = 30_000

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

/** Why the newest reads can be missing. */
const notYet = "the gateway writes reads to its history every 30 s"

/** A number as the table shows it: up to three decimals, no trailing zeros. */
const number = (value: number) => String(Number(value.toFixed(3)))

/** `1 min`, `5 s`, `15 min`: a bucket's width. */
const width = (stepMs: number) => (stepMs % 60_000 === 0 ? `${stepMs / 60_000} min` : `${number(stepMs / 1000)} s`)

/** The lines of one point's series: a heading, then a bucket or a gap per line, oldest first. */
export const formatSeries = (point: PointInfo, series: HistorySeries, now: number) => {
  const unit = unitLabel(point.unit)
  const withUnit = (value: number) => (unit === "" ? number(value) : `${number(value)} ${unit}`)
  const source = series.resolution === "read" ? "from every read" : "from the per-minute rollups"
  const rows: Array<{ readonly t: number; readonly line: string }> = series.buckets.map((bucket) => ({
    t: bucket.t,
    line:
      bucket.count === 1
        ? `${localTime(bucket.t, now)}  ${withUnit(bucket.avg)}  (1 read)`
        : `${localTime(bucket.t, now)}  avg ${withUnit(bucket.avg)}  min ${number(bucket.min)}  max ${number(bucket.max)}  (${bucket.count} reads)`
  }))
  const heading = `${point.device}/${point.id} (${point.name}${unit === "" ? "" : `, ${unit}`}): ${width(series.stepMs)} buckets ${source}`
  if (series.buckets.length === 0) return [heading, `  no reads in this range (${notYet})`]
  for (const gap of gapsOf(series)) {
    const atEnd = gap.to >= series.to
    // The newest reads reach the history file every 30 s: a short gap at the end is that, not the device.
    const line =
      atEnd && gap.from >= series.to - FLUSH_MS - series.stepMs
        ? "not written yet"
        : atEnd
          ? `no reads since then (${notYet})`
          : `no reads for ${ago(gap.to - gap.from)}, until ${localTime(gap.to, now)}`
    rows.push({ t: gap.from, line: `${localTime(gap.from, now)}  ${line}` })
  }
  return [heading, ...rows.toSorted((left, right) => left.t - right.t).map((row) => `  ${row.line}`)]
}

/** What `history --json` prints for one point: the API's series with the point's name and unit, and its gaps. */
export const seriesJson = (point: PointInfo, series: HistorySeries) => ({
  ...series,
  name: point.name,
  ...(point.unit === undefined ? {} : { unit: point.unit, unitLabel: unitLabel(point.unit) }),
  gaps: gapsOf(series)
})

/** How the gateway's answer that it keeps no history reads on the command line. */
export const historyOff = (reason: string) =>
  `the gateway keeps no history (${reason}). Add "history": {"path": "history.sqlite"} to its config and restart it; from then on it keeps every read for a day and per-minute values for 7 days`

/** One point's series from the gateway at `url`, with the gateway's refusals as `HistoryError`. */
const fetchSeries = (
  url: string,
  point: PointInfo,
  range: { readonly from: number; readonly to: number },
  buckets: number
) =>
  askGateway(url, (client) =>
    client.status
      .history({ query: { device: point.device, point: point.id, from: range.from, to: range.to, buckets } })
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
  const range = { from: status.now - options.sinceMs, to: status.now }
  const buckets = options.buckets ?? DEFAULT_TEXT_BUCKETS
  const answers = yield* Effect.forEach(
    points,
    (point) => Effect.map(fetchSeries(target.url, point, range, buckets), (series) => ({ point, series })),
    { concurrency: 4 }
  )
  const gateway = { site: status.site, building: status.building, id: status.id }
  if (options.json === true) {
    return yield* printJson({
      ok: true,
      gateway,
      now: status.now,
      since: options.since,
      series: answers.map(({ point, series }) => seriesJson(point, series))
    })
  }
  yield* printResult(
    [
      `${gatewayName(gateway)} at ${target.url}: the last ${options.since}, until ${localTime(status.now)}`,
      ...answers.flatMap(({ point, series }) => ["", ...formatSeries(point, series, status.now)])
    ].join("\n")
  )
})
