/**
 * Alarm points: the points a config marks with `alarmWhen` (a points list's `alarm` column). Every read of one goes
 * through here, and a change of its alarm (raised, cleared) becomes an event in the events ring (`/api/events`,
 * `ot-gateway events`), a count in `ot_gateway_alarm_changes` and the state `/api/status` reports per alarm point.
 *
 * Changes, not states (`.claude/rules/edge.md`, budget): a read that leaves the alarm as it was costs two map
 * lookups and nothing else. A read of a point that is no alarm costs one.
 *
 * A contact that chatters must not flood the 500-event ring, so the events are rate-limited, and nothing is lost
 * from the counts:
 * - a point lists at most `ALARM_EVENTS_PER_POINT` changes in 15 minutes. The next change records one
 *   `alarm-flapping` event, and from then on its changes are counted, not listed, until it has kept still for
 *   `ALARM_SETTLE_MS` (5 min). Its next read then records `alarm-settled`: how it stays, since when, and how many
 *   changes went unlisted. A chattering contact thus costs at most eight events per episode, however long it lasts.
 * - all alarm points together list at most `ALARM_EVENTS_PER_GATEWAY` events in 15 minutes, so many points flapping
 *   at once cannot push the devices' failures out of the ring either. A point over that budget counts its changes
 *   as unlisted and settles like a flapping one.
 * `raised` in the status counts every raise in the window, listed or not, and so do the metrics. The flapping and
 *   settled events, and the status while a point flaps, carry its `pattern` from its last 16 changes: how long it
 *   stays on and off on average, raised how often over how long ("on 30 s, off 30 s, 6 times in 6 min"), so the
 *   changes that are not listed are still described.
 *
 * Windows and durations run on the monotonic clock (NTP steps the wall clock of a Pi); `since` is the read's own
 * wall-clock time, as every timestamp the gateway shows.
 */
import { ALARM_SETTLE_MS, ALARM_WINDOW_MS, type AlarmPattern, type AlarmStatus } from "@ot-gateway/api"
import {
  alarmChanges,
  alarmsActive,
  type AlarmWhen,
  type GatewayConfig,
  type HistorySink,
  type PointValue
} from "@ot-gateway/core"
import { type Clock, type Context, Effect, Metric } from "effect"
import type { AlarmEventInput } from "./Events.ts"

/** Changes one alarm point lists in 15 minutes before it counts as flapping: three raised-and-cleared pairs. */
export const ALARM_EVENTS_PER_POINT = 6

/** Alarm events all points together list in 15 minutes: an eighth of the ring, so device failures stay in it. */
export const ALARM_EVENTS_PER_GATEWAY = 60

const MINUTE_MS = 60_000
const WINDOW_MINUTES = ALARM_WINDOW_MS / MINUTE_MS

/**
 * A count over the last 15 minutes, in one-minute slots on the monotonic clock: fixed memory however often it is
 * bumped. The window is the current minute and the 14 before it.
 */
const makeWindowCount = () => {
  const minutes = new Float64Array(WINDOW_MINUTES).fill(Number.NEGATIVE_INFINITY)
  const counts = new Uint32Array(WINDOW_MINUTES)
  const slotOf = (minute: number) => ((minute % WINDOW_MINUTES) + WINDOW_MINUTES) % WINDOW_MINUTES
  return {
    add: (nowMs: number) => {
      const minute = Math.floor(nowMs / MINUTE_MS)
      const slot = slotOf(minute)
      if (minutes[slot] !== minute) {
        minutes[slot] = minute
        counts[slot] = 0
      }
      counts[slot] = (counts[slot] ?? 0) + 1
    },
    total: (nowMs: number) => {
      const minute = Math.floor(nowMs / MINUTE_MS)
      let sum = 0
      for (let slot = 0; slot < WINDOW_MINUTES; slot++) {
        if ((minutes[slot] ?? Number.NEGATIVE_INFINITY) > minute - WINDOW_MINUTES) sum += counts[slot] ?? 0
      }
      return sum
    },
    reset: () => {
      minutes.fill(Number.NEGATIVE_INFINITY)
      counts.fill(0)
    }
  }
}
type WindowCount = ReturnType<typeof makeWindowCount>

/** Changes each alarm point remembers for its pattern: eight on and off cycles. */
export const PATTERN_CHANGES = 16

