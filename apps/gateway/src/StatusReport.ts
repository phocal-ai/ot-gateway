/**
 * `ot-gateway status` and `ot-gateway events`: the running gateway's status page as text, through the same typed
 * client and schema the page uses. `status` is one line for the gateway and its broker, one per device with what to
 * check first when it fails, the alarms that are active or flapped, and what failed in the last 15 minutes although
 * it works again; it exits with 1 when a device is failing or the broker is not connected. `events` is what changed
 * lately, one line each, with what to check for a device that failed and a line when several failed at once; with
 * `--follow` what changes from now on.
 * Times are local clock times on this machine; durations are the gateway's own.
 */
import {
  ALARM_SETTLE_MS,
  ALARM_WINDOW_MS,
  type AlarmPattern,
  type AlarmStatus,
  brokerHostOf,
  brokerWith,
  commonHost,
  COUNTER_RATE_FACTOR,
  counterShareText,
  type DeviceStatus,
  drainedParts,
  type EventLog,
  flappingAlarmHint,
  gatewaySideFailure,
  type GatewayEvent,
  type GatewayStatus,
  type ValuesQueryInvalid,
  type Hint,
  isDeviceLate,
  OtGatewayApi,
  preciseDuration,
  type Protocol,
  roughDuration,
  SHARED_CAUSE_WINDOW_MS,
  firstNames,
  sharedCauseLine,
  sharedCauses,
  unitLabel,
  unknownStateText,
  type ValueEvent,
  whatToCheck
} from "@ot-gateway/api"
import { causeText } from "@ot-gateway/core"
import { Console, type Duration, Effect, type FileSystem, Schema } from "effect"
import { FetchHttpClient, HttpClient, type HttpClientError } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { withoutControls } from "./Discover.ts"
import {
  EVENTS_RELEASE,
  gatewayVersionOf,
  GatewayTooOld,
  servesEvents,
  tooOldMessage,
  versionName
} from "./GatewayRelease.ts"
import { checkIdentity, gatewayName, type GatewayTarget } from "./GatewayTarget.ts"
import { jsonLineWithLocalTimes, printJsonWithLocalTimes } from "./JsonTimes.ts"
import { localTime, printResult } from "./Output.ts"
import { readVersion } from "./Version.ts"
import { count, firstOf, LISTED, named, plural } from "./Words.ts"

/** Something answered at the gateway's address, in a form this CLI cannot read: most likely another release. */
export class GatewayAnswerUnreadable extends Schema.TaggedError<GatewayAnswerUnreadable>()("GatewayAnswerUnreadable", {
  url: Schema.String,
  message: Schema.String,
  code: Schema.Literal("gateway-unreadable")
}) {}

/** Nothing answered at the status page's address: the gateway is not running there, or its page is elsewhere. */
export class GatewayUnreachable extends Schema.TaggedError<GatewayUnreachable>()("GatewayUnreachable", {
  url: Schema.String,
  message: Schema.String,
  code: Schema.Literal("gateway-unreachable"),
  hint: Schema.String
}) {}

/** The gateway answered, and something is failing: printed already, this makes the exit code 1. */
export class GatewayUnhealthy extends Schema.TaggedError<GatewayUnhealthy>()("GatewayUnhealthy", {
  message: Schema.String
}) {}

/** `12 s`, `4 min`, `3 h`, `2 d`: how long ago, as coarse as a glance needs. */
export const ago = roughDuration

/** Where to look next when something is failing: the gateway's own timeline, then its log. */
export const failingHint = [
  "  What changed and when: ot-gateway events",
  "  Its warnings and errors: ot-gateway logs --level warn (the whole log, in its folder: docker compose logs gateway --since 10m)"
]

/** The broker is away and it is not just the start: the connection was lost, or a dial failed or was refused. */
export const brokerAway = (broker: GatewayStatus["broker"]) =>
  !broker.connected && (broker.disconnectedSince !== undefined || broker.failedConnects > 0 || broker.connects > 0)

/**
 * What to check for a failing device, from the table the status page's device sheet shows: a device that read
 * fine in this run (`lastSuccess`), or one of several that failed together (`shared`), leads with power, switch,
 * cable and restart rather than its config.
 */
export const hintsFor = (device: DeviceStatus, shared = false, sharedHost?: string) =>
  whatToCheck(device.protocol, device.reason ?? "", device.lastError, {
    answeredBefore: device.lastSuccess !== undefined,
    sharedCause: shared,
    ...(sharedHost === undefined ? {} : { sharedHost })
  })

/**
 * The devices a shared cause is judged on: not those failing on the gateway's own BACnet/IP port, which is the
 * gateway's problem and no host, switch or power they share. `events` leaves them out the same way (`sharedCauses`).
 */
export const deviceSide = (devices: ReadonlyArray<DeviceStatus>) =>
  devices.filter((device) => !gatewaySideFailure(device.lastError))

/** The one host all of `devices` sit on (`DeviceStatus.host`); undefined when one has none or they differ. */
export const sharedHostOf = (devices: ReadonlyArray<DeviceStatus>) => {
  const hosts = new Map(devices.map((device) => [device.id, device.host]))
  return commonHost(
    devices.map((device) => device.id),
    (device) => hosts.get(device)
  )
}

/**
 * `all 3 devices stopped answering within 6 s of each other: …` when every device of two or more fails and their
 * failures began within `SHARED_CAUSE_WINDOW_MS`; undefined otherwise. Devices on one host say so: the host itself is
 * then the likelier cause than a switch on the way. With `broker`, a broker on that host (loopback in any spelling is
 * this machine) that is away since then is named too: `all 2 devices and the broker stopped answering …`.
 */
export const sharedCause = (all: ReadonlyArray<DeviceStatus>, broker?: GatewayStatus["broker"]) => {
  const devices = deviceSide(all)
  if (devices.length < 2) return undefined
  const starts: Array<number> = []
  for (const device of devices) {
    if (device.status !== "failing" || device.failingSince === undefined) return undefined
    starts.push(device.failingSince)
  }
  const spread = Math.max(...starts) - Math.min(...starts)
  if (spread > SHARED_CAUSE_WINDOW_MS) return undefined
  const host = sharedHostOf(devices)
  const who =
    devices.length === all.length
      ? `all ${devices.length} devices`
      : `${devices.length} devices (${firstNames(devices.map((device) => device.id))})`
  const away =
    broker === undefined || broker.connected || broker.disconnectedSince === undefined
      ? undefined
      : brokerWith(Math.min(...starts), host, brokerHostOf(broker.url), [{ at: broker.disconnectedSince }])
  if (away === undefined) return sharedCauseLine(who, spread, host, devices.length)
  const times = [...starts, away.at]
  return sharedCauseLine(`${who} and the broker`, Math.max(...times) - Math.min(...times), host, devices.length + 1)
}

