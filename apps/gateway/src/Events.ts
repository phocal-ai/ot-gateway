/**
 * The gateway's recent incidents: a bounded ring of transitions (a device starts failing or recovers, the broker
 * goes away or comes back, the buffer is drained), so "what broke, since when, and why?" has an answer after the
 * fault has cleared. Served as `GET /api/events` and printed by `ot-gateway events`.
 *
 * Transitions are rare and reads are not: nothing here runs per read. Each method is synchronous, called from a
 * listener at the moment of the transition, and allocates one event; the ring never grows past its capacity.
 *
 * Value events (an energy counter that went back or jumped, `Counters.ts`) share the ring and its ids, and are
 * answered apart, as `valueEvents`, so a client that knows only the gateway's events keeps decoding the answer.
 */
import type { PreviousRun } from "./PreviousRun.ts"
import type { EventLog, GatewayEvent, ValueEvent } from "@ot-gateway/api"
import type { HealthChange, Slug } from "@ot-gateway/core"
import { Clock, Context, Effect, Layer } from "effect"

/** Events kept: a few hundred, about 100 kB at most, and weeks of incidents on a site that has a few a day. */
export const EVENT_CAPACITY = 500

/** Any event the ring keeps. */
type StoredEvent = GatewayEvent | ValueEvent

/** What the caller says about an event; the ring adds its `id` and `at`. */
type EventInput = StoredEvent extends infer Event
  ? Event extends StoredEvent
    ? Omit<Event, "id" | "at">
    : never
  : never

/** An alarm point's event, as the alarm tracker (Alarms.ts) hands it over: rate-limited there already. */
export type AlarmEventInput = Extract<EventInput, { readonly type: `alarm-${string}` }>

/** An energy counter's event, as the counter tracker (Counters.ts) hands it over: rate-limited there already. */
export type ValueEventInput = Extract<EventInput, { readonly type: `counter-${string}` }>

export interface EventQuery {
  /** Unix ms: only events at or after it. */
  readonly since?: number | undefined
  /** An event id: only the events after it. One this run never gave (the asker saw an earlier run): every event. */
  readonly after?: number | undefined
}

export interface GatewayEventsShape {
  /** The process started, with this version and this many configured devices, and how the run before ended. */
  readonly started: (version: string, devices: number, previousRun?: PreviousRun) => void
  /** A device's health changed (the health registry's listener): ok or starting to failing, failing to ok. */
  readonly deviceChanged: (change: HealthChange) => void
  /** Connected to the broker, with the messages waiting in the buffer then (undefined without a buffer). */
  readonly brokerConnected: (buffered: number | undefined) => void
  /**
   * The broker connection was lost (`lost`) or a dial failed. Only the first of an outage is an event; the dials that
   * fail during it are counted, and the `broker-connected` that ends it says how many (`retries`).
   */
  readonly brokerDisconnected: (error: string, lost?: boolean) => void
  /**
   * The buffer delivered its backlog, when known: `delivered` messages since the broker came back, the `buffered`
   * ones waiting then and the `queued` ones stored behind them.
   */
  readonly bufferDrained: (counts?: {
    readonly delivered: number
    readonly buffered: number
    readonly queued: number
  }) => void
  /** A config saved from the status page runs now; `summary` says what changed. */
  readonly configApplied: (summary: string) => void
  /** A config saved from the status page did not start, and the previous one runs again. */
  readonly configApplyFailed: (error: string) => void
  /** Another gateway publishes into this one's topics (`OtherGateways.ts`). */
  readonly gatewayConflict: (gateway: string, devices: ReadonlyArray<string>, sameId: boolean) => void
  /** An alarm point was raised, cleared, flaps or settled (Alarms.ts decides which, and how many to list). */
  readonly alarm: (event: AlarmEventInput) => void
  /** An energy counter went back or jumped (Counters.ts decides which, and how many to list). */
  readonly value: (event: ValueEventInput) => void
  /** The events kept, oldest first, filtered by `query`. */
  readonly log: (query?: EventQuery) => Effect.Effect<EventLog>
}

export class GatewayEvents extends Context.Service<GatewayEvents, GatewayEventsShape>()(
  "@ot-gateway/gateway/GatewayEvents"
) {}

const isValueEvent = (event: StoredEvent): event is ValueEvent =>
  event.type === "counter-went-back" || event.type === "counter-jumped"

/**
 * The ring on `clock`: `at` from its wall clock, durations from its monotonic clock, because NTP steps the wall
 * clock of a Pi without a real-time clock while it is down.
 */
