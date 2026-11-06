/**
 * How a point's values go out, separately from how often the device is read (`pollIntervalMs`):
 *
 * - `sample`: the latest value, on every read (the default) or once per `intervalMs`. "The temperature now",
 *   for dashboards and digital twins.
 * - `aggregate`: once per `intervalMs`, what happened in that window: minimum, maximum, time-weighted average,
 *   last value and number of reads. For energy reports and analytics.
 * - `change`: when the value moves by at least `deadband` (any change without one), or arrives by BACnet
 *   change-of-value, and again after `maxSilenceMs` without one. For states, alarms and setpoints.
 *
 * Windows are aligned to the clock: a 15-minute window closes at :00, :15, :30 and :45 UTC, on every gateway,
 * so its values line up with meter intervals and with each other. That is why an interval must divide a day.
 * Everything here is pure; the pipeline (`Pipeline.ts`) holds the state and the timers.
 */
import { Schema } from "effect"

const DAY_MS = 86_400_000

/** A publish interval: from a second to a day, and a whole fraction of a day so windows align to the clock. */
const PublishIntervalMs = Schema.Int.pipe(
  Schema.check(
    Schema.isBetween({ minimum: 1_000, maximum: DAY_MS }),
    Schema.makeFilter(
      (ms) =>
        DAY_MS % ms === 0 || "must divide a day evenly, so windows line up with the clock (60000, 300000, 900000…)"
    )
  )
)

export const SamplePublish = Schema.Struct({
  mode: Schema.Literal("sample"),
  /** Send the latest value once per interval instead of on every read. */
  intervalMs: Schema.optionalKey(PublishIntervalMs)
})
export type SamplePublish = typeof SamplePublish.Type

export const AggregatePublish = Schema.Struct({
  mode: Schema.Literal("aggregate"),
  /** The window: one message per point per interval. */
  intervalMs: PublishIntervalMs
})
export type AggregatePublish = typeof AggregatePublish.Type

export const ChangePublish = Schema.Struct({
  mode: Schema.Literal("change"),
  /** Minimum change, after scaling, before a value is sent again; without it, any change. */
  deadband: Schema.optionalKey(Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  /** Send the value again after this long without a change, so a consumer can tell quiet from gone. */
  maxSilenceMs: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1_000, maximum: DAY_MS }))))
})
export type ChangePublish = typeof ChangePublish.Type

export const Publish = Schema.Union([SamplePublish, AggregatePublish, ChangePublish])
export type Publish = typeof Publish.Type

/** Every read, as it comes: the default when neither the point nor its device says otherwise. */
export const everyRead: SamplePublish = { mode: "sample" }

/**
 * A point's publish mode: its own `publish`, else its `deadband` as change mode (the short form), else its
 * device's `publish`, else every read.
 */
export const publishOf = (
  device: Publish | undefined,
  point: { readonly publish?: Publish; readonly deadband?: number }
): Publish => {
  if (point.publish !== undefined) return point.publish
  if (point.deadband !== undefined) return { mode: "change", deadband: point.deadband }
  return device ?? everyRead
}

/** The interval at which a mode sends on a timer, if it does. */
export const windowIntervalMs = (publish: Publish): number | undefined =>
  publish.mode === "aggregate" ? publish.intervalMs : publish.mode === "sample" ? publish.intervalMs : undefined

/** The end of the clock-aligned window that `nowMs` falls in: the next multiple of `intervalMs` after it. */
export const windowEnd = (nowMs: number, intervalMs: number) => Math.floor(nowMs / intervalMs) * intervalMs + intervalMs

/**
 * One point's open window. Values are a step function: each holds from its read until the next, so the average
 * is weighted by how long each value held, which stays right when reads are irregular (BACnet change-of-value
 * pushes, retries, a slow device). Times are monotonic milliseconds; only the window's labels are wall time.
 */
export interface Window {
  /** The value in effect, carried into the next window: a value that did not change still held. */
  readonly held?: number | boolean
  readonly heldSince: number
  readonly count: number
  readonly min?: number
  readonly max?: number
  readonly last?: number | boolean
  readonly weightedSum: number
  readonly weightMs: number
  /** Wall time of the first read when the window started without a value (the gateway started inside it). */
  readonly firstReadAt?: number
}