/** What `events` adds to an event: what to check for a device that failed, and whether others failed with it. */
export interface EventAdvice {
  readonly hint?: Hint
  /** The shared-cause line, on every device failure of a group that began within `SHARED_CAUSE_WINDOW_MS`. */
  readonly sharedCause?: string
  /**
   * The failure is the first of its shared-cause group, or failed alone: `events` lists more of what to check under
   * it. The others of a group list only the first check, since the group's checks are the same.
   */
  readonly leads?: boolean
}

/** Any event `events` shows: the gateway's, and the value events (an energy counter that went back or jumped). */
export type AnyEvent = GatewayEvent | ValueEvent

/** Every event of `log`, the gateway's and the value events together, oldest first (by id: they share the ring). */
export const allEvents = (log: EventLog): ReadonlyArray<AnyEvent> =>
  log.valueEvents === undefined || log.valueEvents.length === 0
    ? log.events
    : [...log.events, ...log.valueEvents].toSorted((left, right) => left.id - right.id)

/** What `events` knows of a device besides its events: its protocol and the host it is read at. */
export interface DeviceInfo {
  readonly protocol?: Protocol | undefined
  readonly host?: string | undefined
}

/**
 * Advice per event id: for each `device-failing`, the hint table's advice (by the device's protocol from
 * `deviceOf`, any protocol's rules when the device is no longer in the config), and when two or more devices
 * started failing within `SHARED_CAUSE_WINDOW_MS` of the first of them, the shared-cause line on each of them
 * (naming their host when they all sit on one, and the broker when it sits on that host too, `brokerHost`, and went
 * away with them). A flapping alarm gets what a fixed rhythm usually means.
 */
export const adviseEvents = (
  events: ReadonlyArray<AnyEvent>,
  deviceOf: (device: string) => DeviceInfo | undefined,
  brokerHost?: string
): ReadonlyMap<number, EventAdvice> => {
  const advice = new Map<number, EventAdvice>()
  const failures = events.filter((event) => event.type === "device-failing")
  const followers = new Set<number>()
  const hosts = new Map<number, string>()
  const broker = { host: brokerHost, disconnects: events.filter((event) => event.type === "broker-disconnected") }
  for (const shared of sharedCauses(failures, (device) => deviceOf(device)?.host, broker)) {
    const first = Math.min(...shared.ids)
    for (const id of shared.ids) {
      advice.set(id, { sharedCause: shared.line })
      if (shared.host !== undefined) hosts.set(id, shared.host)
      if (id !== first) followers.add(id)
    }
  }
  // The hint knows whether the device worked before and whether others failed with it: then not its config first.
  for (const event of failures) {
    const shared = advice.get(event.id)?.sharedCause
    const sharedHost = hosts.get(event.id)
    const hint = whatToCheck(deviceOf(event.device)?.protocol, event.reason, event.error, {
      answeredBefore: event.answeredBefore === true,
      sharedCause: shared !== undefined,
      ...(sharedHost === undefined ? {} : { sharedHost })
    })
    advice.set(event.id, {
      hint,
      ...(shared === undefined ? {} : { sharedCause: shared }),
      ...(followers.has(event.id) ? {} : { leads: true })
    })
  }
  for (const event of events) {
    if (event.type === "alarm-flapping") advice.set(event.id, { hint: flappingAlarmHint, leads: true })
  }
  return advice
}

/** What failed in the last `windowMs` (15 min), from the events: for `status` after a fault that has cleared. */
export interface RecentIncidents {
  readonly windowMs: number
  /** Devices that started failing in the window, in the order they did, each once. */
  readonly failedDevices: ReadonlyArray<string>
  /** Unix ms of the first and the last of those failures; absent without one. */
  readonly from?: number
  readonly to?: number
  /** Times the broker connection was lost (or a first dial failed) in the window. */
  readonly brokerOutages: number
  /**
   * Each of those outages, oldest first: when it began (`from`), and once the broker was back, when (`to`), how long
   * it lasted (`downMs`) and how many dials failed meanwhile (`retries`, absent from older gateways). The failed
   * connects `broker.failedConnects` counts are these retries, not another problem.
   */
  readonly brokerOutageSpans?: ReadonlyArray<RecentBrokerOutage>
  /**
   * Each failure in the window as the data saw it: from the device's last good read (`lastReadAt`, absent when it
   * had not read yet or from an older gateway) to its first read again (`recoveredAt`, absent while it still fails),
   * and when the gateway called it failing (`detectedAt`). The same span `events` and `history` show.
   */
  readonly outages?: ReadonlyArray<RecentOutage>
  /** Energy counters that went back or jumped in the window (value events), oldest first. */
  readonly counters?: ReadonlyArray<ValueEvent>
}

/** One broker outage, from the lost connection (or the first failed dial) to the connect that ended it. */
export interface RecentBrokerOutage {
  readonly from: number
  readonly to?: number
  readonly downMs?: number
  readonly retries?: number
}

/** One device failure, from its last good read to its first read again. */
export interface RecentOutage {
  readonly device: string
  readonly lastReadAt?: number
  readonly detectedAt: number
  readonly recoveredAt?: number
  /** From `lastReadAt` (or `detectedAt`) to `recoveredAt`, as the gateway measured it. */
  readonly noDataMs?: number
}

/** What `status` says about the last 15 minutes, read from the events ring. */
export const RECENT_WINDOW_MS = 15 * 60_000

/** The incidents of `log` in the `windowMs` before its `now`. */
export const recentIncidents = (log: EventLog, windowMs: number = RECENT_WINDOW_MS): RecentIncidents => {
  const within = log.events.filter((event) => event.at >= log.now - windowMs)
  const failures = within.filter((event) => event.type === "device-failing")
  const first = failures[0]
  const last = failures.at(-1)
  const counters = (log.valueEvents ?? []).filter((event) => event.at >= log.now - windowMs)
  const brokerOutageSpans = within.flatMap((event): Array<RecentBrokerOutage> => {
    if (event.type !== "broker-disconnected") return []
    const back = log.events.find((later) => later.type === "broker-connected" && later.id > event.id)
    if (back?.type !== "broker-connected") return [{ from: event.at }]
    return [
      {
        from: event.at,
        to: back.at,
        ...(back.downMs === undefined ? {} : { downMs: back.downMs }),
        ...(back.retries === undefined ? {} : { retries: back.retries })
      }
    ]
  })
  const outages = failures.map((failure): RecentOutage => {
    const recovered = log.events.find(
      (event) => event.type === "device-recovered" && event.device === failure.device && event.id > failure.id
    )
    const lastReadAt = failure.lastReadAt ?? (recovered?.type === "device-recovered" ? recovered.lastReadAt : undefined)
    if (recovered?.type !== "device-recovered") {
      return { device: failure.device, ...(lastReadAt === undefined ? {} : { lastReadAt }), detectedAt: failure.at }
    }
    return {
      device: failure.device,
      ...(lastReadAt === undefined ? {} : { lastReadAt }),
      detectedAt: failure.at,
      recoveredAt: recovered.at,
      noDataMs: recovered.noDataMs ?? recovered.downMs
    }
  })
  return {
    windowMs,
    failedDevices: [...new Set(failures.map((event) => event.device))],
    ...(first === undefined || last === undefined ? {} : { from: first.at, to: last.at }),
    brokerOutages: brokerOutageSpans.length,
    ...(brokerOutageSpans.length === 0 ? {} : { brokerOutageSpans }),
    ...(outages.length === 0 ? {} : { outages }),
    ...(counters.length === 0 ? {} : { counters })
  }
}

