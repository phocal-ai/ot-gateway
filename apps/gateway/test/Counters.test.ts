/**
 * Energy counters: a reading that goes back or jumps far faster than the counter's fastest rise of the last hour
 * becomes one event per episode and a count in the metric; a daily counter's midnight reset and a rise across an
 * outage do not. On the test clock.
 */
import { describe, expect, it } from "@effect/vitest"
import { counterImplausible, type GatewayConfig, parseConfig, withMetricAttributes } from "@ot-gateway/core"
import { Clock, Effect, Metric } from "effect"
import { TestClock } from "effect/testing"
import { COUNTER_EPISODE_MS, type CounterTracker, makeCounterTracker } from "../src/Counters.ts"
import type { ValueEventInput } from "../src/Events.ts"

const configWith = (points: ReadonlyArray<Record<string, unknown>>) =>
  parseConfig(
    JSON.stringify({
      site: "s",
      building: "b",
      mqtt: { url: "mqtt://broker" },
      devices: [{ protocol: "simulator", id: "meter", points }]
    })
  )

const counter = (id: string, name: string, unit = "unit:KiloW-HR") => ({
  id,
  name,
  unit,
  waveform: "constant",
  min: 0,
  max: 0
})
const total = counter("energy-total", "Energy total")
const today = counter("energy-today", "Energy today")
const power = { id: "power", name: "Power", unit: "unit:KiloW", waveform: "constant", min: 0, max: 0 }

/** A tracker on the test clock, configured for `config`, and the events it recorded. */
const tracker = (config: GatewayConfig) =>
  Effect.gen(function* () {
    const recorded: Array<ValueEventInput> = []
    const counters = makeCounterTracker(yield* Clock.clockWith(Effect.succeed), (event) => recorded.push(event))
    yield* counters.configure(config)
    return { counters, recorded }
  })

/** A read of `point` now, on the test clock's wall time. */
const read = (counters: CounterTracker, point: string, value: number | boolean) =>
  Effect.map(Clock.currentTimeMillis, (now) => counters.sink.record("meter", point, value, now))

/** Reads every 10 s for `minutes`, rising 0.01 kWh each (3.6 kWh/h), from `from`; 10 s after the last, its value. */
const steady = (counters: CounterTracker, point: string, from: number, minutes: number) =>
  Effect.gen(function* () {
    let value = from
    for (let step = 0; step < minutes * 6; step++) {
      if (step > 0) value = Math.round((value + 0.01) * 1000) / 1000
      yield* read(counters, point, value)
      yield* TestClock.adjust("10 seconds")
    }
    return value
  })

describe("energy counters", () => {
  it.effect("tracks only points in an energy unit", () =>
    Effect.gen(function* () {
      const { counters, recorded } = yield* tracker(yield* configWith([power]))
      expect(counters.hasPoints()).toBe(false)
      yield* read(counters, "power", 100)
      yield* read(counters, "power", 1)
      expect(recorded).toEqual([])
    })
  )

  it.effect("reports a counter that went back, once per episode", () =>
    Effect.gen(function* () {
      const { counters, recorded } = yield* tracker(yield* configWith([total]))
      expect(counters.hasPoints()).toBe(true)
      yield* read(counters, "energy-total", 12_000)
      yield* TestClock.adjust("10 seconds")
      yield* read(counters, "energy-total", 12_000.5)
      yield* TestClock.adjust("10 seconds")
      // The bench restarted: the meter reads its start again.
      yield* read(counters, "energy-total", 4_270)
      yield* TestClock.adjust("10 seconds")
      yield* read(counters, "energy-total", 4_000)
      expect(recorded).toEqual([
        {
          type: "counter-went-back",
          device: "meter",
          point: "energy-total",
          unit: "unit:KiloW-HR",
          from: 12_000.5,
          to: 4_270
        }
      ])
      // Once it has read plausibly for the episode's length, the next fall is a new event.
      yield* TestClock.adjust(COUNTER_EPISODE_MS)
      yield* read(counters, "energy-total", 4_001)
      yield* TestClock.adjust("10 seconds")
      yield* read(counters, "energy-total", 10)
      expect(recorded).toHaveLength(2)
    })
  )

  it.effect("lets a daily counter fall at midnight, and a float that reads a hair lower", () =>
    Effect.gen(function* () {
      const { counters, recorded } = yield* tracker(
        yield* configWith([today, counter("consumption", "Consumption daily"), total])
      )
      yield* read(counters, "energy-today", 41.2)
      yield* read(counters, "consumption", 18)
      yield* read(counters, "energy-total", 0.30000000000000004)
      yield* TestClock.adjust("10 seconds")
      yield* read(counters, "energy-today", 0)
      yield* read(counters, "consumption", 0)
      yield* read(counters, "energy-total", 0.3)
      expect(recorded).toEqual([])
    })
  )

  it.effect("reports a jump far faster than the last hour's fastest rise, once warmed up", () =>
    Effect.gen(function* () {
      const { counters, recorded } = yield* tracker(yield* configWith([total]))
      const last = yield* steady(counters, "energy-total", 1_000, 6)
      yield* read(counters, "energy-total", last + 500)
      expect(recorded).toEqual([
        {
          type: "counter-jumped",
          device: "meter",
          point: "energy-total",
          unit: "unit:KiloW-HR",
          from: last,
          to: last + 500,
          elapsedMs: 10_000,
          usualPerHour: expect.closeTo(3.6, 3)
        }
      ])
    })
  )

  it.effect("judges no rise before it knows the counter's pace", () =>
    Effect.gen(function* () {
      const { counters, recorded } = yield* tracker(yield* configWith([total]))
      const last = yield* steady(counters, "energy-total", 1_000, 1)
      yield* read(counters, "energy-total", last + 500)
      expect(recorded).toEqual([])
    })
  )

  it.effect("allows an outage's worth of rise, and a step below the minimum", () =>
    Effect.gen(function* () {
      const { counters, recorded } = yield* tracker(yield* configWith([total]))
      const last = yield* steady(counters, "energy-total", 1_000, 6)
      // Two minutes without a read, then what two minutes at the usual pace add, and some.
      yield* TestClock.adjust("2 minutes")
      yield* read(counters, "energy-total", last + 0.3)
      yield* TestClock.adjust("10 seconds")
      // Ten times faster than usual, but under 1 kWh: a building switching its load on, not a meter swap.
      yield* read(counters, "energy-total", last + 0.3 + 0.9)
      expect(recorded).toEqual([])
    })
  )

  it.effect("counts every implausible read in the metric, listed or not", () =>
    Effect.gen(function* () {
      const counts = Effect.all(
        ["went-back", "jumped"].map((kind) =>
          Effect.map(
            Metric.value(Metric.withAttributes(counterImplausible, { kind, site: "counter-test" })),
            (state) => state.count
          )
        )
      )
      const { counters, recorded } = yield* tracker(yield* configWith([total])).pipe(
        withMetricAttributes({ site: "counter-test" })
      )
      const before = yield* counts
      yield* read(counters, "energy-total", 100)
      for (let fall = 1; fall <= 3; fall++) {
        yield* TestClock.adjust("10 seconds")
        yield* read(counters, "energy-total", 100 - fall)
      }
      const after = yield* counts
      expect(after.map((count, index) => count - (before[index] ?? 0))).toEqual([3, 0])
      expect(recorded).toHaveLength(1)
    })
  )
})
