/**
 * The gateway's recent events (`/api/events`) as the page shows them: one plain sentence each, kept across polls by
 * asking only for the ones after the last it has. Pure, so it is tested without a browser.
 */
import type { EventLog, GatewayEvent } from "@ot-gateway/api"
import { formatNumber } from "./format"
import { clockTime, duration } from "./status"

/** The events the page knows, from the gateway that started at `since`, oldest first. */
export interface KnownEvents {
  readonly since: number
  readonly events: ReadonlyArray<GatewayEvent>
  /** Events the gateway let go before the page saw them: its ring holds `capacity`. */
  readonly dropped: number
  readonly capacity: number
}

/**
 * What to ask for next: only the events after the newest known, while the gateway is the same run (`since`). A
 * restart counts its ids from 1 again, so then everything.
 */
export const eventsAfter = (known: KnownEvents | undefined, since: number): number | undefined =>
  known === undefined || known.since !== since ? undefined : known.events.at(-1)?.id

/**
 * The known events with an answer added: the new ones after the known ones, none twice, at most `capacity` (the
 * oldest let go first). An answer from another run of the gateway replaces what was known.
 */
export const mergeEvents = (known: KnownEvents | undefined, since: number, answer: EventLog): KnownEvents => {
  const kept = known === undefined || known.since !== since ? [] : known.events
  const newest = kept.at(-1)?.id ?? 0
  const all = [...kept, ...answer.events.filter((event) => event.id > newest)]
  const events = all.slice(Math.max(0, all.length - answer.capacity))
  return { since, events, dropped: answer.dropped, capacity: answer.capacity }
}

/**
 * A driver's error without the words the sentence already says: "could not connect: connection refused by
 * 127.0.0.1:5020" reads "connection refused by 127.0.0.1:5020" after "stopped answering".
 */
export const plainError = (error: string) => error.replace(/^could not connect: (?=.)/, "")

const values = (count: number) => `${formatNumber(count)} ${count === 1 ? "value" : "values"}`

/** What happened, in words, without the time: "energy-meter answering again after 61 s". */
export const eventSentence = (event: GatewayEvent): string => {
  switch (event.type) {
    case "gateway-started":
      return `Gateway started (${event.version}, ${event.devices} ${event.devices === 1 ? "device" : "devices"})`
    case "device-failing":
      return `${event.device} stopped answering: ${event.error === "" ? event.reason : plainError(event.error)}`
    case "device-recovered":
      return `${event.device} answering again after ${duration(event.downMs)}`
    case "broker-disconnected":
      return `Broker disconnected: ${event.error}`
    case "broker-connected": {
      const connected =
        event.downMs === undefined ? "Connected to the broker" : `Broker back after ${duration(event.downMs)}`
      return event.buffered === undefined || event.buffered === 0
        ? connected
        : `${connected}, ${values(event.buffered)} from the buffer on ${event.buffered === 1 ? "its" : "their"} way`
    }
    case "buffer-drained":
      return "Buffer emptied: every value kept while the broker was away reached it"
  }
}

/** Whether an event is bad news (shown in red), good news or neither. */
export const eventTone = (event: GatewayEvent): "bad" | "good" | "neutral" =>
  event.type === "device-failing" || event.type === "broker-disconnected"
    ? "bad"
    : event.type === "device-recovered" || event.type === "broker-connected" || event.type === "buffer-drained"
      ? "good"
      : "neutral"

/** The event as one line: "12:18:20 energy-meter stopped answering: connection refused by 127.0.0.1:5020". */
export const eventLine = (event: GatewayEvent, now: number) => `${clockTime(event.at, now)} ${eventSentence(event)}`

/** The events about one device, oldest first. */
export const deviceEvents = (events: ReadonlyArray<GatewayEvent>, device: string): ReadonlyArray<GatewayEvent> =>
  events.filter(
    (event) => (event.type === "device-failing" || event.type === "device-recovered") && event.device === device
  )

/** The newest `count` events, newest first, for a short list. */
export const latestEvents = (events: ReadonlyArray<GatewayEvent>, count: number): ReadonlyArray<GatewayEvent> =>
  events.slice(Math.max(0, events.length - count)).toReversed()

/** What the card says when nothing happened: "Nothing has happened since the gateway started at 12:16." */
export const nothingYet = (since: number, now: number) =>
  `Nothing has happened since the gateway started at ${clockTime(since, now).slice(0, -3)}.`