export const makeGatewayEvents = (clock: Clock.Clock, capacity: number = EVENT_CAPACITY): GatewayEventsShape => {
  const slots: Array<StoredEvent | undefined> = Array.from({ length: capacity }, () => undefined)
  /** Events recorded since start; also the id of the newest. */
  let total = 0
  const monotonicMs = () => Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n)
  /** Since when each failing device has failed, on the monotonic clock. */
  const failingSince = new Map<Slug, number>()
  /** The devices that have read fine in this run: one of them that fails is no config mistake. */
  const answered = new Set<Slug>()
  /** Since when the broker has been away, on the monotonic clock; undefined while connected or before the first dial. */
  let brokerDownSince: number | undefined
  /** Dials that failed during the broker outage under way. */
  let brokerRetries = 0

  const record = (event: EventInput) => {
    total++
    slots[(total - 1) % capacity] = { ...event, id: total, at: clock.currentTimeMillisUnsafe() }
  }

  return {
    started: (version, devices, previousRun) =>
      record({ type: "gateway-started", version, devices, ...(previousRun === undefined ? {} : { previousRun }) }),
    deviceChanged: ({ device, previous, next }) => {
      if (previous.status === "ok" || next.status === "ok") answered.add(device)
      if (next.status === "failing" && previous.status !== "failing") {
        failingSince.set(device, monotonicMs())
        record({
          type: "device-failing",
          device,
          reason: next.reason ?? "unknown",
          error: next.lastError ?? "",
          ...(answered.has(device) ? { answeredBefore: true } : {}),
          ...(previous.lastSuccess === undefined ? {} : { lastReadAt: previous.lastSuccess })
        })
      } else if (previous.status === "failing" && next.status === "ok") {
        const since = failingSince.get(device)
        failingSince.delete(device)
        const downMs = since === undefined ? 0 : monotonicMs() - since
        const { lastSuccess, failingSince: detectedAt } = previous
        // From the last good read to this one: the time it took to call the device failing (wall clock, seconds
        // apart), then the outage on the monotonic clock, so a clock step while the device was away does not bend it.
        const noDataMs =
          lastSuccess === undefined || detectedAt === undefined
            ? undefined
            : downMs + Math.max(0, detectedAt - lastSuccess)
        record({
          type: "device-recovered",
          device,
          downMs,
          ...(lastSuccess === undefined ? {} : { lastReadAt: lastSuccess }),
          ...(detectedAt === undefined ? {} : { failingSince: detectedAt }),
          ...(noDataMs === undefined ? {} : { noDataMs })
        })
      }
    },
    brokerConnected: (buffered) => {
      const downMs = brokerDownSince === undefined ? undefined : monotonicMs() - brokerDownSince
      const retries = downMs === undefined ? undefined : brokerRetries
      brokerDownSince = undefined
      brokerRetries = 0
      record({
        type: "broker-connected",
        ...(downMs === undefined ? {} : { downMs }),
        ...(retries === undefined ? {} : { retries }),
        ...(buffered === undefined ? {} : { buffered })
      })
    },
    brokerDisconnected: (error, lost = false) => {
      if (!lost) brokerRetries++
      if (brokerDownSince !== undefined) return
      brokerDownSince = monotonicMs()
      record({ type: "broker-disconnected", error })
    },
    bufferDrained: (counts) => record({ type: "buffer-drained", ...counts }),
    configApplied: (summary) => record({ type: "config-applied", summary }),
    configApplyFailed: (error) => record({ type: "config-apply-failed", error }),
    gatewayConflict: (gateway, devices, sameId) => record({ type: "gateway-conflict", gateway, devices, sameId }),
    alarm: record,
    value: record,
    log: (query = {}) =>
      Effect.sync(() => {
        const kept = Math.min(total, capacity)
        const events: Array<GatewayEvent> = []
        const valueEvents: Array<ValueEvent> = []
        const after = query.after !== undefined && query.after <= total ? query.after : undefined
        for (let index = total - kept; index < total; index++) {
          const event = slots[index % capacity]
          if (event === undefined) continue
          if (query.since !== undefined && event.at < query.since) continue
          if (after !== undefined && event.id <= after) continue
          if (isValueEvent(event)) valueEvents.push(event)
          else events.push(event)
        }
        return {
          now: clock.currentTimeMillisUnsafe(),
          events,
          // Only when there are some: an answer without value events stays as it was.
          ...(valueEvents.length === 0 ? {} : { valueEvents }),
          capacity,
          dropped: total - kept
        }
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