/** `14:03:10`, or `14:03:10–14:05:02` for a span. */
const span = (from: number, to: number, now: number) =>
  from === to ? localTime(from, now) : `${localTime(from, now)}–${localTime(to, now)}`

/**
 * `no data 18:33:03–18:35:23 (2 min 20 s), detected 18:33:11`: an outage as the data saw it, from the last good read
 * to the first read again, and when the gateway called it failing. Without a recovery, `no data since …`.
 */
export const outageText = (
  outage: { readonly lastReadAt?: number; readonly detectedAt: number; readonly recoveredAt?: number },
  noDataMs: number | undefined,
  now: number
) => {
  const from = outage.lastReadAt ?? outage.detectedAt
  const detected = outage.lastReadAt === undefined ? "" : `, detected ${localTime(outage.detectedAt, now)}`
  if (outage.recoveredAt === undefined) return `no data since ${localTime(from, now)}${detected}, still failing`
  const length = noDataMs ?? outage.recoveredAt - from
  return `no data ${span(from, outage.recoveredAt, now)} (${preciseDuration(length)})${detected}`
}

/** Outages `status` lists one per line; more are counted in a line of their own. */
const RECENT_OUTAGE_LINES = 5

/** A number as a line shows it: up to three decimals, no trailing zeros. */
const numberText = (value: number) => String(Number(value.toFixed(3)))

/** `4270 → 12000 kWh`: a counter's two readings with its unit. */
const counterStep = (event: ValueEvent) => {
  const unit = unitLabel(event.unit)
  return `${numberText(event.from)} to ${numberText(event.to)}${unit === "" ? "" : ` ${unit}`}`
}

/** What a counter's event means, in one sentence, for `events` and `status`. */
export const counterText = (event: ValueEvent) => {
  if (event.type === "counter-went-back")
    return `counter went back from ${counterStep(event)}: meter reset or replaced?`
  const unit = unitLabel(event.unit)
  const withUnit = (value: number) => `${numberText(value)}${unit === "" ? "" : ` ${unit}`}`
  // Before the gateway knew the counter's pace: how much it rose, against the reading itself.
  if (event.usualPerHour === undefined)
    return `counter jumped from ${counterStep(event)}: rose by ${withUnit(event.to - event.from)} in ${preciseDuration(event.elapsedMs)}, ${counterShareText(event.from, event.to)}: meter reset or replaced, or another device answering at its address?`
  return `counter jumped from ${counterStep(event)} in ${preciseDuration(event.elapsedMs)}, more than ${COUNTER_RATE_FACTOR}× its fastest rise of the last hour (${withUnit(event.usualPerHour)}/h): meter reset or replaced, or another device answering at its address?`
}

/**
 * The lines about the last 15 minutes: devices that failed and for how long, the broker lost, energy counters that
 * went back or jumped, so a gateway that is fine again does not read as one that always was. Empty when nothing
 * happened.
 */
const recentLines = (recent: RecentIncidents, now: number) => {
  const minutes = `${Math.round(recent.windowMs / 60_000)} min`
  // An older gateway's events say neither when the data stopped nor when it came back: the one summary line then.
  const outages = (recent.outages ?? []).some(
    (outage) => outage.lastReadAt !== undefined || outage.recoveredAt !== undefined
  )
    ? (recent.outages ?? [])
    : []
  const shown = outages.slice(-RECENT_OUTAGE_LINES)
  const width = Math.max(0, ...shown.map((outage) => outage.device.length))
  const devices =
    recent.failedDevices.length === 0 || recent.from === undefined || recent.to === undefined
      ? []
      : outages.length === 0
        ? [
            `  ${plural(recent.failedDevices.length, "device")} failed in the last ${minutes} (${span(recent.from, recent.to, now)}: ${named(recent.failedDevices)}), see ot-gateway events`
          ]
        : [
            `  ${plural(recent.failedDevices.length, "device")} failed in the last ${minutes}, see ot-gateway events:`,
            ...(outages.length > shown.length
              ? [`    (${plural(outages.length - shown.length, "earlier failure")} left out)`]
              : []),
            ...shown.map((outage) => `    ${outage.device.padEnd(width)}  ${outageText(outage, outage.noDataMs, now)}`)
          ]
  const spans = recent.brokerOutageSpans ?? []
  const times = recent.brokerOutages === 1 ? "once" : `${recent.brokerOutages} times`
  const broker =
    recent.brokerOutages === 0
      ? []
      : [
          `  broker connection lost ${times} in the last ${minutes}${spans.length === 0 ? "" : ` (${spans.map((outage) => brokerOutageText(outage, now)).join("; ")})`}, see ot-gateway events`
        ]
  const counters = (recent.counters ?? []).map(
    (event) => `  ${event.device}/${event.point} at ${localTime(event.at, now)}: ${counterText(event)}`
  )
  return [...devices, ...broker, ...counters]
}

/**
 * `14:15:35–14:17:43, 2 min 7 s, 14 retries`: a broker outage with the dials that failed during it, or `since
 * 14:15:35` while it lasts (the broker line says whether it is back).
 */
export const brokerOutageText = (outage: RecentBrokerOutage, now: number) => {
  if (outage.to === undefined) return `since ${localTime(outage.from, now)}`
  const retries =
    outage.retries === undefined ? "" : `, ${outage.retries} ${outage.retries === 1 ? "retry" : "retries"}`
  return `${span(outage.from, outage.to, now)}, ${preciseDuration(outage.downMs ?? outage.to - outage.from)}${retries}`
}

/** `on 30 s, off 30 s, 6 times in 6 min`: how a flapping alarm switched. */
export const patternText = (pattern: AlarmPattern) =>
  [
    ...(pattern.onMs === undefined ? [] : [`on ${ago(pattern.onMs)}`]),
    ...(pattern.offMs === undefined ? [] : [`off ${ago(pattern.offMs)}`]),
    `${plural(pattern.raised, "time")} in ${ago(pattern.overMs)}`
  ].join(", ")

/**
 * The alarm lines: how many alarm points there are and how many are active, then one line for each that is active
 * or was raised in the last 15 minutes. Nothing for a config without alarm points.
 */
