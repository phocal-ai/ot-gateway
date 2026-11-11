/**
 * The gateway's recent incidents: a bounded ring of transitions (a device starts failing or recovers, the broker
 * goes away or comes back, the buffer is drained), so "what broke, since when, and why?" has an answer after the
 * fault has cleared. Served as `GET /api/events` and printed by `ot-gateway events`.
 *
 * Transitions are rare and reads are not: nothing here runs per read. Each method is synchronous, called from a
 * listener at the moment of the transition, and allocates one event; the ring never grows past its capacity.
 */
import type { EventLog, GatewayEvent } from "@ot-gateway/api"
import type { HealthChange, Slug } from "@ot-gateway/core"
import { Clock, Context, Effect, Layer } from "effect"

/** Events kept: a few hundred, about 100 kB at most, and weeks of incidents on a site that has a few a day. */
export const EVENT_CAPACITY = 500

/** What the caller says about an event; the ring adds its `id` and `at`. */
type EventInput = GatewayEvent extends infer Event
  ? Event extends GatewayEvent
    ? Omit<Event, "id" | "at">
    : never
  : never

export interface EventQuery {
  /** Unix ms: only events at or after it. */
  readonly since?: number | undefined
  /** An event id: only the events after it. */
  readonly after?: number | undefined
}

export interface GatewayEventsShape {
  /** The process started, with this version and this many configured devices. */
  readonly started: (version: string, devices: number) => void
  /** A device's health changed (the health registry's listener): ok or starting to failing, failing to ok. */
  readonly deviceChanged: (change: HealthChange) => void
  /** Connected to the broker, with the messages waiting in the buffer then (undefined without a buffer). */
  readonly brokerConnected: (buffered: number | undefined) => void
  /** The broker connection was lost or a dial failed. Only the first of an outage is an event. */
  readonly brokerDisconnected: (error: string) => void
  /** The buffer delivered its backlog. */
  readonly bufferDrained: () => void
  /** Another gateway publishes into this one's topics (`OtherGateways.ts`). */
  readonly gatewayConflict: (gateway: string, devices: ReadonlyArray<string>, sameId: boolean) => void
  /** The events kept, oldest first, filtered by `query`. */
  readonly log: (query?: EventQuery) => Effect.Effect<EventLog>
}

export class GatewayEvents extends Context.Service<GatewayEvents, GatewayEventsShape>()(
  "@ot-gateway/gateway/GatewayEvents"
) {}

/**
 * The ring on `clock`: `at` from its wall clock, durations from its monotonic clock, because NTP steps the wall
 * clock of a Pi without a real-time clock while it is down.
 */
export const makeGatewayEvents = (clock: Clock.Clock, capacity: number = EVENT_CAPACITY): GatewayEventsShape => {
  const slots: Array<GatewayEvent | undefined> = Array.from({ length: capacity }, () => undefined)
  /** Events recorded since start; also the id of the newest. */
  let total = 0
  const monotonicMs = () => Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n)
  /** Since when each failing device has failed, on the monotonic clock. */
  const failingSince = new Map<Slug, number>()
  /** Since when the broker has been away, on the monotonic clock; undefined while connected or before the first dial. */
  let brokerDownSince: number | undefined

  const record = (event: EventInput) => {
    total++
    slots[(total - 1) % capacity] = { ...event, id: total, at: clock.currentTimeMillisUnsafe() }
  }

  return {
    started: (version, devices) => record({ type: "gateway-started", version, devices }),
    deviceChanged: ({ device, previous, next }) => {
      if (next.status === "failing" && previous.status !== "failing") {
        failingSince.set(device, monotonicMs())
        record({ type: "device-failing", device, reason: next.reason ?? "unknown", error: next.lastError ?? "" })
      } else if (previous.status === "failing" && next.status === "ok") {
        const since = failingSince.get(device)
        failingSince.delete(device)
        record({ type: "device-recovered", device, downMs: since === undefined ? 0 : monotonicMs() - since })
      }
    },
    brokerConnected: (buffered) => {
      const downMs = brokerDownSince === undefined ? undefined : monotonicMs() - brokerDownSince
      brokerDownSince = undefined
      record({
        type: "broker-connected",
        ...(downMs === undefined ? {} : { downMs }),
        ...(buffered === undefined ? {} : { buffered })
      })
    },
    brokerDisconnected: (error) => {
      if (brokerDownSince !== undefined) return
      brokerDownSince = monotonicMs()
      record({ type: "broker-disconnected", error })
    },
    bufferDrained: () => record({ type: "buffer-drained" }),
    gatewayConflict: (gateway, devices, sameId) => record({ type: "gateway-conflict", gateway, devices, sameId }),
    log: (query = {}) =>
      Effect.sync(() => {
        const kept = Math.min(total, capacity)
        const events: Array<GatewayEvent> = []
        for (let index = total - kept; index < total; index++) {
          const event = slots[index % capacity]
          if (event === undefined) continue
          if (query.since !== undefined && event.at < query.since) continue
          if (query.after !== undefined && event.id <= query.after) continue
          events.push(event)
        }
        return { now: clock.currentTimeMillisUnsafe(), events, capacity, dropped: total - kept }
      })
  }
}

/** The ring on the clock of the layer's context (the test clock in a test). */
export const gatewayEventsLayer = (capacity: number = EVENT_CAPACITY) =>
  Layer.effect(
    GatewayEvents,
    Effect.map(
      Clock.clockWith((clock) => Effect.succeed(clock)),
      (clock) => GatewayEvents.of(makeGatewayEvents(clock, capacity))
    )
  )