export const openWindow = (atMono: number, held?: number | boolean): Window => ({
  ...(held === undefined ? {} : { held, last: held }),
  heldSince: atMono,
  count: 0,
  ...(typeof held === "number" ? { min: held, max: held } : {}),
  weightedSum: 0,
  weightMs: 0
})

const asNumber = (value: number | boolean) => (typeof value === "boolean" ? (value ? 1 : 0) : value)

/** The window with the time up to `atMono` credited to the value that held until then. */
const credit = (window: Window, atMono: number): Window => {
  if (window.held === undefined) return window
  const ms = Math.max(0, atMono - window.heldSince)
  return { ...window, weightedSum: window.weightedSum + asNumber(window.held) * ms, weightMs: window.weightMs + ms }
}

/** A read: `value` holds from `atMono` on; `readAt` is its wall time. */
export const addReading = (window: Window, value: number | boolean, atMono: number, readAt: number): Window => {
  const credited = credit(window, atMono)
  const numeric = typeof value === "number"
  return {
    ...credited,
    held: value,
    heldSince: atMono,
    count: credited.count + 1,
    last: value,
    ...(numeric ? { min: Math.min(credited.min ?? value, value), max: Math.max(credited.max ?? value, value) } : {}),
    // Nothing known yet in this window: it covers only from this read on.
    ...(credited.last === undefined ? { firstReadAt: readAt } : {})
  }
}

/**
 * The device stopped answering at `atMono`: the value it last gave no longer holds, so the outage does not count
 * towards the average. The next read starts holding again.
 */
export const interruptWindow = (window: Window, atMono: number): Window => {
  const credited = credit(window, atMono)
  const { held: _held, ...rest } = credited
  return { ...rest, heldSince: atMono }
}

/** What an aggregate message says about one window. */
export interface AggregateMessage {
  /** The average, so a consumer that only reads `value` gets a sensible number. For a boolean, the last value. */
  readonly value: number | boolean
  readonly min?: number
  readonly max?: number
  /** Time-weighted; for a boolean, the share of the window it was true (0 to 1). */
  readonly avg: number
  readonly last: number | boolean
  /** Reads in the window; 0 when the value held unchanged through it (a quiet change-of-value point). */
  readonly count: number
  /** The window, in Unix ms: `from` is later than the window's start when the gateway started inside it. */
  readonly from: number
  readonly to: number
  readonly ts: number
  readonly partial?: true
  readonly unit?: string
}

/**
 * Closes a window at `atMono`, labelled `[toMs - intervalMs, toMs)`. Returns the message, if the window had a
 * value at all, and the next window, which starts with the value that held at the close (none after an outage).
 */
export const closeWindow = (
  window: Window,
  atMono: number,
  toMs: number,
  intervalMs: number,
  unit: string | undefined
): { readonly message: AggregateMessage | undefined; readonly next: Window } => {
  const closed = credit(window, atMono)
  const next = openWindow(atMono, closed.held)
  // A window says something if it had a value at all: read in it, or carried in. One the device stopped answering
  // in still reports what it read before.
  if (closed.last === undefined) return { message: undefined, next }
  const avg = closed.weightMs > 0 ? closed.weightedSum / closed.weightMs : asNumber(closed.last)
  const start = toMs - intervalMs
  const from = closed.firstReadAt === undefined ? start : Math.max(start, Math.min(closed.firstReadAt, toMs))
  const numeric = typeof closed.last === "number"
  return {
    message: {
      value: numeric ? avg : closed.last,
      ...(numeric && closed.min !== undefined && closed.max !== undefined ? { min: closed.min, max: closed.max } : {}),
      avg,
      last: closed.last,
      count: closed.count,
      from,
      to: toMs,
      ts: toMs,
      ...(from > start ? { partial: true as const } : {}),
      ...(unit === undefined ? {} : { unit })
    },
    next
  }
}
