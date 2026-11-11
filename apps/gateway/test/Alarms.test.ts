/**
 * Alarm points: changes become events, states never do; a chattering contact is coalesced and counted; the status
 * reports each alarm point; the metrics count every change. On the test clock.
 */
import { describe, expect, it } from "@effect/vitest"
import {
  alarmChanges,
  alarmsActive,
  type GatewayConfig,
  makeHealthRegistry,
  parseConfig,
  withMetricAttributes
} from "@ot-gateway/core"
import { Clock, Effect, Metric } from "effect"
import { TestClock } from "effect/testing"
import { makeStatusState } from "../src/Status.ts"
import {
  ALARM_EVENTS_PER_GATEWAY,
  ALARM_EVENTS_PER_POINT,
  type AlarmTracker,
  isAlarmActive,
  makeAlarmTracker
} from "../src/Alarms.ts"
import type { AlarmEventInput } from "../src/Events.ts"

const configWith = (points: ReadonlyArray<Record<string, unknown>>) =>
  parseConfig(
    JSON.stringify({
      site: "s",
      building: "b",
      mqtt: { url: "mqtt://broker" },
      devices: [{ protocol: "simulator", id: "pump", points }]
    })
  )

const trip = { id: "trip", name: "Trip", alarmWhen: "on", waveform: "constant", min: 0, max: 0 }
const contact = { id: "contact", name: "Contact", alarmWhen: "off", waveform: "constant", min: 1, max: 1 }
const speed = { id: "speed", name: "Speed", waveform: "constant", min: 0, max: 0 }

/** A tracker on the test clock, configured for `config`, and the events it recorded. */
const tracker = (config: GatewayConfig) =>
  Effect.gen(function* () {
    const recorded: Array<AlarmEventInput> = []
    const alarms = makeAlarmTracker(yield* Clock.clockWith(Effect.succeed), (event) => recorded.push(event))
    yield* alarms.configure(config)
    return { alarms, recorded }
  })

/** A read of `point` now, on the test clock's wall time. */
const read = (alarms: AlarmTracker, point: string, value: number | boolean) =>
  Effect.map(Clock.currentTimeMillis, (now) => alarms.sink.record("pump", point, value, now))

