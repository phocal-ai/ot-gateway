/**
 * The gateway's recent events (`/api/events`) as the page shows them: one plain sentence each, kept across polls by
 * asking only for the ones after the last it has. Pure, so it is tested without a browser.
 */
import {
  COUNTER_RATE_FACTOR,
  counterShareText,
  type EventLog,
  type FailureContext,
  flappingAlarmHint,
  type GatewayEvent,
  preciseDuration,
  sharedCauses,
  unitLabel,
  unknownStateText,
  type ValueEvent
} from "@ot-gateway/api"
import { formatNumber } from "./format"
import { clockTime, duration } from "./status"

/**
 * An event the page shows: the gateway's own, or a point's value event (an energy counter that went back or jumped),
 * which the gateway answers apart (`valueEvents`) but numbers in the same ring, so ids order them all in time.
 */
export type PageEvent = GatewayEvent | ValueEvent

/** The events the page knows, from the gateway that started at `since`, oldest first. */
export interface KnownEvents {
  readonly since: number
  readonly events: ReadonlyArray<PageEvent>
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
 * oldest let go first). The answer's value events (`valueEvents`) go in among the others by id, their order in time.
 * An answer from another run of the gateway replaces what was known.
 */
export const mergeEvents = (known: KnownEvents | undefined, since: number, answer: EventLog): KnownEvents => {
  const kept = known === undefined || known.since !== since ? [] : known.events
  const newest = kept.at(-1)?.id ?? 0
  const answered: ReadonlyArray<PageEvent> = [...answer.events, ...(answer.valueEvents ?? [])]
  const added = answered.filter((event) => event.id > newest).toSorted((left, right) => left.id - right.id)
  const all = [...kept, ...added]
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
 * Which point an event is about: "Main breaker tripped on energy-meter" with its name, or
 * "energy-meter/main-breaker-tripped" when the page does not know it or the name is the id.
 */
export const alarmSubject = (device: string, point: string, names?: PointNames) => {
  const name = names?.(device, point)?.trim()
  return name === undefined || name === "" || name === point ? `${device}/${point}` : `${name} on ${device}`
}

/** `4,270 to 120 kWh`: a counter's two readings, grouped as the page writes numbers, with its unit. */
const counterStep = (event: ValueEvent) => {
  const unit = unitLabel(event.unit)
  return `${formatNumber(event.from)} to ${formatNumber(event.to)}${unit === "" ? "" : ` ${unit}`}`
}

/**
 * What an energy counter did, after its subject, in the words of `ot-gateway events`: "went back from 4,270 to 120
 * kWh: meter reset or replaced?", or a jump with how fast it rose before.
 */
export const counterChange = (event: ValueEvent) => {
  if (event.type === "counter-went-back") return `went back from ${counterStep(event)}: meter reset or replaced?`
  const unit = unitLabel(event.unit)
  const withUnit = (value: number) => `${formatNumber(value)}${unit === "" ? "" : ` ${unit}`}`
  // Before the gateway knew the counter's pace: how much it rose, against the reading itself.
  if (event.usualPerHour === undefined)
    return `jumped from ${counterStep(event)}: rose by ${withUnit(event.to - event.from)} in ${preciseDuration(event.elapsedMs)}, ${counterShareText(event.from, event.to)}: meter reset or replaced, or another device answering at its address?`
  return `jumped from ${counterStep(event)} in ${preciseDuration(event.elapsedMs)}, more than ${COUNTER_RATE_FACTOR}× its fastest rise of the last hour (${withUnit(event.usualPerHour)}/h): meter reset or replaced, or another device answering at its address?`
}

/** The point sheet's note on a counter event of its own point: "At 18:35:23 the counter went back from …". */
export const counterNote = (event: ValueEvent, now: number) =>
  `At ${clockTime(event.at, now)} the counter ${counterChange(event)}`

/**
 * What happened, in words, without the event's time: "energy-meter answering again: no data 18:33:03–18:35:23
 * (2 min 20 s)". `names` names the point of an alarm or counter event; `now` (the gateway's time) decides whether a
 * time in the sentence needs its date.
 */
export const eventSentence = (event: PageEvent, names?: PointNames, now: number = event.at): string => {
  switch (event.type) {
    case "counter-went-back":
    case "counter-jumped":
      return `${alarmSubject(event.device, event.point, names)} ${counterChange(event)}`
    case "gateway-started":
      return `Gateway started (${event.version}, ${event.devices} ${event.devices === 1 ? "device" : "devices"})`
    case "device-failing":
      return `${event.device} stopped answering: ${event.error === "" ? event.reason : plainError(event.error)}${
        event.lastReadAt === undefined ? "" : `, last read ${clockTime(event.lastReadAt, now)}`
      }`
    case "device-recovered":
      // One duration per outage, as the data shows it: from the last good read to the first read again. When the
      // gateway called it failing is in `eventDetail`.
      return event.lastReadAt === undefined
        ? `${event.device} answering again after ${duration(event.downMs)}`
        : `${event.device} answering again: no data ${clockTime(event.lastReadAt, now)}–${clockTime(event.at, now)} (${preciseDuration(event.noDataMs ?? event.at - event.lastReadAt)})`
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
            ? `Alarm active when ${event.device} answered again (${unknownStateText(event.unknownMs)})`
            : "Alarm raised"
      }: ${alarmSubject(event.device, event.point, names)}`
    case "alarm-cleared":
      return `${
        event.afterOutage === true
          ? `Alarm off when ${event.device} answered again (${unknownStateText(event.unknownMs)})`
          : `Alarm cleared after ${duration(event.activeMs)}`
      }: ${alarmSubject(event.device, event.point, names)}`
    case "alarm-flapping":
      return `Alarm raised ${event.raised} times in 15 min: ${alarmSubject(event.device, event.point, names)}; changes are counted until it keeps still`
    case "alarm-settled":
      return `Alarm keeps still, ${event.active ? "active" : "not active"}, after ${event.unlisted} unlisted changes: ${alarmSubject(event.device, event.point, names)}`
  }
}

/**
 * What the main line leaves out, muted after it: when the gateway called a recovered device failing ("detected
 * 18:33:11"; the event's own time is when it answered again).
 */
export const eventDetail = (event: PageEvent, now: number): string | undefined =>
  event.type === "device-recovered" && event.lastReadAt !== undefined && event.failingSince !== undefined
    ? `detected ${clockTime(event.failingSince, now)}`
    : undefined

/** The hover text of a recovery: what the detection time is, and the outage as the gateway counted it. */
export const eventDetailTitle = (event: PageEvent): string | undefined =>
  event.type === "device-recovered" && event.failingSince !== undefined
    ? `Marked failing when the reads it retries had failed, ${preciseDuration(event.downMs)} before it answered again; its data stopped at its last read before that.`
    : undefined

/**
 * A muted note under an event: for an alarm that flaps, what a fixed rhythm usually means (Hints.ts, as `ot-gateway
 * events` and `status` say it).
 */
export const eventNote = (event: PageEvent): string | undefined =>
  event.type === "alarm-flapping" ? flappingAlarmHint.checks[0] : undefined

/**
 * Whether an event says something happened: not the gateway's start, nor its first connect to the broker, which
 * every start has. A ring with only those is a quiet gateway.
 */
export const isIncident = (event: PageEvent) =>
  event.type !== "gateway-started" && !(event.type === "broker-connected" && event.downMs === undefined)

/**
 * Whether an event is bad news (shown in red), a warning (an energy counter that went back or jumped: worth a look,
 * but the values still flow), good news or neither. An alarm found changed when its device answered again
 * (`afterOutage`) is neither: it changed at some time during the outage, which the device's failure already said, and
 * it is not a new trip or a clear the gateway saw happen.
 */
export const eventTone = (event: PageEvent): "bad" | "warning" | "good" | "neutral" =>
  event.type === "counter-went-back" || event.type === "counter-jumped"
    ? "warning"
    : (event.type === "alarm-raised" || event.type === "alarm-cleared") && event.afterOutage === true
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
export const eventLine = (event: PageEvent, now: number) =>
  `${clockTime(event.at, now)} ${eventSentence(event, undefined, now)}`

/** Where a device sits (`DeviceStatus.host`), where the page knows it. */
export type HostOf = (device: string) => string | undefined

/** Each device's host from the status's devices (`DeviceStatus.host`). */
export const hostsOf = (
  devices: ReadonlyArray<{ readonly id: string; readonly host?: string | undefined }>
): HostOf => {
  const hosts = new Map(devices.map((device) => [device.id, device.host]))
  return (device) => hosts.get(device)
}

const failuresIn = (events: ReadonlyArray<PageEvent>) => events.filter((event) => event.type === "device-failing")

/**
 * The shared-cause line ("2 devices (boiler, meter) stopped answering within 6 s of each other: likely a shared
 * cause …", or "…, both on 10.0.1.20: likely the host itself …" when `hostOf` puts them all on one host) by the id
 * of the newest failure of its group, which a newest-first list shows first: the same groups and words as
 * `ot-gateway events`.
 */
export const sharedCauseNotes = (events: ReadonlyArray<PageEvent>, hostOf?: HostOf): ReadonlyMap<number, string> =>
  new Map(
    sharedCauses(failuresIn(events), hostOf).flatMap((shared) => {
      const newest = shared.ids.at(-1)
      return newest === undefined ? [] : [[newest, shared.line] as const]
    })
  )

/** A device's failure among others: what `whatToCheck` gets to know, and the shared-cause line when there is one. */
export interface SharedFailure {
  readonly context: Pick<FailureContext, "sharedCause" | "sharedHost">
  readonly line?: string
}

/**
 * What the hints know about a device's failure from the events: whether its latest `device-failing` is one of several
 * that stopped answering together, on one host when they share it, and that group's line for the device sheet.
 */
export const sharedFailure = (events: ReadonlyArray<PageEvent>, device: string, hostOf?: HostOf): SharedFailure => {
  const failures = failuresIn(events)
  const latest = failures.findLast((event) => event.device === device)
  const group =
    latest === undefined ? undefined : sharedCauses(failures, hostOf).find((shared) => shared.ids.includes(latest.id))
  if (group === undefined) return { context: {} }
  return {
    context: { sharedCause: true, ...(group.host === undefined ? {} : { sharedHost: group.host }) },
    line: group.line
  }
}

/**
 * The events about one device, oldest first: its failures and recoveries, the changes of its alarm points, and its
 * energy counters that went back or jumped.
 */
export const deviceEvents = (events: ReadonlyArray<PageEvent>, device: string): ReadonlyArray<PageEvent> =>
  events.filter(
    (event) =>
      (event.type === "device-failing" ||
        event.type === "device-recovered" ||
        event.type === "alarm-raised" ||
        event.type === "alarm-cleared" ||
        event.type === "alarm-flapping" ||
        event.type === "alarm-settled" ||
        event.type === "counter-went-back" ||
        event.type === "counter-jumped") &&
      event.device === device
  )

/** One point's counter events (an energy counter that went back or jumped), oldest first, for its point sheet. */
export const pointCounterEvents = (
  events: ReadonlyArray<PageEvent>,
  device: string,
  point: string
): ReadonlyArray<ValueEvent> =>
  events.filter(
    (event): event is ValueEvent =>
      (event.type === "counter-went-back" || event.type === "counter-jumped") &&
      event.device === device &&
      event.point === point
  )

/** The newest `count` events, newest first, for a short list. */
export const latestEvents = (events: ReadonlyArray<PageEvent>, count: number): ReadonlyArray<PageEvent> =>
  events.slice(Math.max(0, events.length - count)).toReversed()

/** What the card says when nothing happened: "Nothing has happened since the gateway started at 12:16." */
export const nothingYet = (since: number, now: number) =>
  `Nothing has happened since the gateway started at ${clockTime(since, now).slice(0, -3)}.`
