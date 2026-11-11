/**
 * The gateway's status, through the typed client for `OtGatewayApi`: the same
 * schema the gateway encodes with decodes the answer here.
 */
import {
  type ConfigView,
  type DeviceStatus,
  type EventLog,
  type GatewayStatus,
  isDeviceLate,
  type Messages,
  OtGatewayApi,
  type PointCatalog,
  type PointReading
} from "@ot-gateway/api"
import { Effect, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { formatNumber } from "./format"
import { chunkKeys } from "./points"

/** The gateway did not answer, not in time, or not with a status: for the page, all the same. */
export class StatusUnavailable extends Schema.TaggedError<StatusUnavailable>()("StatusUnavailable", {
  message: Schema.String
}) {}

/**
 * A request run to its result, as a promise that never rejects: a defect (a bug in the page, not the gateway) counts
 * as no answer too, so a poll that schedules its next request after this one always goes on.
 */
export const settle = <A>(request: Effect.Effect<A, StatusUnavailable>) =>
  Effect.runPromise(
    Effect.result(
      request.pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(new StatusUnavailable({ message: defect instanceof Error ? defect.message : "unexpected error" }))
        )
      )
    )
  )

/** The typed client for the gateway that served this page: the API is on the same origin. */
const gateway = HttpApiClient.make(OtGatewayApi, {
  baseUrl: typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin
})

/**
 * An answer within three seconds, or `StatusUnavailable`: every way of not getting it (unreachable, a timeout, an
 * answer that does not decode) means one thing here.
 */
const withinThreeSeconds = <A, E extends { readonly message: string }, R>(request: Effect.Effect<A, E, R>) =>
  request.pipe(
    Effect.mapError((error) => new StatusUnavailable({ message: error.message })),
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () => Effect.fail(new StatusUnavailable({ message: "no answer within 3 s" }))
    })
  )

/**
 * The status, for the whole page: health, broker, buffer, host and commands, without each point's value (that is
 * a megabyte every poll at 10,000 points). The points page asks for the values of the rows it shows.
 */
export const fetchStatus: Effect.Effect<GatewayStatus, StatusUnavailable> = gateway.pipe(
  Effect.flatMap((client) => client.status.status({ query: { points: "none" } })),
  Effect.provide(FetchHttpClient.layer),
  withinThreeSeconds
)

/** The last reads of these `device/point` keys, in as few requests as fit a URL each. */
export const fetchValues = (
  keys: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<PointReading>, StatusUnavailable> =>
  gateway.pipe(
    Effect.flatMap((client) =>
      Effect.forEach(chunkKeys(keys), (chunk) => client.status.values({ query: { points: chunk.join(",") } }), {
        concurrency: 4
      })
    ),
    Effect.map((answers) => answers.flatMap((answer) => answer.readings)),
    Effect.provide(FetchHttpClient.layer),
    withinThreeSeconds
  )

/** The latest message per topic, for the messages view; asked for only while it is open. */
export const fetchMessages: Effect.Effect<Messages, StatusUnavailable> = gateway.pipe(
  Effect.flatMap((client) => client.status.messages()),
  Effect.provide(FetchHttpClient.layer),
  withinThreeSeconds
)

/** Every configured point, for the points page; it changes only when the gateway restarts, so it is asked for once. */
export const fetchPoints: Effect.Effect<PointCatalog, StatusUnavailable> = gateway.pipe(
  Effect.flatMap((client) => client.status.points()),
  Effect.provide(FetchHttpClient.layer),
  withinThreeSeconds
)

/**
 * The gateway's recent events (`/api/events`): all it keeps, or only those after the event id `after`, which is what
 * the status poll asks for each time, so it is usually an empty list.
 */
export const fetchEvents = (after: number | undefined): Effect.Effect<EventLog, StatusUnavailable> =>
  gateway.pipe(
    Effect.flatMap((client) => client.status.events({ query: after === undefined ? {} : { after } })),
    Effect.provide(FetchHttpClient.layer),
    withinThreeSeconds
  )

/** The running config without its points, for the Settings tab; it changes only when the gateway restarts. */
export const fetchConfig: Effect.Effect<ConfigView, StatusUnavailable> = gateway.pipe(
  Effect.flatMap((client) => client.status.config()),
  Effect.provide(FetchHttpClient.layer),
  withinThreeSeconds
)

/** The protocols as people name them. */
export const protocolName: Readonly<Record<string, string>> = {
  "modbus-tcp": "Modbus TCP",
  "bacnet-ip": "BACnet/IP",
  simulator: "Simulated"
}

/** QUDT unit names as people write them: shared with `ot-gateway history`. */
export { unitLabel, unitSymbols } from "@ot-gateway/api"

/**
 * A point's value for people: whole numbers and values from 1000 grouped with up to three decimals (1,500; 1,234.5),
 * smaller fractions with exactly two (1.50), always in `formatNumber`'s `en-US` convention.
 */
export const formatValue = (value: number | boolean | undefined) => {
  if (value === undefined) return "–"
  if (typeof value === "boolean") return value ? "on" : "off"
  return Math.abs(value) >= 1000 || Number.isInteger(value) ? formatNumber(value) : formatNumber(value, 2)
}

/**
 * How fresh a device is, as a state rather than a counting number: `live` while it is read on schedule, `late`
 * when no read came for a few intervals although the gateway has not marked it failing (a stalled cycle), and
 * `failing` or `starting` as the gateway says.
 */
export type Freshness =
  | { readonly _tag: "live" }
  | { readonly _tag: "starting" }
  | { readonly _tag: "late"; readonly lastSuccess: number | undefined }
  | { readonly _tag: "failing"; readonly reason: string; readonly lastSuccess: number | undefined }

/** How long a read may be missing before it counts as late, shared with `ot-gateway status`. */
export { lateAfterMs } from "@ot-gateway/api"

export const freshness = (device: DeviceStatus, now: number): Freshness => {
  if (device.status === "failing")
    return { _tag: "failing", reason: device.reason ?? "failing", lastSuccess: device.lastSuccess }
  if (device.status === "starting") return { _tag: "starting" }
  return isDeviceLate(device, now) ? { _tag: "late", lastSuccess: device.lastSuccess } : { _tag: "live" }
}

/** The gateway's failure reasons (`DriverError`'s, and the pipeline's `cycle-timeout`) in words. */
const failureWords: Readonly<Record<string, string>> = {
  timeout: "no reply",
  connection: "cannot connect",
  protocol: "protocol error",
  "invalid-response": "bad reply",
  configuration: "config error",
  "not-implemented": "not supported",
  "cycle-timeout": "read hangs"
}

/** Why a device is failing, as someone on site would say it: "cannot connect", not "connection". */
export const failureLabel = (reason: string) => failureWords[reason] ?? reason

/** How much a device's state needs a look: failing first, then late, starting, and the ones that answer last. */
const attention = { failing: 0, late: 1, starting: 2, live: 3 } as const

/** The devices with problems first, each group in config order, so a site's failing meter is not row 87. */
export const byAttention = (devices: ReadonlyArray<DeviceStatus>, now: number): ReadonlyArray<DeviceStatus> =>
  devices
    .map((device, index) => ({ device, index, rank: attention[freshness(device, now)._tag] }))
    .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ device }) => device)

