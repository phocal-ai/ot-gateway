/**
 * The gateway's recent events (`/api/events`) as the page shows them: one plain sentence each, kept across polls by
 * asking only for the ones after the last it has. Pure, so it is tested without a browser.
 */
import { type EventLog, type GatewayEvent, sharedCauses } from "@ot-gateway/api"
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

/** A point's name by its device and id, where the page knows it (the point catalog); undefined where it does not. */
export type PointNames = (device: string, point: string) => string | undefined

/**
 * Which alarm point an event is about: "Main breaker tripped on energy-meter" with its name, or
 * "energy-meter/main-breaker-tripped" when the page does not know it or the name is the id.
 */
export const alarmSubject = (device: string, point: string, names?: PointNames) => {
  const name = names?.(device, point)?.trim()
  return name === undefined || name === "" || name === point ? `${device}/${point}` : `${name} on ${device}`
}

/**
 * What happened, in words, without the time: "energy-meter answering again after 61 s". `names` names the point of
 * an alarm event.
 */
export const eventSentence = (event: GatewayEvent, names?: PointNames): string => {
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
      return event.delivered === undefined || event.delivered === 0
        ? "Buffer emptied: every value kept while the broker was away reached it"
        : `Buffer emptied: ${values(event.delivered)} from it reached the broker`
    case "config-applied":
      return `Settings saved and applied: ${event.summary}`
    case "config-apply-failed":
      return `Saved settings did not start, the previous ones run again: ${event.error}`
    case "gateway-conflict":
      return event.sameId
        ? `Another gateway with this gateway's id (${event.gateway}) is online: both publish into the same topics`
        : `Gateway ${event.gateway} publishes ${event.devices.join(", ")} too: values from both gateways mix`
    case "alarm-raised":
      return `${
        event.first === true
          ? "Alarm active at its first read"
          : event.afterOutage === true
            ? `Alarm active when ${event.device} answered again`
            : "Alarm raised"
      }: ${alarmSubject(event.device, event.point, names)}`
    case "alarm-cleared":
      return `${
        event.afterOutage === true
          ? `Alarm off when ${event.device} answered again`
          : `Alarm cleared after ${duration(event.activeMs)}`
      }: ${alarmSubject(event.device, event.point, names)}`
    case "alarm-flapping":
      return `Alarm raised ${event.raised} times in 15 min: ${alarmSubject(event.device, event.point, names)}; changes are counted until it keeps still`
    case "alarm-settled":
      return `Alarm keeps still, ${event.active ? "active" : "not active"}, after ${event.unlisted} unlisted changes: ${alarmSubject(event.device, event.point, names)}`
  }
}

/**
 * Whether an event says something happened: not the gateway's start, nor its first connect to the broker, which
 * every start has. A ring with only those is a quiet gateway.
 */
export const isIncident = (event: GatewayEvent) =>
  event.type !== "gateway-started" && !(event.type === "broker-connected" && event.downMs === undefined)

/**
 * Whether an event is bad news (shown in red), good news or neither. An alarm found changed when its device answered
 * again (`afterOutage`) is neither: it changed at some time during the outage, which the device's failure already
 * said, and it is not a new trip or a clear the gateway saw happen.
 */
export const eventTone = (event: GatewayEvent): "bad" | "good" | "neutral" =>
  (event.type === "alarm-raised" || event.type === "alarm-cleared") && event.afterOutage === true
    ? "neutral"
    : event.type === "device-failing" ||
        event.type === "broker-disconnected" ||
        event.type === "config-apply-failed" ||
        event.type === "gateway-conflict" ||
        event.type === "alarm-raised" ||
        event.type === "alarm-flapping" ||
        (event.type === "alarm-settled" && event.active)
      ? "bad"
      : event.type === "device-recovered" ||
          event.type === "broker-connected" ||
          event.type === "buffer-drained" ||
          event.type === "alarm-cleared" ||
          (event.type === "alarm-settled" && !event.active)
        ? "good"
        : "neutral"

/** The event as one line: "12:18:20 energy-meter stopped answering: connection refused by 127.0.0.1:5020". */
export const eventLine = (event: GatewayEvent, now: number) => `${clockTime(event.at, now)} ${eventSentence(event)}`

/**
 * The shared-cause line ("2 devices (boiler, meter) stopped answering within 6 s of each other: likely a shared
 * cause …") by the id of the newest failure of its group, which a newest-first list shows first: the same groups and
 * words as `ot-gateway events`.
 */
export const sharedCauseNotes = (events: ReadonlyArray<GatewayEvent>): ReadonlyMap<number, string> =>
  new Map(
    sharedCauses(events.filter((event) => event.type === "device-failing")).flatMap((shared) => {
      const newest = shared.ids.at(-1)
      return newest === undefined ? [] : [[newest, shared.line] as const]
    })
  )

/** The events about one device, oldest first: its failures and recoveries, and the changes of its alarm points. */
export const deviceEvents = (events: ReadonlyArray<GatewayEvent>, device: string): ReadonlyArray<GatewayEvent> =>
  events.filter(
    (event) =>
      (event.type === "device-failing" ||
        event.type === "device-recovered" ||
        event.type === "alarm-raised" ||
        event.type === "alarm-cleared" ||
        event.type === "alarm-flapping" ||
        event.type === "alarm-settled") &&
      event.device === device
  )

/** The newest `count` events, newest first, for a short list. */
export const latestEvents = (events: ReadonlyArray<GatewayEvent>, count: number): ReadonlyArray<GatewayEvent> =>
  events.slice(Math.max(0, events.length - count)).toReversed()

/** What the card says when nothing happened: "Nothing has happened since the gateway started at 12:16." */
export const nothingYet = (since: number, now: number) =>
  `Nothing has happened since the gateway started at ${clockTime(since, now).slice(0, -3)}.`
