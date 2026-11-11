/**
 * Energy counters: points whose unit is an energy unit (Wh, kWh, MWh, GWh or J, `isEnergyUnit`) are a meter's
 * reading, which only rises, and about as fast as the site uses energy. Every read of one goes through here, and a
 * read that does not fit becomes a warning: an event in the events ring (`/api/events`'s `valueEvents`, `ot-gateway
 * events`, the last 15 minutes of `ot-gateway status`) and a count in `ot_gateway_counter_implausible`. The value is
 * published all the same: this warns, it does not filter.
 *
 * - **went back**: lower than the read before. A meter that was reset or replaced, or another device answering at
 *   its address. A point whose id or name says it counts per day (`today`, `daily`) resets every midnight, so its
 *   falls are not reported.
 * - **jumped**: the rise since the last read is more than `COUNTER_RATE_FACTOR` (10) times what the counter's fastest
 *   rise of the last hour would add in that time, and more than a minimum step: 1 kWh (in the counter's unit) and
 *   0.1 % of its reading, so a small or quantized counter's noise and a building that switches its load on do not
 *   count. The fastest rise is the highest rate between two reads at least a second apart, kept per minute for the
 *   last hour; a counter is judged only once it has `COUNTER_MIN_RATES` such rates over at least 5 minutes. Across
 *   an outage the rule holds as it is: two minutes without reads allow ten times two minutes at the fastest rate.
 *   A jump does not count towards the fastest rate, so it cannot hide the next one.
 *
 * One event per episode: after an event, a point's further implausible reads are counted, not listed, until it has
 * read plausibly for `COUNTER_EPISODE_MS` (15 min). All counters together list at most `COUNTER_EVENTS_PER_GATEWAY`
 * events in 15 minutes, so they cannot push the devices' failures out of the ring.
 *
 * Memory is fixed per counter point (two 60-slot arrays); a read of a point that is no counter costs one map lookup.
 * Durations run on the monotonic clock (NTP steps the wall clock of a Pi).
 */
import { COUNTER_RATE_FACTOR, energyUnitInKwh } from "@ot-gateway/api"
import { counterImplausible, type GatewayConfig, type HistorySink } from "@ot-gateway/core"
import { type Clock, type Context, Effect, Metric } from "effect"
import { makeWindowCount } from "./Alarms.ts"
import type { ValueEventInput } from "./Events.ts"

/** How far back a counter's fastest rise is taken from: the last hour, in one-minute slots. */
export const COUNTER_BASELINE_MINUTES = 60

/** Rates a counter needs, over at least `COUNTER_WARMUP_MS`, before a rise is judged. */
export const COUNTER_MIN_RATES = 5
export const COUNTER_WARMUP_MS = 5 * 60_000

/** Two reads closer than this give no rate: a pushed value right after a poll would make one up from noise. */
export const COUNTER_MIN_INTERVAL_MS = 1000

/** The smallest jump, in kWh and as a share of the reading. */
export const COUNTER_MIN_STEP_KWH = 1
export const COUNTER_MIN_STEP_SHARE = 0.001

/** After an event, a point's implausible reads are counted, not listed, until it reads plausibly this long. */
export const COUNTER_EPISODE_MS = 15 * 60_000

/** Counter events all points together list in 15 minutes. */
export const COUNTER_EVENTS_PER_GATEWAY = 30

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

/** A point whose id or name says it counts per day: it falls to 0 every midnight, which is no meter swap. */
const DAILY = /today|daily/i

/** The fastest rate per minute over the last hour, in fixed memory, on the monotonic clock. */
const makeRateWindow = () => {
  const minutes = new Float64Array(COUNTER_BASELINE_MINUTES).fill(Number.NEGATIVE_INFINITY)
  const rates = new Float64Array(COUNTER_BASELINE_MINUTES)
  const slotOf = (minute: number) =>
    ((minute % COUNTER_BASELINE_MINUTES) + COUNTER_BASELINE_MINUTES) % COUNTER_BASELINE_MINUTES
  return {
    add: (nowMs: number, rate: number) => {
      const minute = Math.floor(nowMs / MINUTE_MS)
      const slot = slotOf(minute)
      if (minutes[slot] !== minute) {
        minutes[slot] = minute
        rates[slot] = rate
      } else rates[slot] = Math.max(rates[slot] ?? 0, rate)
    },
    /** The highest rate of the last hour, per ms; 0 without one. */
    highest: (nowMs: number) => {
      const minute = Math.floor(nowMs / MINUTE_MS)
      let highest = 0
      for (let slot = 0; slot < COUNTER_BASELINE_MINUTES; slot++) {
        if ((minutes[slot] ?? Number.NEGATIVE_INFINITY) > minute - COUNTER_BASELINE_MINUTES) {
          highest = Math.max(highest, rates[slot] ?? 0)
        }
      }
      return highest
    }
  }
}