const alarmLines = (alarms: ReadonlyArray<AlarmStatus>, now: number, brief = false) => {
  if (alarms.length === 0) return []
  const active = alarms.filter((alarm) => alarm.active === true)
  const all = [...active, ...alarms.filter((alarm) => alarm.active !== true && alarm.raised > 0)]
  // A terminal names the first few, the active ones first; --json has every alarm.
  const { shown: noteworthy, more } = brief ? firstOf(all, LISTED) : { shown: all, more: 0 }
  const width = Math.max(0, ...noteworthy.map((alarm) => `${alarm.device}/${alarm.point}`.length))
  const minutes = `${Math.round(ALARM_WINDOW_MS / 60_000)} min`
  return [
    `  ${plural(alarms.length, "alarm point")}, ${active.length === 0 ? "none" : count(active.length)} active`,
    ...noteworthy.flatMap((alarm) => {
      const state =
        alarm.active === true
          ? `ACTIVE${alarm.since === undefined ? "" : ` since ${localTime(alarm.since, now)} (${ago(now - alarm.since)})`}`
          : `off${alarm.since === undefined ? "" : ` since ${localTime(alarm.since, now)}`}`
      const raised =
        alarm.raised === 0
          ? ""
          : `, raised ${plural(alarm.raised, "time")} in the last ${minutes}${alarm.flapping ? ` (flapping${alarm.pattern === undefined ? "" : `, ${patternText(alarm.pattern)}`}: its changes are counted, not listed, until it keeps still for ${ago(ALARM_SETTLE_MS)})` : ""}`
      return [
        `    ${`${alarm.device}/${alarm.point}`.padEnd(width)}  ${state}${raised}`,
        ...(alarm.flapping ? [`    ${" ".repeat(width)}  check: ${flappingAlarmHint.checks[0] ?? ""}`] : [])
      ]
    }),
    ...(more > 0 ? [`    and ${count(more)} more: --json lists every alarm`] : [])
  ]
}

/** `5 s`, `1.5 s`, `500 ms`, `1 min`: how often a device is read. */
export const intervalText = (milliseconds: number) =>
  milliseconds < 1000
    ? `${milliseconds} ms`
    : milliseconds < 60_000 && milliseconds % 1000 !== 0
      ? `${numberText(milliseconds / 1000)} s`
      : preciseDuration(milliseconds)

/** A device's state as `status` shows it: the gateway's, or `late` for an `ok` device not read lately. */
const deviceStateName = (device: GatewayStatus["devices"][number], now: number) =>
  isDeviceLate(device, now) ? "late" : device.status

/** What is wrong, in one line, for the exit code's message; undefined when nothing is. */
export const unhealthySummary = (status: GatewayStatus) => {
  const inState = (state: string) =>
    status.devices.filter((device) => deviceStateName(device, status.now) === state).length
  const failing = inState("failing")
  const late = inState("late")
  const problems = [
    ...(failing > 0 ? [`${count(failing)} of ${plural(status.devices.length, "device")} failing`] : []),
    ...(late > 0 ? [`${count(late)} of ${plural(status.devices.length, "device")} late`] : []),
    ...(brokerAway(status.broker) ? ["broker not connected"] : [])
  ]
  return problems.length === 0 ? undefined : problems.join(", ")
}

/**
 * Whether everything works: no device failing or late, and the broker connected or still making its first
 * connect. A gateway that has just started (devices `starting`, no failed connect yet) is fine.
 */
export const isHealthy = (status: GatewayStatus) => unhealthySummary(status) === undefined

/** `failing since 12:18:20 (1 min): <why>`, `read 3 s ago`, or for a late device how long it has had no read. */
const deviceState = (device: GatewayStatus["devices"][number], now: number) => {
  if (device.status === "failing") {
    const why = withoutControls(device.lastError ?? device.reason ?? "no reason given")
    return device.failingSince === undefined
      ? `failing: ${why}`
      : `failing since ${localTime(device.failingSince, now)} (${ago(now - device.failingSince)}): ${why}`
  }
  if (device.lastSuccess === undefined) return "no read yet"
  return isDeviceLate(device, now)
    ? `no read for ${ago(now - device.lastSuccess)}, though not failing: a polling cycle is stuck`
    : `read ${ago(now - device.lastSuccess)} ago`
}

/**
 * `connected since 12:00:01, 3 failed connects since start`, `NOT CONNECTED since 12:18:20 (1 min): <why>`, or
 * `connecting (started 2 s ago)` while the first connect is under way. A connected broker whose failed connects are
 * all retries of the outages `recent` lists says nothing of them here: the outage line has them, as one problem.
 */
const brokerState = (broker: GatewayStatus["broker"], now: number, started: number, recent?: RecentIncidents) => {
  const spans = recent?.brokerOutageSpans ?? []
  const explained =
    broker.connected && spans.length > 0 && spans.every((outage) => outage.retries !== undefined)
      ? spans.reduce((sum, outage) => sum + (outage.retries ?? 0), 0)
      : 0
  const failed =
    broker.failedConnects > explained ? `, ${plural(broker.failedConnects, "failed connect")} since start` : ""
  if (broker.connected) {
    return `${broker.connectedAt === undefined ? "connected" : `connected since ${localTime(broker.connectedAt, now)}`}${failed}`
  }
  if (!brokerAway(broker)) return `connecting (started ${ago(now - started)} ago)`
  const since =
    broker.disconnectedSince === undefined
      ? ""
      : ` since ${localTime(broker.disconnectedSince, now)} (${ago(now - broker.disconnectedSince)})`
  const why = broker.lastError === undefined ? "" : `: ${withoutControls(broker.lastError)}`
  return `NOT CONNECTED${since}${why}${failed}`
}

/**
 * The report: the gateway, its broker and buffer, then one aligned line per device, and a hint when failing; then
 * the alarms, and with `recent` what failed in the last 15 minutes. `brief` (a terminal) counts the devices
 * however few and lists only the ones not ok, the first few, each hint once: `status --all`, a pipe and --json have
 * every device.
 */
