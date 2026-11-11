/**
 * `ot-gateway status` and `ot-gateway events`: the running gateway's status page as text, through the same typed
 * client and schema the page uses. `status` is one line for the gateway and its broker, one per device, and exits
 * with 1 when a device is failing or the broker is not connected; `events` is what changed lately, one line each.
 * Times are local clock times on this machine; durations are the gateway's own.
 */
import { type EventLog, type GatewayEvent, type GatewayStatus, OtGatewayApi } from "@ot-gateway/api"
import { Console, Effect, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { withoutControls } from "./Discover.ts"
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

/** Whether everything works: no device failing and the broker connected. A device still starting is fine. */
export const isHealthy = (status: GatewayStatus) =>
  status.broker.connected && status.devices.every((device) => device.status !== "failing")

/** What is wrong, in one line, for the exit code's message; undefined when nothing is. */
export const unhealthySummary = (status: GatewayStatus) => {
  const failing = status.devices.filter((device) => device.status === "failing").length
  const problems = [
    ...(failing > 0 ? [`${failing} of ${status.devices.length} device(s) failing`] : []),
    ...(status.broker.connected ? [] : ["broker not connected"])
  ]
  return problems.length === 0 ? undefined : problems.join(", ")
}

/** `failing since 12:18:20 (1 min): <why>`, or `read 3 s ago` for a device that works. */
const deviceState = (device: GatewayStatus["devices"][number], now: number) => {
  if (device.status === "failing") {
    const why = withoutControls(device.lastError ?? device.reason ?? "no reason given")
    return device.failingSince === undefined
      ? `failing: ${why}`
      : `failing since ${localTime(device.failingSince, now)} (${ago(now - device.failingSince)}): ${why}`
  }
  return device.lastSuccess === undefined ? "no read yet" : `read ${ago(now - device.lastSuccess)} ago`
}

/** `connected since 12:00:01, 3 failed connects`, or `NOT CONNECTED since 12:18:20 (1 min): <why>`. */
const brokerState = (broker: GatewayStatus["broker"], now: number) => {
  const failed = broker.failedConnects > 0 ? `, ${broker.failedConnects} failed connect(s) since start` : ""
  if (broker.connected) {
    return `${broker.connectedAt === undefined ? "connected" : `connected since ${localTime(broker.connectedAt, now)}`}${failed}`
  }
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
  return [
    `${status.site}/${status.building} gateway ${status.id}, up ${ago(status.now - status.since)} (since ${localTime(status.since, status.now)})`,
    `  broker ${status.broker.url}: ${brokerState(status.broker, status.now)}`,
    ...(status.buffer === undefined
      ? []
      : [
          `  buffer: ${status.buffer.rows} of ${status.buffer.maxRows} message(s) waiting` +
            (status.buffer.dropped > 0 ? `, ${status.buffer.dropped} DROPPED since start` : "")
        ]),
    `  ${status.devices.length} device(s)${failing > 0 ? `, ${failing} failing` : ""}`,
    ...status.devices.map(
      (device) =>
        `    ${device.id.padEnd(width)}  ${device.status.padEnd(8)} ${device.protocol}, ${device.pointCount} point(s), ${deviceState(device, status.now)}`
    ),
    ...(isHealthy(status) ? [] : ["", ...failingHint])
  ].join("\n")
}

const advice =
  "Is the gateway running (ot-gateway run, or ot-gateway demo)? If its status page is elsewhere, pass --url."

const gatewayClient = (url: string) => HttpApiClient.make(OtGatewayApi, { baseUrl: url })

/** A call to the gateway at `url` through the page's typed client, within three seconds. */
const askGateway = <A, E extends { readonly message: string }>(
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

/** The events the gateway at `url` keeps, within three seconds. */
export const fetchGatewayEvents = (url: string) => askGateway(url, (client) => client.status.events({ query: {} }))

/**
 * Prints the report for `status`, then fails with `GatewayUnhealthy` when something is failing, so the exit code
 * is 1. With `json`, the report is the status page's own `/api/status` answer with `ok` in front, values included.
 */
export const statusOutcome = (json: boolean) =>
  Effect.fnUntraced(function* (status: GatewayStatus) {
    yield* json ? printJson({ ok: isHealthy(status), ...status }) : Console.log(formatStatus(status))
    const summary = unhealthySummary(status)
    if (summary !== undefined) return yield* new GatewayUnhealthy({ message: summary })
  })

/** The status `ot-gateway status` reports on: the lines need only the devices, `--json` gives everything. */
export const fetchStatusFor = (url: string, options: { readonly json?: boolean } = {}) =>
  fetchGatewayStatus(url, options.json === true ? "all" : "none")

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
          : [`${event.buffered} message(s) waiting in the buffer`])
      ].join(", ")
    case "buffer-drained":
      return "drained: every waiting message delivered"
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
  return [
    ...gap,
    ...events.map(
      (event) => `${localTime(event.at, log.now)}  ${subjectOf(event).padEnd(width)}  ${describeEvent(event)}`
    )
  ].join("\n")
}

/** Prints the gateway's events of the last `since` (`10m`, `all`), oldest first. */
export const eventsReport = Effect.fn("eventsReport")(function* (
  url: string,
  options: { readonly since: string; readonly sinceMs: number; readonly json?: boolean }
) {
  const log = yield* fetchGatewayEvents(url)
  if (options.json === true) {
    const events = eventsWithin(log, options.sinceMs)
    return yield* printJson({ ok: true, now: log.now, capacity: log.capacity, dropped: log.dropped, events })
  }
  yield* printResult(formatEvents(log, options.sinceMs, options.since))
})