/** What the tracker keeps of one counter point. */
interface CounterPoint {
  readonly device: string
  readonly point: string
  readonly unit: string
  /** One of its unit in kWh, for the minimum step. */
  readonly perUnitKwh: number
  /** It counts per day and resets at midnight: a fall is expected. */
  readonly daily: boolean
  /** The last read's value, and when it came (monotonic ms); undefined before the first. */
  last: { value: number; at: number } | undefined
  readonly rates: ReturnType<typeof makeRateWindow>
  /** Rates known, and when the first came (monotonic ms): it is judged once there are enough over long enough. */
  rateCount: number
  firstRateAt: number | undefined
  /** Monotonic ms of its last implausible read: the episode lasts until `COUNTER_EPISODE_MS` after it. */
  implausibleAt: number | undefined
}

export interface CounterTracker {
  /** Every read of every point; only energy counters do anything. */
  readonly sink: HistorySink
  /**
   * The counter points of `config` from now on, with the metric attributes of the calling context. A point that keeps
   * its unit keeps what was learnt of it, so a config applied from the page does not start it over.
   */
  readonly configure: (config: GatewayConfig) => Effect.Effect<void>
  /** Whether the running config has counter points: without, the reads need not come here at all. */
  readonly hasPoints: () => boolean
}

/** The tracker on `clock`, recording its events with `record`. */
export const makeCounterTracker = (clock: Clock.Clock, record: (event: ValueEventInput) => void): CounterTracker => {
  const monotonicMs = () => Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n)
  /** device → point → state; a device without counter points is not in it. */
  let byDevice = new Map<string, Map<string, CounterPoint>>()
  let count = 0
  const listed = makeWindowCount()
  let context: Context.Context<never> | undefined
  const wentBackMetric = Metric.withAttributes(counterImplausible, { kind: "went-back" })
  const jumpedMetric = Metric.withAttributes(counterImplausible, { kind: "jumped" })

  /** Counts an implausible read, and lists `event` when it starts an episode and the gateway's budget allows. */
  const implausible = (state: CounterPoint, event: ValueEventInput, now: number) => {
    if (context !== undefined)
      (event.type === "counter-jumped" ? jumpedMetric : wentBackMetric).updateUnsafe(1, context)
    const ongoing = state.implausibleAt !== undefined && now - state.implausibleAt < COUNTER_EPISODE_MS
    state.implausibleAt = now
    if (ongoing || listed.total(now) >= COUNTER_EVENTS_PER_GATEWAY) return
    listed.add(now)
    record(event)
  }

  return {
    sink: {
      record: (device, point, value) => {
        const state = byDevice.get(device)?.get(point)
        if (state === undefined || typeof value !== "number") return
        const now = monotonicMs()
        const last = state.last
        if (last === undefined) {
          state.last = { value, at: now }
          return
        }
        const rise = value - last.value
        const subject = { device: state.device, point: state.point, unit: state.unit, from: last.value, to: value }
        if (rise < 0) {
          // A float that reads back a hair lower is no meter swap.
          if (!state.daily && -rise > Math.abs(last.value) * 1e-9) {
            implausible(state, { type: "counter-went-back", ...subject }, now)
          }
          state.last = { value, at: now }
          return
        }
        const elapsed = now - last.at
        // Too close to the last read for a rate: compared with the next one instead.
        if (elapsed < COUNTER_MIN_INTERVAL_MS) return
        state.last = { value, at: now }
        const highest = state.rates.highest(now)
        const judged =
          state.rateCount >= COUNTER_MIN_RATES &&
          state.firstRateAt !== undefined &&
          now - state.firstRateAt >= COUNTER_WARMUP_MS
        const minimumStep = Math.max(
          COUNTER_MIN_STEP_KWH / state.perUnitKwh,
          Math.abs(last.value) * COUNTER_MIN_STEP_SHARE
        )
        if (judged && rise > COUNTER_RATE_FACTOR * highest * elapsed && rise > minimumStep) {
          implausible(
            state,
            { type: "counter-jumped", ...subject, elapsedMs: elapsed, usualPerHour: highest * HOUR_MS },
            now
          )
          return
        }
        state.rates.add(now, rise / elapsed)
        state.rateCount++
        state.firstRateAt ??= now
      }
    },
    configure: (config) =>
      Effect.map(Effect.context(), (current) => {
        context = current
        const previous = byDevice
        const next = new Map<string, Map<string, CounterPoint>>()
        count = 0
        for (const device of config.devices) {
          for (const point of device.points) {
            const perUnitKwh = energyUnitInKwh(point.unit)
            if (point.unit === undefined || perUnitKwh === undefined) continue
            const kept = previous.get(device.id)?.get(point.id)
            const state: CounterPoint =
              kept !== undefined && kept.unit === point.unit
                ? kept
                : {
                    device: device.id,
                    point: point.id,
                    unit: point.unit,
                    perUnitKwh,
                    daily: DAILY.test(point.id) || DAILY.test(point.name),
                    last: undefined,
                    rates: makeRateWindow(),
                    rateCount: 0,
                    firstRateAt: undefined,
                    implausibleAt: undefined
                  }
            const points = next.get(device.id) ?? new Map<string, CounterPoint>()
            points.set(point.id, state)
            next.set(device.id, points)
            count++
          }
        }
        byDevice = next
      }),
    hasPoints: () => count > 0
  }
}