export const formatStatus = (
  status: GatewayStatus,
  recent?: RecentIncidents,
  options: { readonly brief?: boolean } = {}
) => {
  const stateOf = (device: GatewayStatus["devices"][number]) => deviceStateName(device, status.now)
  const failing = status.devices.filter((device) => device.status === "failing").length
  const late = status.devices.filter((device) => isDeviceLate(device, status.now)).length
  const shared = sharedCause(status.devices, status.broker)
  const sharedHost = shared === undefined ? undefined : sharedHostOf(deviceSide(status.devices))
  // With no devices there is nothing to sum up or to list with --all.
  const brief = (options.brief ?? false) && status.devices.length > 0
  // The failing first, then late, then starting: what needs a look most is never behind "and N more".
  const rank: Readonly<Record<string, number>> = { failing: 0, late: 1, starting: 2 }
  const needing = status.devices
    .filter((device) => stateOf(device) !== "ok")
    .toSorted((a, b) => (rank[stateOf(a)] ?? 3) - (rank[stateOf(b)] ?? 3))
  const { shown, more } = brief ? firstOf(needing) : { shown: status.devices, more: 0 }
  const width = Math.max(0, ...shown.map((device) => device.id.length))
  const states = ["ok", "failing", "late", "starting"].flatMap((state) => {
    const many = status.devices.filter((device) => stateOf(device) === state).length
    return many === 0 ? [] : [`${count(many)} ${state}`]
  })
  const deviceHeader = brief
    ? `  ${plural(status.devices.length, "device")}: ${states.join(", ")}`
    : `  ${plural(status.devices.length, "device")}${failing > 0 ? `, ${count(failing)} failing` : ""}${late > 0 ? `, ${count(late)} late` : ""}`
  let lastCheck: string | undefined
  const deviceLines = shown.flatMap((device) => {
    const check =
      device.status === "failing" ? (hintsFor(device, shared !== undefined, sharedHost).checks[0] ?? "") : undefined
    // In a terminal, devices failing the same way share their hint: it is said once, under the first.
    const repeated = brief && check !== undefined && check === lastCheck
    if (check !== undefined) lastCheck = check
    return [
      `    ${device.id.padEnd(width)}  ${stateOf(device).padEnd(8)} ${device.protocol}, ${plural(device.pointCount, "point")} every ${intervalText(device.pollIntervalMs)}, ${deviceState(device, status.now)}`,
      ...(check === undefined || repeated ? [] : [`    ${" ".repeat(width)}  check: ${check}`])
    ]
  })
  return [
    `${status.site}/${status.building} gateway ${status.id}, up ${ago(status.now - status.since)} (since ${localTime(status.since, status.now)})`,
    `  broker ${status.broker.url}: ${brokerState(status.broker, status.now, status.since, recent)}`,
    ...(status.buffer === undefined
      ? []
      : [
          `  buffer: ${count(status.buffer.rows)} of ${plural(status.buffer.maxRows, "message")} waiting` +
            (status.buffer.dropped > 0 ? `, ${count(status.buffer.dropped)} DROPPED since start` : "")
        ]),
    deviceHeader,
    ...deviceLines,
    ...(more > 0 ? [`    and ${count(more)} more ${restState(needing.slice(shown.length).map(stateOf))}`] : []),
    ...(brief ? ["    --all lists every device"] : []),
    ...(shared === undefined ? [] : [`  ${shared}`]),
    ...alarmLines(status.alarms ?? [], status.now, brief),
    ...(recent === undefined ? [] : recentLines(recent, status.now)),
    ...(servesEvents(status) ? [] : [noEventsLine(status)]),
    ...(isHealthy(status) ? [] : ["", ...failingHint])
  ].join("\n")
}

/** The state the devices left out share (`failing`), or `not ok` when they differ. */
const restState = (states: ReadonlyArray<string>) => (new Set(states).size === 1 ? (states[0] ?? "not ok") : "not ok")

/** Under the report of a gateway before v0.13, which keeps no events: why nothing recent is listed. */
const noEventsLine = (status: Pick<GatewayStatus, "host">) =>
  `  (this gateway runs ${versionName(gatewayVersionOf(status) ?? "an older release")}, which keeps no events: upgrade it to v${EVENTS_RELEASE.join(".")} or later to see what failed lately)`

const unreachableAdvice =
  "Is the gateway running (ot-gateway run, or ot-gateway demo), with a status block in its config? Name its config, or pass --url for a page elsewhere."

/**
 * Why a request to the status page found nothing, in the socket's words: fetch fails with `fetch failed` and the
 * system error (`connection refused by 127.0.0.1:8080`) as its cause.
 */
export const transportReason = (error: HttpClientError.HttpClientError) => {
  const cause = error.reason.cause
  const inner = cause instanceof Error ? cause.cause : undefined
  return causeText(inner) ?? causeText(cause) ?? error.reason.description ?? error.message
}

const gatewayClient = (url: string) => HttpApiClient.make(OtGatewayApi, { baseUrl: url })

/** A call to the gateway at `url` through the page's typed client, within three seconds. */
export const askGateway = <A>(
  url: string,
  ask: (
    client: Effect.Success<ReturnType<typeof gatewayClient>>
  ) => Effect.Effect<A, HttpClientError.HttpClientError | Schema.SchemaError | ValuesQueryInvalid>
): Effect.Effect<A, GatewayUnreachable | GatewayAnswerUnreadable, FileSystem.FileSystem> =>
  gatewayClient(url).pipe(
    Effect.flatMap(ask),
    Effect.provide(FetchHttpClient.layer),
    Effect.catchTags({
      // Nothing answered, or not over HTTP: the gateway is not there.
      HttpClientError: (error) =>
        error.reason._tag === "TransportError" ||
        error.reason._tag === "EncodeError" ||
        error.reason._tag === "InvalidUrlError"
          ? Effect.fail(
              new GatewayUnreachable({
                url,
                message: `no gateway status at ${url}: ${transportReason(error)}`,
                code: "gateway-unreachable",
                hint: unreachableAdvice
              })
            )
          : unreadableAnswer(url, error.message),
      // It answered, in a form this CLI does not read: another release, most likely.
      SchemaError: (error) => unreadableAnswer(url, error.message),
      // More points asked for than one request may name: the CLI asks in chunks, so a gateway with a lower limit.
      ValuesQueryInvalid: (error) => unreadableAnswer(url, error.message)
    }),
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () =>
        Effect.fail(
          new GatewayUnreachable({
            url,
            message: `no gateway status at ${url}: no answer within 3 s`,
            code: "gateway-unreachable",
            hint: unreachableAdvice
          })
        )
    })
  )

/** Just the version from a status answer of any release: `host.version`. */
const VersionProbe = Schema.Struct({ host: Schema.Struct({ version: Schema.String }) })

/**
 * Something answered at `url` that this CLI cannot read: says which release the gateway runs when its status says
 * (asked again, read for its version alone), and the CLI's, with the two ways out.
 */
const unreadableAnswer = Effect.fnUntraced(function* (
  url: string,
  detail: string
): Effect.fn.Return<never, GatewayAnswerUnreadable, FileSystem.FileSystem> {
  const cliVersion = versionName(yield* readVersion)
  // A schema's issue spans lines (`Missing key\n  at ["configSince"]`): one line in an error message.
  const reason = detail.replace(/\s+/g, " ")
  // Only for the message: a gateway that does not say its version is named "another release".
  const gatewayVersion = yield* HttpClient.get(`${url}/api/status?points=none`).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(VersionProbe)),
    Effect.map((status) => versionName(status.host.version)),
    Effect.provide(FetchHttpClient.layer),
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed(() => undefined)
  )
  return yield* new GatewayAnswerUnreadable({
    url,
    code: "gateway-unreadable",
    message:
      gatewayVersion === undefined
        ? `the gateway at ${url} answers in a form this CLI (${cliVersion}) cannot read (${reason}). It may run another release: upgrade the gateway, or run the CLI at the gateway's version`
        : `this gateway runs ${gatewayVersion}, the CLI is ${cliVersion}, and the CLI cannot read its answer (${reason}). Upgrade the gateway, or run the CLI at ${gatewayVersion}`
  })
})

/**
 * Fails with `GatewayTooOld` when the gateway of `status` serves no `/api/events` and `/api/messages/window` (before
 * v0.13), naming both versions: `what` is the command that needs them.
 */