/** The last `PATTERN_CHANGES` changes of a point, in fixed memory: when (monotonic ms) and to which state. */
const makeChangeRing = () => {
  const times = new Float64Array(PATTERN_CHANGES)
  const states = new Uint8Array(PATTERN_CHANGES)
  let total = 0
  return {
    add: (atMs: number, active: boolean) => {
      times[total % PATTERN_CHANGES] = atMs
      states[total % PATTERN_CHANGES] = active ? 1 : 0
      total++
    },
    /**
     * The pattern of the changes kept, up to `nowMs`: the average of each closed stretch on and off (from one
     * change to the next), and the raises since the oldest change kept. Undefined with fewer than two changes.
     */
    pattern: (nowMs: number): AlarmPattern | undefined => {
      const kept = Math.min(total, PATTERN_CHANGES)
      if (kept < 2) return undefined
      const first = total - kept
      let onMs = 0
      let onCount = 0
      let offMs = 0
      let offCount = 0
      let raised = 0
      for (let index = first; index < total; index++) {
        const active = states[index % PATTERN_CHANGES] === 1
        if (active) raised++
        if (index + 1 >= total) continue
        const span = (times[(index + 1) % PATTERN_CHANGES] ?? 0) - (times[index % PATTERN_CHANGES] ?? 0)
        if (active) {
          onMs += span
          onCount++
        } else {
          offMs += span
          offCount++
        }
      }
      return {
        ...(onCount === 0 ? {} : { onMs: Math.round(onMs / onCount) }),
        ...(offCount === 0 ? {} : { offMs: Math.round(offMs / offCount) }),
        raised,
        overMs: nowMs - (times[first % PATTERN_CHANGES] ?? nowMs)
      }
    }
  }
}
type ChangeRing = ReturnType<typeof makeChangeRing>

/** What the tracker keeps of one alarm point. */
interface AlarmPoint {
  readonly device: string
  readonly point: string
  readonly alarmWhen: AlarmWhen
  /** Undefined before the first read. */
  active: boolean | undefined
  /** Wall-clock ms of the read that brought the current state. */
  since: number | undefined
  /** Monotonic ms of the last change (or the first read). */
  changedAt: number
  readonly raises: WindowCount
  readonly listed: WindowCount
  /** The last changes, for the pattern a flapping point reports. */
  readonly changes: ChangeRing
  /** Changes are counted, not listed, until it keeps still for `ALARM_SETTLE_MS`. */
  flapping: boolean
  unlisted: number
}

/** Whether `value` makes the alarm of a point with `alarmWhen` active: on is true or not 0, off is false or 0. */
export const isAlarmActive = (alarmWhen: AlarmWhen, value: PointValue) =>
  alarmWhen === "on" ? value === true || (typeof value === "number" && value !== 0) : value === false || value === 0

export interface AlarmTracker {
  /** Every read of every point; only alarm points do anything. */
  readonly sink: HistorySink
  /**
   * The alarm points of `config` from now on, with the metric attributes of the calling context. A point that keeps
   * its `alarmWhen` keeps its state, so a config applied from the page does not raise its active alarms again.
   */
  readonly configure: (config: GatewayConfig) => Effect.Effect<void>
  /** Whether the running config has alarm points: without, the reads need not come here at all. */
  readonly hasPoints: () => boolean
  /** Every alarm point of the running config, in config order. */
  readonly snapshot: () => ReadonlyArray<AlarmStatus>
}