/** "every 5 s", "every 2 min": how often a device is read. */
export const every = (intervalMs: number) => {
  const seconds = intervalMs / 1000
  if (seconds < 60) return `every ${Number(seconds.toFixed(1))} s`
  if (seconds < 3600) return `every ${Number((seconds / 60).toFixed(1))} min`
  return `every ${Number((seconds / 3600).toFixed(1))} h`
}

/**
 * Since when, in steps that don't count every second: "under a minute", "4 min", "3 h", "2 d". For a device that
 * stopped answering, where the seconds don't matter and a ticking number would only distract.
 */
export const since = (then: number | undefined, now: number) => {
  if (then === undefined) return "never"
  const seconds = Math.max(0, (now - then) / 1000)
  if (seconds < 60) return "under a minute"
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`
  return `${Math.floor(seconds / 86_400)} d`
}

/**
 * A moment as a clock time (14:02:31), with the date when it is not today (Nov 4 09:00:00), in the browser's time
 * zone but the same words in every locale. Unlike "12 s ago", it does not change while you look.
 */
export const clockTime = (at: number, now: number) => {
  const moment = new Date(at)
  const time = moment.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  })
  return moment.toDateString() === new Date(now).toDateString()
    ? time
    : `${moment.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`
}

/**
 * How long something lasted, to the precision that matters: seconds under two minutes ("61 s"), then minutes
 * ("3 min"), hours and minutes ("2 h 5 min"), days and hours ("3 d 4 h").
 */
export const duration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 120) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`
}

/** Since when, as a clock time and how long ago: "12:18:20 (3 min)". */
export const sinceClock = (at: number, now: number) => `${clockTime(at, now)} (${duration(now - at)})`

/** "0.4 %", "37 %": how full the buffer is; under 1 % keeps a decimal, so a filling buffer never reads 0 %. */
export const fillPercent = (rows: number, maxRows: number) => {
  const percent = (rows / maxRows) * 100
  return percent < 1 ? `${Math.max(percent, 0.1).toFixed(1)} %` : `${Math.round(percent)} %`
}

/** Bytes as people read them: 312 MB, 1.4 GB. */
export const formatBytes = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** What a topic under `site/building/` carries, by its shape (README, "Topics"). */
export type TopicKind = "value" | "metadata" | "health" | "command result" | "other"

export const topicKind = (topic: string): TopicKind => {
  const parts = topic.split("/")
  if (parts[2] === "$gateway" && parts[4] === "health") return "health"
  if (parts.length === 4) return "value"
  if (parts.length === 5 && parts[4] === "$meta") return "metadata"
  if (parts.length === 6 && parts[4] === "$set" && parts[5] === "result") return "command result"
  return "other"
}
