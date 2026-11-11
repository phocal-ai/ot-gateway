/** The incident ring: which transitions become events, their durations on the test clock, and its bound. */
import { describe, expect, it } from "@effect/vitest"
import { makeHealthRegistry } from "@ot-gateway/core"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { GatewayEvents, gatewayEventsLayer } from "../src/Events.ts"

const refused = "could not connect: connection refused by 127.0.0.1:5020"

describe("GatewayEvents", () => {
  it.effect("keeps every kind of event with its id and time, oldest first", () =>
    Effect.gen(function* () {
      const events = yield* GatewayEvents
      yield* TestClock.setTime(1_000)
      events.started("v1.2.3", 2)
      events.brokerConnected(undefined)
      events.bufferDrained()
      const log = yield* events.log()
      expect(log).toEqual({
        events: [
          { id: 1, at: 1_000, type: "gateway-started", version: "v1.2.3", devices: 2 },
          { id: 2, at: 1_000, type: "broker-connected" },
          { id: 3, at: 1_000, type: "buffer-drained" }
        ],
        capacity: 500,
        dropped: 0
      })
    }).pipe(Effect.provide(gatewayEventsLayer()))
  )

  it.effect("turns a device's ok-to-failing and failing-to-ok into events, with how long it was down", () =>
    Effect.gen(function* () {
      const events = yield* GatewayEvents
      const registry = makeHealthRegistry(["energy-meter"])
      registry.onChange(events.deviceChanged)
      // Starting to ok is no incident; nor is a read that keeps it ok.
      registry.recordSuccess("energy-meter", 0)
      registry.recordSuccess("energy-meter", 1)
      yield* TestClock.adjust("10 seconds")
      registry.recordFailure("energy-meter", { reason: "connection", message: refused, at: 10_000 })
      yield* TestClock.adjust("5 seconds")
      // Still failing, even for another reason: no new event.
      registry.recordFailure("energy-meter", { reason: "timeout", message: "no response", at: 15_000 })
      yield* TestClock.adjust("85 seconds")
      registry.recordSuccess("energy-meter", 100_000)
      const { events: kept } = yield* events.log()
      expect(kept).toEqual([
        { id: 1, at: 10_000, type: "device-failing", device: "energy-meter", reason: "connection", error: refused },
        { id: 2, at: 100_000, type: "device-recovered", device: "energy-meter", downMs: 90_000 }
      ])
    }).pipe(Effect.provide(gatewayEventsLayer()))
  )

  it.effect("makes one event of a broker outage however many redials fail, and says how long and what waited", () =>
    Effect.gen(function* () {
      const events = yield* GatewayEvents
      events.brokerConnected(0)
      yield* TestClock.adjust("1 minute")
      events.brokerDisconnected("connection closed by the peer")
      for (let redial = 0; redial < 20; redial++) {
        yield* TestClock.adjust("15 seconds")
        events.brokerDisconnected("could not connect: connection refused by 10.0.0.5:1883")
      }
      events.brokerConnected(1_204)
      const { events: kept } = yield* events.log()
      expect(kept.map((event) => event.type)).toEqual(["broker-connected", "broker-disconnected", "broker-connected"])
      expect(kept[1]).toMatchObject({ error: "connection closed by the peer", at: 60_000 })
      expect(kept[2]).toMatchObject({ downMs: 300_000, buffered: 1_204 })
    }).pipe(Effect.provide(gatewayEventsLayer()))
  )

  it.effect("measures durations on the monotonic clock, not the wall clock NTP steps", () =>
    Effect.gen(function* () {
      const events = yield* GatewayEvents
      events.brokerDisconnected("connection closed by the peer")
      yield* TestClock.adjust("30 seconds")
      // NTP sets the wall clock back an hour while the broker is away.
      yield* TestClock.setTime(-3_600_000)
      events.brokerConnected(undefined)
      const { events: kept } = yield* events.log()
      expect(kept.at(-1)).toMatchObject({ type: "broker-connected", downMs: 30_000 })
    }).pipe(Effect.provide(gatewayEventsLayer()))
  )

  it.effect("keeps the newest events up to its capacity, counts what it let go, and filters by time and id", () =>
    Effect.gen(function* () {
      const events = yield* GatewayEvents
      for (let index = 0; index < 12; index++) {
        events.bufferDrained()
        yield* TestClock.adjust("1 second")
      }
      const log = yield* events.log()
      expect(log.events.map((event) => event.id)).toEqual([8, 9, 10, 11, 12])
      expect(log.dropped).toBe(7)
      expect((yield* events.log({ since: 10_000 })).events.map((event) => event.id)).toEqual([11, 12])
      expect((yield* events.log({ after: 10 })).events.map((event) => event.id)).toEqual([11, 12])
      expect((yield* events.log({ after: 12 })).events).toEqual([])
    }).pipe(Effect.provide(gatewayEventsLayer(5)))
  )
})