describe("alarm points", () => {
  it("are active on true or not 0 for alarmWhen on, on false or 0 for off", () => {
    expect([true, 1, -2, false, 0].map((value) => isAlarmActive("on", value))).toEqual([true, true, true, false, false])
    expect([true, 1, false, 0].map((value) => isAlarmActive("off", value))).toEqual([false, false, true, true])
  })

  it.effect("record changes, not states: raised, cleared with how long, and nothing for a point that is no alarm", () =>
    Effect.gen(function* () {
      const { alarms, recorded } = yield* tracker(yield* configWith([trip, contact, speed]))
      expect(alarms.hasPoints()).toBe(true)
      yield* read(alarms, "trip", 0)
      yield* read(alarms, "contact", 1)
      yield* read(alarms, "speed", 1)
      // Off at the first read is no event; reads that keep it as it is are none either.
      for (let cycle = 0; cycle < 10; cycle++) yield* read(alarms, "trip", 0)
      expect(recorded).toEqual([])
      yield* TestClock.adjust("1 minute")
      yield* read(alarms, "trip", 1)
      yield* read(alarms, "trip", 1)
      yield* TestClock.adjust("90 seconds")
      yield* read(alarms, "trip", 0)
      yield* read(alarms, "contact", 0)
      expect(recorded).toEqual([
        { type: "alarm-raised", device: "pump", point: "trip", value: 1 },
        { type: "alarm-cleared", device: "pump", point: "trip", value: 0, activeMs: 90_000 },
        { type: "alarm-raised", device: "pump", point: "contact", value: 0 }
      ])
      expect(alarms.snapshot()).toEqual([
        { device: "pump", point: "trip", alarmWhen: "on", active: false, since: 150_000, raised: 1, flapping: false },
        { device: "pump", point: "contact", alarmWhen: "off", active: true, since: 150_000, raised: 1, flapping: false }
      ])
    })
  )

  it.effect("raise an alarm that is active at its first read, and keep the state across a new config", () =>
    Effect.gen(function* () {
      const { alarms, recorded } = yield* tracker(yield* configWith([trip]))
      yield* read(alarms, "trip", true)
      expect(recorded).toEqual([{ type: "alarm-raised", device: "pump", point: "trip", value: true, first: true }])
      yield* alarms.configure(yield* configWith([trip, speed]))
      yield* read(alarms, "trip", true)
      expect(recorded).toHaveLength(1)
      // A config without alarm points: the reads need not come here.
      yield* alarms.configure(yield* configWith([speed]))
      expect(alarms.hasPoints()).toBe(false)
      expect(alarms.snapshot()).toEqual([])
    })
  )

  it.effect("coalesce a chattering contact: a few changes, one flapping event, then one when it keeps still", () =>
    Effect.gen(function* () {
      const { alarms, recorded } = yield* tracker(yield* configWith([trip]))
      yield* read(alarms, "trip", 0)
      // Every 30 s for an hour: 120 changes.
      for (let change = 0; change < 120; change++) {
        yield* TestClock.adjust("30 seconds")
        yield* read(alarms, "trip", change % 2 === 0 ? 1 : 0)
      }
      expect(recorded).toHaveLength(ALARM_EVENTS_PER_POINT + 1)
      // How it flaps, from its first read to the change that made it flapping: on 30 s, off 30 s, 4 times.
      expect(recorded.at(-1)).toEqual({
        type: "alarm-flapping",
        device: "pump",
        point: "trip",
        raised: 4,
        pattern: { onMs: 30_000, offMs: 30_000, raised: 4, overMs: 210_000 }
      })
      // Raised every minute; the window is the current minute and the 14 before it. The pattern: its last 16 changes.
      expect(alarms.snapshot()[0]).toMatchObject({
        active: false,
        flapping: true,
        raised: 14,
        pattern: { onMs: 30_000, offMs: 30_000, raised: 8, overMs: 450_000 }
      })
      // It keeps still: reads within 5 min say nothing; the first after 5 min settles it.
      yield* TestClock.adjust("4 minutes")
      yield* read(alarms, "trip", 0)
      expect(recorded).toHaveLength(ALARM_EVENTS_PER_POINT + 1)
      yield* TestClock.adjust("1 minute")
      yield* read(alarms, "trip", 0)
      expect(recorded.at(-1)).toEqual({
        type: "alarm-settled",
        device: "pump",
        point: "trip",
        active: false,
        since: 3_600_000,
        unlisted: 120 - ALARM_EVENTS_PER_POINT,
        // Up to its last change: the five minutes it kept still are not part of the pattern.
        pattern: { onMs: 30_000, offMs: 30_000, raised: 8, overMs: 450_000 }
      })
      // Listed again from here.
      yield* read(alarms, "trip", 1)
      expect(recorded.at(-1)).toMatchObject({ type: "alarm-raised" })
      expect(alarms.snapshot()[0]).toMatchObject({ flapping: false })
    })
  )

  it.effect("list at most a gateway's budget of alarm events in 15 min, however many points change", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 100 }, (_, index) => ({ ...trip, id: `trip-${index}`, name: `Trip ${index}` }))
      const { alarms, recorded } = yield* tracker(yield* configWith(many))
      for (const point of many) yield* read(alarms, point.id, 0)
      for (const point of many) yield* read(alarms, point.id, 1)
      expect(recorded).toHaveLength(ALARM_EVENTS_PER_GATEWAY)
      // The ones over the budget settle like a flapping point, once there is room again.
      expect(alarms.snapshot().filter((alarm) => alarm.flapping)).toHaveLength(100 - ALARM_EVENTS_PER_GATEWAY)
      yield* TestClock.adjust("16 minutes")
      for (const point of many) yield* read(alarms, point.id, 1)
      expect(recorded.at(-1)).toMatchObject({ type: "alarm-settled", active: true, unlisted: 1 })
    })
  )

  it.effect("count every change in the metrics and keep the active ones in a gauge", () =>
    Effect.gen(function* () {
      const counts = Effect.all(
        ["raised", "cleared"].map((transition) =>
          Effect.map(
            Metric.value(Metric.withAttributes(alarmChanges, { transition, site: "metrics-test" })),
            (state) => state.count
          )
        )
      )
      const { alarms } = yield* tracker(yield* configWith([trip, contact])).pipe(
        withMetricAttributes({ site: "metrics-test" })
      )
      const before = yield* counts
      yield* read(alarms, "contact", 0)
      // Active at the first read, then 19 changes: 9 more raises and 10 clears, most of them unlisted.
      for (let change = 0; change < 20; change++) yield* read(alarms, "trip", change % 2 === 0 ? 1 : 0)
      const after = yield* counts
      expect(after.map((count, index) => count - (before[index] ?? 0))).toEqual([11, 10])
      expect((yield* Metric.value(Metric.withAttributes(alarmsActive, { site: "metrics-test" }))).value).toBe(1)
    })
  )
})

describe("the status of alarm points", () => {
  it.effect("lists every alarm point, also without the points, and marks the active ones among the points", () =>
    Effect.gen(function* () {
      const config = yield* configWith([trip, contact, speed])
      const { alarms } = yield* tracker(config)
      const state = makeStatusState(config, makeHealthRegistry(["pump"]), 0, undefined, 0, alarms)
      yield* read(alarms, "trip", 1)
      const lean = yield* state.snapshot("none")
      expect(lean.alarms).toEqual([
        { device: "pump", point: "trip", alarmWhen: "on", active: true, since: 0, raised: 1, flapping: false },
        { device: "pump", point: "contact", alarmWhen: "off", raised: 0, flapping: false }
      ])
      const full = yield* state.snapshot("all")
      expect(full.devices[0]?.points.map((point) => [point.id, point.alarmWhen, point.alarmActive])).toEqual([
        ["trip", "on", true],
        ["contact", "off", undefined],
        ["speed", undefined, undefined]
      ])
      // Without alarm points, no `alarms` at all.
      const plain = yield* configWith([speed])
      expect(yield* makeStatusState(plain, makeHealthRegistry(["pump"]), 0).snapshot("none")).not.toHaveProperty(
        "alarms"
      )
    })
  )
})