/** The tracker on `clock`, recording its events with `record`. */
export const makeAlarmTracker = (clock: Clock.Clock, record: (event: AlarmEventInput) => void): AlarmTracker => {
  const monotonicMs = () => Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n)
  /** device → point → state; a device without alarm points is not in it. */
  let byDevice = new Map<string, Map<string, AlarmPoint>>()
  let ordered: ReadonlyArray<AlarmPoint> = []
  const listedByGateway = makeWindowCount()
  let activeCount = 0
  let context: Context.Context<never> | undefined
  const raisedMetric = Metric.withAttributes(alarmChanges, { transition: "raised" })
  const clearedMetric = Metric.withAttributes(alarmChanges, { transition: "cleared" })

  const updateGauge = () => {
    if (context !== undefined) alarmsActive.updateUnsafe(activeCount, context)
  }

  /** Lists `event` when the gateway's budget allows; false when it does not. */
  const list = (state: AlarmPoint, event: AlarmEventInput, now: number) => {
    if (listedByGateway.total(now) >= ALARM_EVENTS_PER_GATEWAY) return false
    listedByGateway.add(now)
    state.listed.add(now)
    record(event)
    return true
  }

  const settle = (state: AlarmPoint, now: number) => {
    // Up to its last change: the stillness since then is not part of how it flapped.
    const pattern = state.changes.pattern(state.changedAt)
    const listed = list(
      state,
      {
        type: "alarm-settled",
        device: state.device,
        point: state.point,
        active: state.active === true,
        since: state.since ?? 0,
        unlisted: state.unlisted,
        ...(pattern === undefined ? {} : { pattern })
      },
      now
    )
    if (!listed) return
    state.flapping = false
    state.unlisted = 0
    state.listed.reset()
  }

  const change = (state: AlarmPoint, active: boolean, value: PointValue, ts: number, now: number) => {
    const activeMs = now - state.changedAt
    state.active = active
    state.since = ts
    state.changedAt = now
    state.changes.add(now, active)
    activeCount += active ? 1 : -1
    if (context !== undefined) (active ? raisedMetric : clearedMetric).updateUnsafe(1, context)
    updateGauge()
    if (active) state.raises.add(now)
    if (state.flapping) {
      state.unlisted++
      return
    }
    if (state.listed.total(now) >= ALARM_EVENTS_PER_POINT) {
      state.flapping = true
      state.unlisted = 1
      const pattern = state.changes.pattern(now)
      list(
        state,
        {
          type: "alarm-flapping",
          device: state.device,
          point: state.point,
          raised: state.raises.total(now),
          ...(pattern === undefined ? {} : { pattern })
        },
        now
      )
      return
    }
    const event: AlarmEventInput = active
      ? { type: "alarm-raised", device: state.device, point: state.point, value }
      : { type: "alarm-cleared", device: state.device, point: state.point, value, activeMs }
    if (!list(state, event, now)) {
      state.flapping = true
      state.unlisted = 1
    }
  }

  const first = (state: AlarmPoint, active: boolean, value: PointValue, ts: number, now: number) => {
    state.active = active
    state.since = ts
    state.changedAt = now
    state.changes.add(now, active)
    if (!active) return
    activeCount++
    updateGauge()
    state.raises.add(now)
    if (context !== undefined) raisedMetric.updateUnsafe(1, context)
    if (!list(state, { type: "alarm-raised", device: state.device, point: state.point, value, first: true }, now)) {
      state.flapping = true
      state.unlisted = 1
    }
  }

  return {
    sink: {
      record: (device, point, value, ts) => {
        const state = byDevice.get(device)?.get(point)
        if (state === undefined) return
        const active = isAlarmActive(state.alarmWhen, value)
        if (active === state.active) {
          if (state.flapping) {
            const now = monotonicMs()
            if (now - state.changedAt >= ALARM_SETTLE_MS) settle(state, now)
          }
          return
        }
        const now = monotonicMs()
        if (state.active === undefined) first(state, active, value, ts, now)
        else change(state, active, value, ts, now)
      }
    },
    configure: (config) =>
      Effect.map(Effect.context(), (current) => {
        context = current
        const previous = byDevice
        const next = new Map<string, Map<string, AlarmPoint>>()
        const all: Array<AlarmPoint> = []
        for (const device of config.devices) {
          for (const point of device.points) {
            if (point.alarmWhen === undefined) continue
            const kept = previous.get(device.id)?.get(point.id)
            const state: AlarmPoint =
              kept !== undefined && kept.alarmWhen === point.alarmWhen
                ? kept
                : {
                    device: device.id,
                    point: point.id,
                    alarmWhen: point.alarmWhen,
                    active: undefined,
                    since: undefined,
                    changedAt: 0,
                    raises: makeWindowCount(),
                    listed: makeWindowCount(),
                    changes: makeChangeRing(),
                    flapping: false,
                    unlisted: 0
                  }
            const points = next.get(device.id) ?? new Map<string, AlarmPoint>()
            points.set(point.id, state)
            next.set(device.id, points)
            all.push(state)
          }
        }
        byDevice = next
        ordered = all
        activeCount = all.filter((state) => state.active === true).length
        updateGauge()
      }),
    hasPoints: () => ordered.length > 0,
    snapshot: () => {
      const now = monotonicMs()
      return ordered.map((state): AlarmStatus => {
        const pattern = state.flapping ? state.changes.pattern(state.changedAt) : undefined
        return {
          device: state.device,
          point: state.point,
          alarmWhen: state.alarmWhen,
          ...(state.active === undefined ? {} : { active: state.active }),
          ...(state.since === undefined ? {} : { since: state.since }),
          raised: state.raises.total(now),
          flapping: state.flapping,
          ...(pattern === undefined ? {} : { pattern })
        }
      })
    }
  }
}
