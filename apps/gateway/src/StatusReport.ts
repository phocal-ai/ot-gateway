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
  type DeviceStatus,
  type EventLog,
  type GatewayEvent,
  type GatewayStatus,
  type Hint,
  isDeviceLate,
  OtGatewayApi,
  type Protocol,
  whatToCheck
} from "@ot-gateway/api"
import { Console, type Duration, Effect, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { withoutControls } from "./Discover.ts"
import { checkIdentity, gatewayName, type GatewayTarget } from "./GatewayTarget.ts"
import { localTime, printJson, printResult } from "./Output.ts"

export class GatewayUnreachable extends Schema.TaggedError<GatewayUnreachable>()("GatewayUnreachable", {
  url: Schema.String,
  message: Schema.String
}) {}

/** The gateway answered, and something is failing: printed already, this makes the exit code 1. */
export class GatewayUnhealthy extends Schema.TaggedError<GatewayUnhealthy>()("GatewayUnhealthy", {
  message: Schema.String
}) {}

/** `12 s`, `4 min`, `3 h`, `2 d`: how long ago, as coarse as a glance needs. */
export const ago = (milliseconds: number) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 120) return `${seconds} s`
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`
  return `${Math.round(seconds / 86_400)} d`
}

/** Where to look next when something is failing: the gateway's own timeline, then its log. */
export const failingHint = [
  "  What changed and when: ot-gateway events",
  "  The gateway's log (in its folder): docker compose logs gateway --since 10m"
]

/** The broker is away and it is not just the start: the connection was lost, or a dial failed or was refused. */
export const brokerAway = (broker: GatewayStatus["broker"]) =>
  !broker.connected && (broker.disconnectedSince !== undefined || broker.failedConnects > 0 || broker.connects > 0)

/**
 * What to check for a failing device, from the table the status page's device sheet shows: a device that read
 * fine in this run (`lastSuccess`), or one of several that failed together (`shared`), leads with power, switch,
 * cable and restart rather than its config.
 */
export const hintsFor = (device: DeviceStatus, shared = false) =>
  whatToCheck(device.protocol, device.reason ?? "", device.lastError, {
    answeredBefore: device.lastSuccess !== undefined,
    sharedCause: shared
  })

/** Failing devices that all started failing within this much of each other point at one cause, not at each device. */
export const SHARED_CAUSE_WINDOW_MS = 10_000

/**
 * `all 3 devices stopped answering within 6 s of each other: …` when every device of two or more fails and their
 * failures began within `SHARED_CAUSE_WINDOW_MS`; undefined otherwise.
 */
export const sharedCause = (devices: ReadonlyArray<DeviceStatus>) => {
  if (devices.length < 2) return undefined
  const starts: Array<number> = []
  for (const device of devices) {
    if (device.status !== "failing" || device.failingSince === undefined) return undefined
    starts.push(device.failingSince)
  }
  const spread = Math.max(...starts) - Math.min(...starts)
  if (spread > SHARED_CAUSE_WINDOW_MS) return undefined
  return sharedCauseLine(`all ${devices.length} devices`, spread)
}

/** `<who> stopped answering within 6 s of each other: likely a shared cause (…)`. */
const sharedCauseLine = (who: string, spreadMs: number) =>
  `${who} stopped answering within ${ago(spreadMs)} of each other: likely a shared cause (power, a switch, the gateway's own network)`

/** What `events` adds to an event: what to check for a device that failed, and whether others failed with it. */
export interface EventAdvice {
  readonly hint?: Hint
  /** The shared-cause line, on every device failure of a group that began within `SHARED_CAUSE_WINDOW_MS`. */
  readonly sharedCause?: string
}

/**
 * Advice per event id: for each `device-failing`, the hint table's advice (by the device's protocol from
 * `protocolOf`, any protocol's rules when the device is no longer in the config), and when two or more devices
 * started failing within `SHARED_CAUSE_WINDOW_MS` of the first of them, the shared-cause line on each of them.
 */
export const adviseEvents = (
  events: ReadonlyArray<GatewayEvent>,
  protocolOf: (device: string) => Protocol | undefined
): ReadonlyMap<number, EventAdvice> => {
  const advice = new Map<number, { hint?: Hint; sharedCause?: string }>()
  const failures = events.filter((event) => event.type === "device-failing")
  let index = 0
  while (index < failures.length) {
    const first = failures[index]
    if (first === undefined) break
    let end = index + 1
    while (
      end < failures.length &&
      (failures[end]?.at ?? Number.POSITIVE_INFINITY) - first.at <= SHARED_CAUSE_WINDOW_MS
    ) {
      end++
    }
    const group = failures.slice(index, end)
    const devices = [...new Set(group.map((event) => event.device))]
    if (devices.length >= 2) {
      const spread = (group.at(-1)?.at ?? first.at) - first.at
      const line = sharedCauseLine(`${devices.length} devices (${devices.join(", ")})`, spread)
      for (const event of group) advice.set(event.id, { sharedCause: line })
    }
    index = end
  }
  // The hint knows whether the device worked before and whether others failed with it: then not its config first.
  for (const event of failures) {
    const shared = advice.get(event.id)?.sharedCause
    const hint = whatToCheck(protocolOf(event.device), event.reason, event.error, {
      answeredBefore: event.answeredBefore === true,
      sharedCause: shared !== undefined
    })
    advice.set(event.id, { hint, ...(shared === undefined ? {} : { sharedCause: shared }) })
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
}

/** What `status` says about the last 15 minutes, read from the events ring. */
export const RECENT_WINDOW_MS = 15 * 60_000

/** The incidents of `log` in the `windowMs` before its `now`. */
export const recentIncidents = (log: EventLog, windowMs: number = RECENT_WINDOW_MS): RecentIncidents => {
  const within = log.events.filter((event) => event.at >= log.now - windowMs)
  const failures = within.filter((event) => event.type === "device-failing")
  const first = failures[0]
  const last = failures.at(-1)
  return {
    windowMs,
    failedDevices: [...new Set(failures.map((event) => event.device))],
    ...(first === undefined || last === undefined ? {} : { from: first.at, to: last.at }),
    brokerOutages: within.filter((event) => event.type === "broker-disconnected").length
  }
}

/** `14:03:10`, or `14:03:10–14:05:02` for a span. */
const span = (from: number, to: number, now: number) =>
  from === to ? localTime(from, now) : `${localTime(from, now)}–${localTime(to, now)}`

/**
 * The lines about the last 15 minutes: devices that failed, the broker lost, so a gateway that is fine again does
 * not read as one that always was. Empty when nothing happened.
 */
const recentLines = (recent: RecentIncidents, now: number) => {
  const minutes = `${Math.round(recent.windowMs / 60_000)} min`
  const devices =
    recent.failedDevices.length === 0 || recent.from === undefined || recent.to === undefined
      ? []
      : [
          `  ${recent.failedDevices.length} device(s) failed in the last ${minutes} (${span(recent.from, recent.to, now)}: ${recent.failedDevices.join(", ")}), see ot-gateway events`
        ]
  const broker =
    recent.brokerOutages === 0
      ? []
      : [`  broker connection lost ${recent.brokerOutages} time(s) in the last ${minutes}, see ot-gateway events`]
  return [...devices, ...broker]
}

/** `on 30 s, off 30 s, 6 times in 6 min`: how a flapping alarm switched. */
export const patternText = (pattern: AlarmPattern) =>
  [
    ...(pattern.onMs === undefined ? [] : [`on ${ago(pattern.onMs)}`]),
    ...(pattern.offMs === undefined ? [] : [`off ${ago(pattern.offMs)}`]),
    `${pattern.raised} time(s) in ${ago(pattern.overMs)}`
  ].join(", ")

/**
 * The alarm lines: how many alarm points there are and how many are active, then one line for each that is active
 * or was raised in the last 15 minutes. Nothing for a config without alarm points.
 */
const alarmLines = (alarms: ReadonlyArray<AlarmStatus>, now: number) => {
  if (alarms.length === 0) return []
  const active = alarms.filter((alarm) => alarm.active === true)
  const noteworthy = alarms.filter((alarm) => alarm.active === true || alarm.raised > 0)
  const width = Math.max(0, ...noteworthy.map((alarm) => `${alarm.device}/${alarm.point}`.length))
  const minutes = `${Math.round(ALARM_WINDOW_MS / 60_000)} min`
  return [
    `  ${alarms.length} alarm point(s), ${active.length === 0 ? "none" : active.length} active`,
    ...noteworthy.map((alarm) => {
      const state =
        alarm.active === true
          ? `ACTIVE${alarm.since === undefined ? "" : ` since ${localTime(alarm.since, now)} (${ago(now - alarm.since)})`}`
          : `off${alarm.since === undefined ? "" : ` since ${localTime(alarm.since, now)}`}`
      const raised =
        alarm.raised === 0
          ? ""
          : `, raised ${alarm.raised} time(s) in the last ${minutes}${alarm.flapping ? ` (flapping${alarm.pattern === undefined ? "" : `, ${patternText(alarm.pattern)}`}: its changes are counted, not listed, until it keeps still for ${ago(ALARM_SETTLE_MS)})` : ""}`
      return `    ${`${alarm.device}/${alarm.point}`.padEnd(width)}  ${state}${raised}`
    })
  ]
}

/** A device's state as `status` shows it: the gateway's, or `late` for an `ok` device not read lately. */
const deviceStateName = (device: GatewayStatus["devices"][number], now: number) =>
  isDeviceLate(device, now) ? "late" : device.status

/** What is wrong, in one line, for the exit code's message; undefined when nothing is. */
export const unhealthySummary = (status: GatewayStatus) => {
  const count = (state: string) =>
    status.devices.filter((device) => deviceStateName(device, status.now) === state).length
  const failing = count("failing")
  const late = count("late")
  const problems = [
    ...(failing > 0 ? [`${failing} of ${status.devices.length} device(s) failing`] : []),
    ...(late > 0 ? [`${late} of ${status.devices.length} device(s) late`] : []),
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
 * `connected since 12:00:01, 3 failed connects`, `NOT CONNECTED since 12:18:20 (1 min): <why>`, or
 * `connecting (started 2 s ago)` while the first connect is under way.
 */
const brokerState = (broker: GatewayStatus["broker"], now: number, started: number) => {
  const failed = broker.failedConnects > 0 ? `, ${broker.failedConnects} failed connect(s) since start` : ""
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
 * the alarms, and with `recent` what failed in the last 15 minutes.
 */
export const formatStatus = (status: GatewayStatus, recent?: RecentIncidents) => {
  const width = Math.max(0, ...status.devices.map((device) => device.id.length))
  const failing = status.devices.filter((device) => device.status === "failing").length
  const late = status.devices.filter((device) => isDeviceLate(device, status.now)).length
  const shared = sharedCause(status.devices)
  return [
    `${status.site}/${status.building} gateway ${status.id}, up ${ago(status.now - status.since)} (since ${localTime(status.since, status.now)})`,
    `  broker ${status.broker.url}: ${brokerState(status.broker, status.now, status.since)}`,
    ...(status.buffer === undefined
      ? []
      : [
          `  buffer: ${status.buffer.rows} of ${status.buffer.maxRows} message(s) waiting` +
            (status.buffer.dropped > 0 ? `, ${status.buffer.dropped} DROPPED since start` : "")
        ]),
    `  ${status.devices.length} device(s)${failing > 0 ? `, ${failing} failing` : ""}${late > 0 ? `, ${late} late` : ""}`,
    ...status.devices.flatMap((device) => [
      `    ${device.id.padEnd(width)}  ${deviceStateName(device, status.now).padEnd(8)} ${device.protocol}, ${device.pointCount} point(s), ${deviceState(device, status.now)}`,
      ...(device.status === "failing"
        ? [`    ${" ".repeat(width)}  check: ${hintsFor(device, shared !== undefined).checks[0] ?? ""}`]
        : [])
    ]),
    ...(shared === undefined ? [] : [`  ${shared}`]),
    ...alarmLines(status.alarms ?? [], status.now),
    ...(recent === undefined ? [] : recentLines(recent, status.now)),
    ...(isHealthy(status) ? [] : ["", ...failingHint])
  ].join("\n")
}

const unreachableAdvice =
  "Is the gateway running (ot-gateway run, or ot-gateway demo), with a status block in its config? Name its config, or pass --url for a page elsewhere."

const gatewayClient = (url: string) => HttpApiClient.make(OtGatewayApi, { baseUrl: url })

/** A call to the gateway at `url` through the page's typed client, within three seconds. */
export const askGateway = <A, E extends { readonly message: string }>(
  url: string,
  ask: (client: Effect.Success<ReturnType<typeof gatewayClient>>) => Effect.Effect<A, E>
) =>
  gatewayClient(url).pipe(
    Effect.flatMap(ask),
    Effect.provide(FetchHttpClient.layer),
    // Unreachable, a timeout or an answer that does not decode: the same advice for each.
    Effect.mapError(
      (error) =>
        new GatewayUnreachable({ url, message: `no gateway status at ${url} (${error.message}). ${unreachableAdvice}` })
    ),
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () =>
        Effect.fail(
          new GatewayUnreachable({ url, message: `no gateway status at ${url} within 3 s. ${unreachableAdvice}` })
        )
    })
  )

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
export const statusOutcome = (json: boolean, options: { readonly failOnAlarm?: boolean } = {}) =>
  Effect.fnUntraced(function* (status: GatewayStatus, recent?: RecentIncidents) {
    yield* json ? printJson(statusJson(status, recent)) : Console.log(formatStatus(status, recent))
    const summary = unhealthySummary(status)
    if (summary !== undefined) return yield* new GatewayUnhealthy({ message: summary })
    const active = activeAlarms(status)
    if (options.failOnAlarm === true && active > 0) {
      const which = (status.alarms ?? [])
        .filter((alarm) => alarm.active === true)
        .map((alarm) => `${alarm.device}/${alarm.point}`)
      return yield* new AlarmActive({ message: `${active} alarm(s) active: ${which.join(", ")}` })
    }
  })

/**
 * What `status --json` prints: `/api/status` with `ok` and `alarmsActive` (how many alarm points are active now,
 * which `ok` leaves out) in front, for each failing device `hints`, what it means
 * and what to check, most likely first (the status page's table), and `recent`, what failed in the last 15 minutes
 * (from the events), so `ok: true` right after an outage does not hide it.
 */
export const statusJson = (status: GatewayStatus, recent?: RecentIncidents) => {
  const shared = sharedCause(status.devices) !== undefined
  return {
    ok: isHealthy(status),
    alarmsActive: activeAlarms(status),
    ...status,
    devices: status.devices.map((device) =>
      device.status === "failing" ? { ...device, hints: hintsFor(device, shared) } : device
    ),
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
const subjectOf = (event: GatewayEvent) => {
  switch (event.type) {
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

/** What happened, after the subject: `failing: could not connect: …`, `ok again after 4 min`. */
const describeEvent = (event: GatewayEvent, now: number) => {
  switch (event.type) {
    case "gateway-started":
      return `started (${event.version}, ${event.devices} device(s))`
    case "device-failing":
      return `failing: ${withoutControls(event.error === "" ? event.reason : event.error)}`
    case "device-recovered":
      return `ok again after ${ago(event.downMs)}`
    case "broker-disconnected":
      return `disconnected: ${withoutControls(event.error)}`
    case "broker-connected":
      return [
        event.downMs === undefined ? "connected" : `connected again after ${ago(event.downMs)}`,
        ...(event.buffered === undefined || event.buffered === 0
          ? []
          : [`${event.buffered} message(s) waiting in the buffer at reconnect`])
      ].join(", ")
    case "buffer-drained":
      return event.delivered === undefined
        ? "drained: every waiting message delivered"
        : `drained: ${event.delivered} message(s) delivered from the buffer since it was last empty`
    case "config-applied":
      return `applied from the status page: ${withoutControls(event.summary)}`
    case "config-apply-failed":
      return `not applied, the previous config runs again: ${withoutControls(event.error)}`
    case "gateway-conflict":
      return event.sameId
        ? "another gateway with this gateway's id is online: both publish into the same topics"
        : `another gateway is online with the same device ids (${event.devices.join(", ")}): both publish into the same topics`
    case "alarm-raised":
      return event.first === true
        ? `alarm active at its first read (value ${valueText(event.value)})`
        : `alarm raised (value ${valueText(event.value)})`
    case "alarm-cleared":
      return `alarm cleared after ${ago(event.activeMs)} (value ${valueText(event.value)})`
    case "alarm-flapping":
      return `alarm raised ${event.raised} times in the last ${ago(ALARM_WINDOW_MS)}: flapping${event.pattern === undefined ? "" : ` (${patternText(event.pattern)})`}, so its changes are counted, not listed, until it keeps still for ${ago(ALARM_SETTLE_MS)}`
    case "alarm-settled":
      return `alarm keeps still, ${event.active ? "ACTIVE" : "off"} since ${localTime(event.since, now)}; ${event.unlisted} change(s) were counted, not listed${event.pattern === undefined ? "" : ` (it flapped ${patternText(event.pattern)})`}`
  }
}

/** The events of `log` at or after `sinceMs` before the gateway's `now`. */
export const eventsWithin = (log: EventLog, sinceMs: number) =>
  log.events.filter((event) => event.at >= log.now - sinceMs)

/** The protocol of each device of a status, for the hints of `events`. */
export const protocolsOf = (status: Pick<GatewayStatus, "devices">) => {
  const protocols = new Map(status.devices.map((device) => [device.id, device.protocol]))
  return (device: string) => protocols.get(device)
}

/**
 * One line per event, oldest first: local time, subject, what happened. Under a device's failure, the first thing
 * to check (the status page's hint table); after the last of several devices that failed within 10 s of each
 * other, that they likely share a cause.
 */
export const formatEvents = (
  log: EventLog,
  sinceMs: number,
  sinceText: string,
  protocolOf: (device: string) => Protocol | undefined = () => undefined
) => {
  const events = eventsWithin(log, sinceMs)
  const window = sinceMs === Number.POSITIVE_INFINITY ? "since the gateway started" : `in the last ${sinceText}`
  // The ring let older events go and the oldest kept is inside the window: some of the window is missing.
  const gap =
    log.dropped > 0 && events.length > 0 && events.length === log.events.length
      ? [`(the gateway keeps the latest ${log.capacity} events; ${log.dropped} older ones were let go)`]
      : []
  if (events.length === 0) return `no events ${window}`
  const width = Math.max(...events.map((event) => subjectOf(event).length))
  const advice = adviseEvents(log.events, protocolOf)
  // The shared-cause line goes once, after the last failure of its group that is shown.
  const sharedShown = new Set<string>()
  const sharedAfter = new Set<number>()
  for (const event of events.toReversed()) {
    const shared = advice.get(event.id)?.sharedCause
    if (shared === undefined || sharedShown.has(shared)) continue
    sharedShown.add(shared)
    sharedAfter.add(event.id)
  }
  return [
    ...gap,
    ...events.flatMap((event) => {
      const line = eventLine(event, log.now, width)
      const indent = " ".repeat(localTime(event.at, log.now).length + 2 + width + 2)
      const found = advice.get(event.id)
      return [
        line,
        ...adviceLines(found?.hint, indent),
        ...(found?.sharedCause !== undefined && sharedAfter.has(event.id) ? [`${indent}${found.sharedCause}`] : [])
      ]
    })
  ].join("\n")
}

/** `check: <the most likely cause>` under a device's failure. */
const adviceLines = (hint: Hint | undefined, indent: string) => {
  const first = hint?.checks[0]
  return first === undefined ? [] : [`${indent}check: ${first}`]
}

/** One event's line: local time, subject, what happened; the subject padded to `width`. */
export const eventLine = (event: GatewayEvent, now: number, width = 0) =>
  `${localTime(event.at, now)}  ${subjectOf(event).padEnd(width)}  ${describeEvent(event, now)}`

/**
 * An event as `events --json` gives it: as the gateway keeps it, with `hint` (what it means, what to check) for a
 * device that failed and `sharedCause` when others failed with it.
 */
export const eventJson = (event: GatewayEvent, advice: ReadonlyMap<number, EventAdvice>) => {
  const found = advice.get(event.id)
  return {
    ...event,
    ...(found?.hint === undefined ? {} : { hint: found.hint }),
    ...(found?.sharedCause === undefined ? {} : { sharedCause: found.sharedCause })
  }
}

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
  const log = yield* fetchGatewayEvents(target.url)
  const gateway = { site: status.site, building: status.building, id: status.id }
  const protocolOf = protocolsOf(status)
  const advice = adviseEvents(log.events, protocolOf)
  const events = eventsWithin(log, options.sinceMs).map((event) => eventJson(event, advice))
  if (options.json === true && options.follow !== true) {
    return yield* printJson({ ok: true, gateway, now: log.now, capacity: log.capacity, dropped: log.dropped, events })
  }
  if (options.json === true) {
    for (const event of events) yield* printResult(JSON.stringify(event))
  } else {
    const window =
      options.follow === true
        ? options.seconds === undefined
          ? "then what comes (Ctrl-C to stop)"
          : `then what comes for ${options.seconds} s`
        : ""
    yield* printResult(`${gatewayName(gateway)} at ${target.url}${window === "" ? "" : `, ${window}`}`)
    yield* printResult(formatEvents(log, options.sinceMs, options.since, protocolOf))
  }
  if (options.follow !== true) return
  const follow = followEvents((after) => fetchGatewayEvents(target.url, after), log.events.at(-1)?.id ?? 0, {
    json: options.json === true,
    protocolOf
  })
  if (options.seconds === undefined) return yield* follow
  yield* Effect.timeoutOrElse(follow, { duration: `${options.seconds} seconds`, orElse: () => Effect.void })
})

/**
 * Asks `fetchAfter` for the events after `lastId` every `FOLLOW_INTERVAL` and prints each new one, until
 * interrupted. A gateway that stops answering is said once (on stderr), and once more when it is back; one that
 * restarted counts its ids from 1 again, which the gateway answers with everything it keeps, and that is said too.
 */
export const followEvents = Effect.fn("followEvents")(function* (
  fetchAfter: (after: number) => Effect.Effect<EventLog, GatewayUnreachable>,
  lastId: number,
  options: { readonly json: boolean; readonly protocolOf?: (device: string) => Protocol | undefined }
) {
  const json = options.json
  const protocolOf = options.protocolOf ?? (() => undefined)
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
    const fresh = answer.events
    const first = fresh[0]
    if (first !== undefined && first.id <= last) {
      yield* Console.error("the gateway restarted: its events start over")
    }
    // Each new failure gets its hint; a shared cause needs the others of its group, which `events` shows afterwards.
    const hints = adviseEvents(fresh, protocolOf)
    for (const event of fresh) {
      const hint = hints.get(event.id)?.hint
      yield* printResult(
        json
          ? JSON.stringify(eventJson(event, new Map(hint === undefined ? [] : [[event.id, { hint }]])))
          : [
              eventLine(event, answer.now),
              ...adviceLines(hint, " ".repeat(localTime(event.at, answer.now).length + 2))
            ].join("\n")
      )
    }
    last = fresh.at(-1)?.id ?? last
  }
})
