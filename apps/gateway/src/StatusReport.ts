/**
 * `ot-gateway status` and `ot-gateway events`: the running gateway's status page as text, through the same typed
 * client and schema the page uses. `status` is one line for the gateway and its broker, one per device with what to
 * check first when it fails, and exits with 1 when a device is failing or the broker is not connected; `events` is
 * what changed lately, one line each, and with `--follow` what changes from now on.
 * Times are local clock times on this machine; durations are the gateway's own.
 */
import {
  type DeviceStatus,
  type EventLog,
  type GatewayEvent,
  type GatewayStatus,
  isDeviceLate,
  OtGatewayApi,
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

/** What to check for a failing device, from the table the status page's device sheet shows. */
export const hintsFor = (device: DeviceStatus) => whatToCheck(device.protocol, device.reason ?? "", device.lastError)

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
  return `all ${devices.length} devices stopped answering within ${ago(spread)} of each other: likely a shared cause (power, a switch, the gateway's own network)`
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

/** The report: the gateway, its broker and buffer, then one aligned line per device, and a hint when failing. */
export const formatStatus = (status: GatewayStatus) => {
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
      ...(device.status === "failing" ? [`    ${" ".repeat(width)}  check: ${hintsFor(device).checks[0] ?? ""}`] : [])
    ]),
    ...(shared === undefined ? [] : [`  ${shared}`]),
    ...(isHealthy(status) ? [] : ["", ...failingHint])
  ].join("\n")
}

const advice =
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
      (error) => new GatewayUnreachable({ url, message: `no gateway status at ${url} (${error.message}). ${advice}` })
    ),
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () =>
        Effect.fail(new GatewayUnreachable({ url, message: `no gateway status at ${url} within 3 s. ${advice}` }))
    })
  )

/** The status from the gateway at `url`, within three seconds; `"none"` without each point's value. */
export const fetchGatewayStatus = (url: string, points: "all" | "none" = "all") =>
  askGateway(url, (client) => client.status.status({ query: { points } }))

/** The events the gateway at `url` keeps, within three seconds; with `after`, only those after that id. */
export const fetchGatewayEvents = (url: string, after?: number) =>
  askGateway(url, (client) => client.status.events({ query: after === undefined ? {} : { after } }))

/**
 * Prints the report for `status`, then fails with `GatewayUnhealthy` when something is failing, so the exit code
 * is 1. With `json`, the report is the status page's own `/api/status` answer with `ok` in front, values included.
 */
export const statusOutcome = (json: boolean) =>
  Effect.fnUntraced(function* (status: GatewayStatus) {
    yield* json ? printJson(statusJson(status)) : Console.log(formatStatus(status))
    const summary = unhealthySummary(status)
    if (summary !== undefined) return yield* new GatewayUnhealthy({ message: summary })
  })

/**
 * What `status --json` prints: `/api/status` with `ok` in front, and for each failing device `hints`, what it means
 * and what to check, most likely first (the status page's table).
 */
export const statusJson = (status: GatewayStatus) => ({
  ok: isHealthy(status),
  ...status,
  devices: status.devices.map((device) =>
    device.status === "failing" ? { ...device, hints: hintsFor(device) } : device
  )
})

/**
 * The status `ot-gateway status` reports on, from the gateway the target expects (else `GatewayMismatch`): the
 * lines need only the devices, `--json` gives everything.
 */
export const fetchStatusFor = (target: GatewayTarget, options: { readonly json?: boolean } = {}) =>
  Effect.tap(fetchGatewayStatus(target.url, options.json === true ? "all" : "none"), (status) =>
    checkIdentity(target, status)
  )

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
  }
}

/** What happened, after the subject: `failing: could not connect: …`, `ok again after 4 min`. */
const describeEvent = (event: GatewayEvent) => {
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
  }
}

/** The events of `log` at or after `sinceMs` before the gateway's `now`. */
export const eventsWithin = (log: EventLog, sinceMs: number) =>
  log.events.filter((event) => event.at >= log.now - sinceMs)

/** One line per event, oldest first: local time, subject, what happened. */
export const formatEvents = (log: EventLog, sinceMs: number, sinceText: string) => {
  const events = eventsWithin(log, sinceMs)
  const window = sinceMs === Number.POSITIVE_INFINITY ? "since the gateway started" : `in the last ${sinceText}`
  // The ring let older events go and the oldest kept is inside the window: some of the window is missing.
  const gap =
    log.dropped > 0 && events.length > 0 && events.length === log.events.length
      ? [`(the gateway keeps the latest ${log.capacity} events; ${log.dropped} older ones were let go)`]
      : []
  if (events.length === 0) return `no events ${window}`
  const width = Math.max(...events.map((event) => subjectOf(event).length))
  return [...gap, ...events.map((event) => eventLine(event, log.now, width))].join("\n")
}

/** One event's line: local time, subject, what happened; the subject padded to `width`. */
export const eventLine = (event: GatewayEvent, now: number, width = 0) =>
  `${localTime(event.at, now)}  ${subjectOf(event).padEnd(width)}  ${describeEvent(event)}`

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
  const events = eventsWithin(log, options.sinceMs)
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
    yield* printResult(formatEvents(log, options.sinceMs, options.since))
  }
  if (options.follow !== true) return
  const follow = followEvents((after) => fetchGatewayEvents(target.url, after), log.events.at(-1)?.id ?? 0, {
    json: options.json === true
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
  options: { readonly json: boolean }
) {
  const json = options.json
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
    for (const event of fresh) yield* printResult(json ? JSON.stringify(event) : eventLine(event, answer.now))
    last = fresh.at(-1)?.id ?? last
  }
})