export const requireEvents = Effect.fnUntraced(function* (
  target: GatewayTarget,
  status: Pick<GatewayStatus, "host">,
  what: string
) {
  if (yield* gatewayServesEvents(target.url, status)) return
  const cliVersion = yield* readVersion
  const gatewayVersion = gatewayVersionOf(status)
  return yield* new GatewayTooOld({
    url: target.url,
    message:
      gatewayVersion === undefined
        ? `the gateway at ${target.url} serves no events, so it runs a release before v${EVENTS_RELEASE.join(".")}, and the CLI is ${versionName(cliVersion)}: ${what} needs a gateway of v${EVENTS_RELEASE.join(".")} or later. Upgrade the gateway, or run the CLI at the gateway's version`
        : tooOldMessage({ gatewayVersion, cliVersion, what, release: EVENTS_RELEASE })
  })
})

/**
 * Whether the gateway of `status` serves `/api/events` (and `/api/messages/window`): by its version, or, when it names
 * none yet (its status before the host monitor's first sample, seconds after it starts), by asking. An older gateway
 * answers 404, or its status page as HTML; when the question itself fails, the request that follows says why.
 */
export const gatewayServesEvents = Effect.fnUntraced(function* (url: string, status: Pick<GatewayStatus, "host">) {
  if (gatewayVersionOf(status) !== undefined) return servesEvents(status)
  return yield* HttpClient.get(`${url}/api/events?after=${Number.MAX_SAFE_INTEGER}`).pipe(
    Effect.map(
      (response) => response.status === 200 && (response.headers["content-type"] ?? "").includes("application/json")
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed(() => true)
  )
})

/** The status from the gateway at `url`, within three seconds; `"none"` without each point's value. */
export const fetchGatewayStatus = (url: string, points: "all" | "none" = "all") =>
  askGateway(url, (client) => client.status.status({ query: { points } }))

/** The events the gateway at `url` keeps, within three seconds; with `after`, only those after that id. */
export const fetchGatewayEvents = (url: string, after?: number) =>
  askGateway(url, (client) => client.status.events({ query: after === undefined ? {} : { after } }))

/** How many alarm points of `status` are active now. */
export const activeAlarms = (status: Pick<GatewayStatus, "alarms">) =>
  (status.alarms ?? []).filter((alarm) => alarm.active === true).length

/** The alarm points active now, in a line: for `--fail-on-alarm`'s exit. */
export class AlarmActive extends Schema.TaggedError<AlarmActive>()("AlarmActive", {
  message: Schema.String
}) {}

/**
 * Prints the report for `status`, then fails with `GatewayUnhealthy` when something is failing, so the exit code
 * is 1. With `json`, the report is the status page's own `/api/status` answer with `ok` in front, values included.
 * The exit code is about the gateway's health: an active alarm is the building's, not the gateway's, so it sets
 * the code only with `failOnAlarm` (`AlarmActive`), for a script that wants to act on one.
 */
export const statusOutcome = (
  json: boolean,
  options: { readonly failOnAlarm?: boolean; readonly brief?: boolean } = {}
) =>
  Effect.fnUntraced(function* (status: GatewayStatus, recent?: RecentIncidents) {
    yield* json
      ? printJsonWithLocalTimes(statusJson(status, recent))
      : Console.log(formatStatus(status, recent, { brief: options.brief ?? false }))
    const summary = unhealthySummary(status)
    if (summary !== undefined) return yield* new GatewayUnhealthy({ message: summary })
    const active = activeAlarms(status)
    if (options.failOnAlarm === true && active > 0) {
      const which = (status.alarms ?? [])
        .filter((alarm) => alarm.active === true)
        .map((alarm) => `${alarm.device}/${alarm.point}`)
      return yield* new AlarmActive({ message: `${plural(active, "alarm")} active: ${named(which)}` })
    }
  })

/**
 * What `status --json` prints: `/api/status` with `ok` and `alarmsActive` (how many alarm points are active now,
 * which `ok` leaves out) in front, for each failing device `hints`, what it means
 * and what to check, most likely first (the status page's table), and `recent`, what failed in the last 15 minutes
 * (from the events), so `ok: true` right after an outage does not hide it.
 */
export const statusJson = (status: GatewayStatus, recent?: RecentIncidents) => {
  const shared = sharedCause(status.devices, status.broker) !== undefined
  const sharedHost = shared ? sharedHostOf(deviceSide(status.devices)) : undefined
  const problem = unhealthySummary(status)
  return {
    ok: isHealthy(status),
    // What is wrong in one line, as the text's last line: `2 of 3 devices failing, broker not connected`.
    ...(problem === undefined ? {} : { problem }),
    alarmsActive: activeAlarms(status),
    ...status,
    devices: status.devices.map((device) =>
      device.status === "failing" ? { ...device, hints: hintsFor(device, shared, sharedHost) } : device
    ),
    ...(status.alarms === undefined
      ? {}
      : { alarms: status.alarms.map((alarm) => (alarm.flapping ? { ...alarm, hint: flappingAlarmHint } : alarm)) }),
    ...(recent === undefined ? {} : { recent })
  }
}

/**
 * The status `ot-gateway status` reports on, from the gateway the target expects (else `GatewayMismatch`), and what
 * failed in the last 15 minutes from its events: the lines need only the devices, `--json` gives everything.
 */
export const fetchStatusFor = Effect.fnUntraced(function* (
  target: GatewayTarget,
  options: { readonly json?: boolean } = {}
) {
  const status = yield* fetchGatewayStatus(target.url, options.json === true ? "all" : "none")
  yield* checkIdentity(target, status)
  // A gateway of the previous release serves no events: its report goes without what failed lately.
  if (!(yield* gatewayServesEvents(target.url, status))) return { status, recent: undefined }
  const log = yield* fetchGatewayEvents(target.url)
  return { status, recent: recentIncidents(log) }
})

/** `10m`, `2h`, `30s`, `1d`, or `all`: how far back `events` looks, in ms (Infinity for all). */
export const parseSince = (text: string): number | undefined => {
  if (text === "all") return Number.POSITIVE_INFINITY
  const match = /^(\d+)\s*(s|m|min|h|d)$/.exec(text.trim())
  if (match === null) return undefined
  const unit = match[2] === "s" ? 1_000 : match[2] === "h" ? 3_600_000 : match[2] === "d" ? 86_400_000 : 60_000
  return Number(match[1]) * unit
}

/** The subject of an event's line: the device, or the part of the gateway it is about. */
const subjectOf = (event: AnyEvent) => {
  switch (event.type) {
    case "counter-went-back":
    case "counter-jumped":
      return `${event.device}/${event.point}`
    case "gateway-started":
      return "gateway"
    case "device-failing":
    case "device-recovered":
      return event.device
    case "broker-disconnected":
    case "broker-connected":
      return "broker"
    case "buffer-drained":
      return "buffer"
    case "config-applied":
    case "config-apply-failed":
      return "config"
    case "gateway-conflict":
      return event.gateway
    case "alarm-raised":
    case "alarm-cleared":
    case "alarm-flapping":
    case "alarm-settled":
      return `${event.device}/${event.point}`
  }
}

/** A point's value in an alarm line: `true`, `0`, `1.5`. */
const valueText = (value: number | boolean) => String(value)

/**
 * What happened, after the subject: `failing: could not connect: …`, `answering again: no data 18:33:03–18:35:23
 * (2 min 20 s), detected 18:33:11`.
 */
const describeEvent = (event: AnyEvent, now: number) => {
  switch (event.type) {
    case "counter-went-back":
    case "counter-jumped":
      return counterText(event)
    case "gateway-started":
      return `started (${event.version}, ${plural(event.devices, "device")})${
        event.previousRun === undefined
          ? ""
          : event.previousRun.stopped === undefined
            ? `; the run before (started ${localTime(event.previousRun.started, now)}) did not stop cleanly: a crash, a power cut or the OOM killer`
            : `; the run before stopped cleanly at ${localTime(event.previousRun.stopped, now)}`
      }`
    case "device-failing":
      return `failing: ${withoutControls(event.error === "" ? event.reason : event.error)}${event.lastReadAt === undefined ? "" : ` (last read ${localTime(event.lastReadAt, now)})`}`
    case "device-recovered":
      return event.lastReadAt === undefined || event.failingSince === undefined
        ? `ok again after ${preciseDuration(event.downMs)}`
        : `answering again: ${outageText(
            { lastReadAt: event.lastReadAt, detectedAt: event.failingSince, recoveredAt: event.at },
            event.noDataMs,
            now
          )}`
    case "broker-disconnected":
      return `disconnected: ${withoutControls(event.error)}`
    case "broker-connected":
      return [
        event.downMs === undefined ? "connected" : `connected again after ${preciseDuration(event.downMs)}`,
        ...(event.buffered === undefined || event.buffered === 0
          ? []
          : [`${plural(event.buffered, "message")} waiting in the buffer at reconnect`])
      ].join(", ")
    case "buffer-drained": {
      if (event.delivered === undefined) return "drained: every waiting message delivered"
      const parts = drainedParts(event)
      return parts === undefined
        ? `drained: ${plural(event.delivered, "message")} delivered from the buffer`
        : `drained: ${plural(event.delivered, "message")} delivered from the buffer since the broker came back: the ${parts.buffered} waiting at reconnect and ${parts.queued} queued behind them${parts.dropped > 0 ? `, less ${parts.dropped} the buffer dropped` : ""}`
    }
    case "config-applied":
      return `applied from the status page: ${withoutControls(event.summary)}`
    case "config-apply-failed":
      return `not applied, the previous config runs again: ${withoutControls(event.error)}`
    case "gateway-conflict":
      return event.sameId
        ? "another gateway with this gateway's id is online: both publish into the same topics"
        : `another gateway is online with the same device ids (${named(event.devices)}): both publish into the same topics`
    case "alarm-raised":
      return event.first === true
        ? `alarm active at its first read (value ${valueText(event.value)})`
        : event.afterOutage === true
          ? `alarm active when ${event.device} answered again (value ${valueText(event.value)}), ${unknownStateText(event.unknownMs)}`
          : `alarm raised (value ${valueText(event.value)})`
    case "alarm-cleared":
      return event.afterOutage === true
        ? `alarm off when ${event.device} answered again (value ${valueText(event.value)}), ${unknownStateText(event.unknownMs)}`
        : `alarm cleared after ${preciseDuration(event.activeMs)} (value ${valueText(event.value)})`
    case "alarm-flapping":
      return `alarm raised ${event.raised} times in the last ${ago(ALARM_WINDOW_MS)}: flapping${event.pattern === undefined ? "" : ` (${patternText(event.pattern)})`}, so its changes are counted, not listed, until it keeps still for ${ago(ALARM_SETTLE_MS)}`
    case "alarm-settled":
      return `alarm keeps still, ${event.active ? "ACTIVE" : "off"} since ${localTime(event.since, now)}; ${plural(event.unlisted, "change")} ${event.unlisted === 1 ? "was" : "were"} counted, not listed${event.pattern === undefined ? "" : ` (it flapped ${patternText(event.pattern)})`}`
  }
}

/** The events of `log` (the gateway's and the value events) at or after `sinceMs` before the gateway's `now`. */
export const eventsWithin = (log: EventLog, sinceMs: number) =>
  allEvents(log).filter((event) => event.at >= log.now - sinceMs)

/** The protocol and host of each device of a status, for the hints of `events`. */
export const devicesOf = (status: Pick<GatewayStatus, "devices">) => {
  const devices = new Map(
    status.devices.map((device): [string, DeviceInfo] => [device.id, { protocol: device.protocol, host: device.host }])
  )
  return (device: string) => devices.get(device)
}

/**
 * One line per event, oldest first: local time, subject, what happened. Under a device's failure, the first thing
 * to check (the status page's hint table); after the last of several devices that failed within 10 s of each
 * other, that they likely share a cause.
 */
/** What `events` knows of the gateway besides its events: its broker's host and when it started (Unix ms). */
export interface EventsContext {
  readonly brokerHost?: string | undefined
  readonly started?: number | undefined
}

export const formatEvents = (
  log: EventLog,
  sinceMs: number,
  sinceText: string,
  deviceOf: (device: string) => DeviceInfo | undefined = () => undefined,
  context: EventsContext = {}
) => {
  const events = eventsWithin(log, sinceMs)
  const window = sinceMs === Number.POSITIVE_INFINITY ? "since the gateway started" : `in the last ${sinceText}`
  // A window that reaches back past the gateway's start: say so, as `history` does, so its quiet start is not read
  // as a quiet site.
  const before =
    context.started !== undefined && log.now - sinceMs < context.started
      ? [`the gateway started at ${localTime(context.started, log.now)}: nothing is known before that`]
      : []
  const all = allEvents(log)
  // The ring let older events go and the oldest kept is inside the window: some of the window is missing.
  const gap =
    log.dropped > 0 && events.length > 0 && events.length === all.length
      ? [`(the gateway keeps the latest ${log.capacity} events; ${log.dropped} older ones were let go)`]
      : []
  if (events.length === 0) return [...before, `no events ${window}`].join("\n")
  const width = Math.max(...events.map((event) => subjectOf(event).length))
  const advice = adviseEvents(all, deviceOf, context.brokerHost)
  // The shared-cause line goes once, after the last failure of its group that is shown.
  const sharedShown = new Set<string>()
  const sharedAfter = new Set<number>()
  for (const event of events.toReversed()) {
    const shared = advice.get(event.id)?.sharedCause
    if (shared === undefined || sharedShown.has(shared)) continue
    sharedShown.add(shared)
    sharedAfter.add(event.id)
  }
  // Devices that fail together share their advice: a check said under the one before is not said again.
  let previous: ReadonlyArray<string> = []
  return [
    ...before,
    ...gap,
    ...events.flatMap((event) => {
      const line = eventLine(event, log.now, width)
      const indent = " ".repeat(localTime(event.at, log.now).length + 2 + width + 2)
      const found = advice.get(event.id)
      const checks = adviceLines(found?.hint, indent, found?.leads === true ? LEAD_CHECKS : 1)
      // Only for failures in a row: any other event in between, and the next failure has its checks again.
      const repeated = checks.length > 0 && checks.every((check, index) => previous[index] === check)
      previous = checks
      return [
        line,
        ...(repeated ? [] : checks),
        ...(found?.sharedCause !== undefined && sharedAfter.has(event.id) ? [`${indent}${found.sharedCause}`] : [])
      ]
    })
  ].join("\n")
}

/** Checks `events` lists under a failure that leads its group, or failed alone. */
export const LEAD_CHECKS = 3

/** `check: <the most likely cause>` under a device's failure, then up to `most - 1` more, most likely first. */
const adviceLines = (hint: Hint | undefined, indent: string, most: number) => {
  const checks = hint?.checks.slice(0, most) ?? []
  return checks.map((check, index) => `${indent}${index === 0 ? "check: " : "  then: "}${check}`)
}

/** One event's line: local time, subject, what happened; the subject padded to `width`. */
export const eventLine = (event: AnyEvent, now: number, width = 0) =>
  `${localTime(event.at, now)}  ${subjectOf(event).padEnd(width)}  ${describeEvent(event, now)}`

/**
 * An event as `events --json` gives it: as the gateway keeps it, with `hint` (what it means, what to check) for a
 * device that failed or an alarm that flaps, and `sharedCause` when others failed with it.
 */
export const eventJson = (event: AnyEvent, advice: ReadonlyMap<number, EventAdvice>) => {
  const found = advice.get(event.id)
  return {
    ...event,
    ...(found?.hint === undefined ? {} : { hint: found.hint }),
    ...(found?.sharedCause === undefined ? {} : { sharedCause: found.sharedCause })
  }
}

/**
 * What `events --json` prints: `{ok, gateway, now, gatewayStarted, from, capacity, dropped, events}`, the events
 * as `eventJson` gives them. The window's events cover from `from`: the window's start, or the gateway's start
 * (`started`) when that is later.
 */
export const eventsJson = (
  gateway: { readonly site: string; readonly building: string; readonly id: string },
  log: EventLog,
  started: number,
  sinceMs: number,
  events: ReadonlyArray<ReturnType<typeof eventJson>>
) => ({
  ok: true,
  gateway,
  now: log.now,
  gatewayStarted: started,
  from: Math.max(log.now - sinceMs, started),
  capacity: log.capacity,
  dropped: log.dropped,
  events
})

export interface EventsOptions {
  readonly since: string
  readonly sinceMs: number
  readonly json?: boolean
  /** Go on printing new events as they come, until interrupted (Ctrl-C) or for `seconds`. */
  readonly follow?: boolean
  readonly seconds?: number | undefined
}

/** How often `events --follow` asks for new events: the status page asks as often. */
export const FOLLOW_INTERVAL: Duration.Input = "2 seconds"

/**
 * Prints the gateway's events of the last `since` (`10m`, `all`), oldest first, after the gateway's name; with
 * `follow`, then each new one as it comes. With `json`, a document `{ok, gateway, now, capacity, dropped, events}`,
 * or with `follow` one event per line (NDJSON), the ones in the window first.
 */
export const eventsReport = Effect.fn("eventsReport")(function* (target: GatewayTarget, options: EventsOptions) {
  const status = yield* fetchGatewayStatus(target.url, "none")
  yield* checkIdentity(target, status)
  yield* requireEvents(target, status, "events")
  const log = yield* fetchGatewayEvents(target.url)
  const gateway = { site: status.site, building: status.building, id: status.id }
  const deviceOf = devicesOf(status)
  const context = { brokerHost: brokerHostOf(status.broker.url), started: status.since }
  const advice = adviseEvents(allEvents(log), deviceOf, context.brokerHost)
  const events = eventsWithin(log, options.sinceMs).map((event) => eventJson(event, advice))
  if (options.json === true && options.follow !== true) {
    return yield* printJsonWithLocalTimes(eventsJson(gateway, log, status.since, options.sinceMs, events))
  }
  if (options.json === true) {
    for (const event of events) yield* printResult(jsonLineWithLocalTimes(event))
  } else {
    const window =
      options.follow === true
        ? options.seconds === undefined
          ? "then what comes (Ctrl-C to stop)"
          : `then what comes for ${options.seconds} s`
        : ""
    yield* printResult(`${gatewayName(gateway)} at ${target.url}${window === "" ? "" : `, ${window}`}`)
    yield* printResult(formatEvents(log, options.sinceMs, options.since, deviceOf, context))
  }
  if (options.follow !== true) return
  const follow = followEvents((after) => fetchGatewayEvents(target.url, after), allEvents(log).at(-1)?.id ?? 0, {
    json: options.json === true,
    deviceOf
  })
  if (options.seconds === undefined) return yield* follow
  yield* Effect.timeoutOrElse(follow, { duration: `${options.seconds} seconds`, orElse: () => Effect.void })
})

/**
 * Asks `fetchAfter` for the events after `lastId` every `FOLLOW_INTERVAL` and prints each new one, until
 * interrupted. A gateway that stops answering is said once (on stderr), and once more when it is back; one that
 * restarted counts its ids from 1 again, which the gateway answers with everything it keeps, and that is said too.
 */
export const followEvents = Effect.fn("followEvents")(function* <R>(
  fetchAfter: (after: number) => Effect.Effect<EventLog, GatewayUnreachable | GatewayAnswerUnreadable, R>,
  lastId: number,
  options: { readonly json: boolean; readonly deviceOf?: (device: string) => DeviceInfo | undefined }
) {
  const json = options.json
  const deviceOf = options.deviceOf ?? (() => undefined)
  let last = lastId
  let away = false
  while (true) {
    yield* Effect.sleep(FOLLOW_INTERVAL)
    const answer = yield* fetchAfter(last).pipe(
      Effect.catchTag("GatewayUnreachable", (error) =>
        Effect.as(away ? Effect.void : Console.error(`lost the gateway, asking again: ${error.message}`), undefined)
      )
    )
    if (answer === undefined) {
      away = true
      continue
    }
    if (away) yield* Console.error("the gateway answers again")
    away = false
    const fresh = allEvents(answer)
    const first = fresh[0]
    if (first !== undefined && first.id <= last) {
      yield* Console.error("the gateway restarted: its events start over")
    }
    // Each new failure gets its hint; a shared cause needs the others of its group, which `events` shows afterwards.
    const hints = adviseEvents(fresh, deviceOf)
    for (const event of fresh) {
      const found = hints.get(event.id)
      const hint = found?.hint
      yield* printResult(
        json
          ? jsonLineWithLocalTimes(eventJson(event, new Map(hint === undefined ? [] : [[event.id, { hint }]])))
          : [
              eventLine(event, answer.now),
              ...adviceLines(
                hint,
                " ".repeat(localTime(event.at, answer.now).length + 2),
                found?.leads === true ? LEAD_CHECKS : 1
              )
            ].join("\n")
      )
    }
    last = fresh.at(-1)?.id ?? last
  }
})
