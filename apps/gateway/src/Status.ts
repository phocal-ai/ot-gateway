/**
 * The local status page: `GET /api/status` (the `OtGatewayApi` contract from
 * `@ot-gateway/api`) and the built web app (`apps/web/out`), served by the
 * gateway itself on `status.bindAddress:status.port`. Commands reach devices
 * only through MQTT and the command guard; the one thing the page can change
 * is the config file (ConfigEditor.ts), and every write passes the edit guard.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import {
  type BrokerConnection,
  type CommandStatus,
  ConfigUnreadable,
  type ConfigView,
  EDIT_HEADER,
  type DeviceStatus,
  EditingDisabled,
  type EditStatus,
  type GatewayStatus,
  HistoryQueryInvalid,
  HistoryUnavailable,
  MAX_VALUES_PER_REQUEST,
  type Messages,
  OtGatewayApi,
  type PointCatalog,
  type PointReadings,
  ValuesQueryInvalid
} from "@ot-gateway/api"
import type { History } from "@ot-gateway/history"
import type { ConfigEditor } from "./ConfigEditor.ts"
import { configView } from "./ConfigView.ts"
import { isLoopbackAddress, isReadOnlyMethod, writeRefusal } from "./EditGuard.ts"
import { GatewayEvents } from "./Events.ts"
import type { HostSnapshot } from "./Host.ts"
import { pointCatalog } from "./PointCatalog.ts"
import {
  bufferDisabled,
  bufferDrained,
  bufferDropped,
  bufferDropReasons,
  bufferFailures,
  bufferRows,
  bufferWritten,
  type CommandOutcome,
  type GatewayConfig,
  type HealthRegistry,
  type HistorySink,
  mqttConnected,
  mqttConnects,
  publishFailures,
  type StatusSettings,
  valuesPublished
} from "@ot-gateway/core"
import { Clock, Effect, FileSystem, Layer, Metric, Option, Schema } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

/** Commands kept for the page, newest first. */
const RECENT_COMMANDS = 50

/** Topics whose latest message is kept for the page, and how much of each payload: bounded memory on a Pi. */
const MAX_TOPICS = 2_000
const MAX_PAYLOAD = 2_000
/**
 * The longest topic kept. The gateway's own topics are four slug levels of at
 * most 64 characters plus a suffix such as `/$set/result`, well under this; a
 * longer one is not the gateway's and is not kept.
 */
const MAX_TOPIC_LENGTH = 512

/** Connections the server holds at once: a page polls with one; more is someone else's problem, not the gateway's memory. */
const MAX_CONNECTIONS = 32

/** A value message as the pipeline publishes it; read back from what the gateway itself sent. */
const ValueMessage = Schema.fromJsonString(
  Schema.Struct({ value: Schema.Union([Schema.Number, Schema.Boolean]), ts: Schema.Number })
)
const decodeValue = Schema.decodeUnknownOption(ValueMessage)

/** The built web app, when the config does not name one: apps/web/out next to this app. */
export const defaultWebRoot = fileURLToPath(new URL("../../web/out", import.meta.url))

export interface StatusState {
  /**
   * Note a message the gateway is publishing: the latest per topic under the
   * site and building, for the messages view, and values
   * (`site/building/device/point`) for the devices. Called before the publish,
   * so the page shows what the devices read even while the broker is down.
   */
  readonly recordPublish: (
    topic: string,
    payload: string,
    message: { readonly retained: boolean; readonly at: number }
  ) => void
  /**
   * Every read, as the pipeline hands it to the history: the page shows a point's last read, which is never
   * older than what was published and is there before the first message of an aggregate or a change.
   */
  readonly reads: HistorySink
  /** Note a connect to the broker: when, and what the broker allowed. */
  readonly recordBrokerConnection: (at: number, connection: BrokerConnection) => void
  /** Note a lost connection or a failed dial: since when the broker is away (the first of an outage), and why. */
  readonly recordBrokerFailure: (at: number, error: string) => void
  readonly recordCommand: (
    at: number,
    command: { readonly device: string; readonly point: string },
    outcome: CommandOutcome
  ) => void
  /** The whole status; `"none"` leaves out every point (each device keeps its `pointCount`). */
  readonly snapshot: (points?: "all" | "none") => Effect.Effect<GatewayStatus>
  /** The last reads of the points named by comma-separated `device/point` keys, configured ones only. */
  readonly values: (keys: string) => Effect.Effect<PointReadings, ValuesQueryInvalid>
  readonly messages: Effect.Effect<Messages>
  /** Every configured point with its topic, source and publish mode: built once, the config does not change. */
  readonly points: Effect.Effect<PointCatalog>
  /** The running config without its points, for the Settings tab: built once. */
  readonly config: Effect.Effect<ConfigView>
}

/** Where the page's host section comes from: the host monitor's last sample, when there is a monitor. */
export interface StatusHost {
  readonly latest: () => HostSnapshot | undefined
  readonly version: string
}

export const makeStatusState = (
  config: GatewayConfig,
  health: HealthRegistry,
  since: number,
  host?: StatusHost
): StatusState => {
  const prefix = `${config.site}/${config.building}/`
  // The last payload per point, decoded only when someone asks for a snapshot: publishing stays cheap.
  const payloads = new Map<string, string>()
  // The last read per device/point: one entry per configured point, so bounded by the config.
  const reads = new Map<string, { readonly value: number | boolean; readonly ts: number }>()
  const latest = new Map<string, { payload: string; retained: boolean; at: number; count: number }>()
  const droppedTopics = new Set<string>()
  const commands: Array<CommandStatus> = []
  let broker: { readonly at: number; readonly connection: BrokerConnection } | undefined
  let brokerDown: { readonly since: number; readonly error: string } | undefined
  const catalog = pointCatalog(config)
  const settings = configView(config)
  const configured = new Set(catalog.points.map((point) => `${point.device}/${point.id}`))
  /** A point's last read: the read itself, or the value it last published (a pushed or aggregated one). */
  const lastRead = (key: string) => {
    const payload = payloads.get(key)
    return reads.get(key) ?? Option.getOrUndefined(payload === undefined ? Option.none() : decodeValue(payload))
  }
  const attributes = { site: config.site, building: config.building }
  return {
    recordPublish: (topic, payload, message) => {
      if (!topic.startsWith(prefix) || topic.length > MAX_TOPIC_LENGTH) return
      // An empty retained message clears the topic at the broker (StaleMeta.ts): the page forgets it too.
      if (message.retained && payload === "") {
        latest.delete(topic)
        return
      }
      const previous = latest.get(topic)
      if (previous !== undefined || latest.size < MAX_TOPICS) {
        latest.set(topic, { payload, retained: message.retained, at: message.at, count: (previous?.count ?? 0) + 1 })
      } else if (droppedTopics.size < MAX_TOPICS) droppedTopics.add(topic)
      const rest = topic.slice(prefix.length)
      const slash = rest.indexOf("/")
      if (slash <= 0 || rest.indexOf("/", slash + 1) !== -1) return
      payloads.set(rest, payload)
    },
    reads: {
      record: (device, point, value, ts) => {
        reads.set(`${device}/${point}`, { value, ts })
      }
    },
    recordBrokerFailure: (at, error) => {
      // Before the first connect the gateway has been without a broker since it started.
      brokerDown = { since: brokerDown?.since ?? (broker === undefined ? since : at), error }
    },
    recordBrokerConnection: (at, connection) => {
      broker = { at, connection }
      brokerDown = undefined
    },
    recordCommand: (at, command, outcome) => {
      commands.unshift({
        at,
        device: command.device,
        point: command.point,
        status: outcome.status,
        ...(outcome.status === "written" ? {} : { reason: outcome.reason })
      })
      if (commands.length > RECENT_COMMANDS) commands.length = RECENT_COMMANDS
    },
    snapshot: (points = "all") =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const connected = (yield* Metric.value(Metric.withAttributes(mqttConnected, attributes))).value === 1
        const rows = (yield* Metric.value(Metric.withAttributes(bufferRows, attributes))).value
        const disabled = (yield* Metric.value(Metric.withAttributes(bufferDisabled, attributes))).value === 1
        // Counters summed over their other attributes (device, outcome, reason, ...): one pass over the registry.
        const total = totals(yield* Metric.snapshot, attributes)
        const droppedBy = Object.fromEntries(
          bufferDropReasons.map((reason) => [reason, total(bufferDropped.id, { reason })])
        )
        const dropped = Object.values(droppedBy).reduce((sum, count) => sum + count, 0)
        const devices = config.devices.map((device): DeviceStatus => {
          const state = health.devices.get(device.id) ?? { status: "starting" as const }
          return {
            id: device.id,
            protocol: device.protocol,
            status: state.status,
            pollIntervalMs: device.pollIntervalMs,
            ...(state.reason === undefined ? {} : { reason: state.reason }),
            ...(state.failingSince === undefined ? {} : { failingSince: state.failingSince }),
            ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
            ...(state.failures === undefined ? {} : { failures: state.failures }),
            ...(state.lastSuccess === undefined ? {} : { lastSuccess: state.lastSuccess }),
            pointCount: device.points.length,
            points:
              points === "none"
                ? []
                : device.points.map((point) => {
                    const last = lastRead(`${device.id}/${point.id}`)
                    return {
                      id: point.id,
                      name: point.name,
                      writable: point.writable,
                      ...(point.unit === undefined ? {} : { unit: point.unit }),
                      ...(last === undefined ? {} : { value: last.value, ts: last.ts })
                    }
                  })
          }
        })
        const sample = host?.latest()
        return {
          site: config.site,
          building: config.building,
          id: config.id,
          since,
          now,
          broker: {
            url: config.mqtt.url,
            connected,
            ...(broker === undefined ? {} : { connectedAt: broker.at, connection: broker.connection }),
            ...(connected || brokerDown === undefined
              ? {}
              : { disconnectedSince: brokerDown.since, lastError: brokerDown.error }),
            connects: total(mqttConnects.id, { outcome: "ok" }),
            failedConnects:
              total(mqttConnects.id, { outcome: "failed" }) + total(mqttConnects.id, { outcome: "rejected" }),
            published: total(valuesPublished.id),
            publishFailures: total(publishFailures.id)
          },
          ...(config.buffer === undefined
            ? {}
            : {
                buffer: {
                  path: config.buffer.path,
                  rows: Math.max(0, rows),
                  maxRows: config.buffer.maxRows,
                  dropped,
                  written: total(bufferWritten.id),
                  delivered: total(bufferDrained.id),
                  droppedBy,
                  failures: total(bufferFailures.id),
                  disabled
                }
              }),
          ...(host === undefined || sample === undefined
            ? {}
            : { host: { version: host.version, node: process.versions.node, ...sample } }),
          devices,
          commands: [...commands]
        }
      }),
    values: (keys) =>
      Effect.gen(function* () {
        const asked = keys.split(",").filter((key) => key !== "")
        if (asked.length > MAX_VALUES_PER_REQUEST) {
          return yield* new ValuesQueryInvalid({
            message: `${asked.length} points asked for, at most ${MAX_VALUES_PER_REQUEST} per request`
          })
        }
        const readings = asked.flatMap((key) => {
          if (!configured.has(key)) return []
          const slash = key.indexOf("/")
          const last = lastRead(key)
          return [
            {
              device: key.slice(0, slash),
              point: key.slice(slash + 1),
              ...(last === undefined ? {} : { value: last.value, ts: last.ts })
            }
          ]
        })
        return { readings }
      }),
    messages: Effect.sync(() => ({
      messages: [...latest.entries()]
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([topic, message]) => ({
          topic,
          payload: message.payload.slice(0, MAX_PAYLOAD),
          truncated: message.payload.length > MAX_PAYLOAD,
          retained: message.retained,
          at: message.at,
          count: message.count
        })),
      droppedTopics: droppedTopics.size
    })),
    points: Effect.succeed(catalog),
    config: Effect.succeed(settings)
  }
}

/**
 * The status the server answers with, switched to a new config's state when one is applied from the page: the
 * server keeps running, and every request reads the state of the config running now. Only the server reads
 * through it; each config writes to its own state.
 */
export const switchableStatus = (initial: StatusState) => {
  let current = initial
  const state: StatusState = {
    recordPublish: (topic, payload, message) => current.recordPublish(topic, payload, message),
    reads: { record: (device, point, value, ts) => current.reads.record(device, point, value, ts) },
    recordBrokerConnection: (at, connection) => current.recordBrokerConnection(at, connection),
    recordBrokerFailure: (at, error) => current.recordBrokerFailure(at, error),
    recordCommand: (at, command, outcome) => current.recordCommand(at, command, outcome),
    snapshot: (points) => Effect.suspend(() => current.snapshot(points)),
    values: (keys) => Effect.suspend(() => current.values(keys)),
    messages: Effect.suspend(() => current.messages),
    points: Effect.suspend(() => current.points),
    config: Effect.suspend(() => current.config)
  }
  return {
    state,
    switchTo: (next: StatusState) => {
      current = next
    }
  }
}

/**
 * A sum over a registry snapshot: every counter series with this id whose attributes include `scope` (this
 * gateway's site and building) and `match`, whatever else they carry (a device, an outcome).
 */
const totals =
  (snapshots: ReadonlyArray<Metric.Metric.Snapshot>, scope: Readonly<Record<string, string>>) =>
  (id: string, match: Readonly<Record<string, string>> = {}) => {
    const wanted = Object.entries({ ...scope, ...match })
    let sum = 0
    for (const snapshot of snapshots) {
      if (snapshot.id !== id || snapshot.type !== "Counter") continue
      const attributes = snapshot.attributes ?? {}
      if (wanted.every(([key, value]) => attributes[key] === value)) sum += Number(snapshot.state.count)
    }
    return sum
  }

/** The range a history request asks for when it names none: the last hour. */
const DEFAULT_HISTORY_MS = 3_600_000

export interface HistoryRequest {
  readonly device: string
  readonly point: string
  readonly from?: number | undefined
  readonly to?: number | undefined
  readonly buckets?: number | undefined
}

/** `/api/history`: a configured point's history, the last hour unless the request names a range. */
export const historyHandler =
  (running: GatewayConfig | (() => GatewayConfig), history: History | undefined) =>
  (request: HistoryRequest): Effect.Effect<HistorySeriesOf, HistoryUnavailable | HistoryQueryInvalid> =>
    Effect.gen(function* () {
      if (history === undefined) {
        return yield* new HistoryUnavailable({ message: "the config has no history block, so no reads are kept" })
      }
      // The config running now: a config applied from the page may have added or removed the point.
      const config = typeof running === "function" ? running() : running
      const device = config.devices.find((candidate) => candidate.id === request.device)
      if (device === undefined || !device.points.some((point) => point.id === request.point)) {
        return yield* new HistoryQueryInvalid({ message: `no point ${request.device}/${request.point} in the config` })
      }
      const now = yield* Clock.currentTimeMillis
      const to = request.to ?? now
      const from = request.from ?? to - DEFAULT_HISTORY_MS
      if (!(from < to)) return yield* new HistoryQueryInvalid({ message: "from must be before to" })
      return yield* history.series({
        device: request.device,
        point: request.point,
        from,
        to,
        ...(request.buckets === undefined ? {} : { buckets: request.buckets })
      })
    })
type HistorySeriesOf = Effect.Success<ReturnType<History["series"]>>

/**
 * Serve the API and, when it is built, the web app, until the scope closes.
 * A port that is taken is logged and the gateway runs on without its page:
 * the page must never cost the readings.
 */
export const serveStatus = (
  settings: StatusSettings,
  state: StatusState,
  history: (request: HistoryRequest) => Effect.Effect<HistorySeriesOf, HistoryUnavailable | HistoryQueryInvalid> = () =>
    Effect.fail(new HistoryUnavailable({ message: "this server keeps no history" })),
  editor?: ConfigEditor
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const events = yield* GatewayEvents
    const webRoot = settings.webRoot ?? defaultWebRoot
    const hasWeb = yield* fs.exists(`${webRoot}/index.html`).pipe(Effect.orElseSucceed(() => false))
    const api = HttpApiBuilder.layer(OtGatewayApi).pipe(
      Layer.provide(
        HttpApiBuilder.group(OtGatewayApi, "status", (handlers) =>
          handlers
            .handle("status", ({ query }) => state.snapshot(query.points))
            .handle("values", ({ query }) => state.values(query.points))
            .handle("events", ({ query }) => events.log(query))
            .handle("messages", () => state.messages)
            .handle("points", () => state.points)
            .handle("config", () => state.config)
            .handle("history", ({ query }) => history(query))
        )
      ),
      Layer.provide(
        HttpApiBuilder.group(OtGatewayApi, "editor", (handlers) =>
          editor === undefined
            ? handlers
                .handle("editStatus", () => Effect.succeed(noEditorStatus))
                .handle("file", () => Effect.fail(new ConfigUnreadable({ message: noEditor.reason })))
                .handle("check", () => Effect.fail(new EditingDisabled({ message: noEditor.reason })))
                .handle("save", () => Effect.fail(new EditingDisabled({ message: noEditor.reason })))
            : handlers
                .handle("editStatus", () => editor.status)
                .handle("file", () => editor.file)
                .handle("check", ({ payload }) => editor.check(payload.text))
                .handle("save", ({ payload }) => editor.save(payload.text, payload.etag))
        )
      )
    )
    const web = hasWeb
      ? HttpStaticServer.layer({ root: webRoot, spa: true })
      : HttpRouter.add(
          "GET",
          "/",
          HttpServerResponse.text(
            "OT Gateway: the status page is not built (pnpm --filter @ot-gateway/web build). The API is at /api/status."
          )
        )
    // An open page asks every two seconds: neither a log line nor a trace per request (the edge log budget).
    const server = HttpRouter.serve(Layer.mergeAll(api, web, hostCheck(settings), writeGuard(editor)), {
      disableLogger: true,
      disableListenLog: true
    }).pipe(
      Layer.provide(
        NodeHttpServer.layer(
          () => {
            // Slow or idle clients cannot pile up: few connections, and short header and request deadlines.
            const node = createServer({ headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000 })
            node.maxConnections = MAX_CONNECTIONS
            return node
          },
          { port: settings.port, host: settings.bindAddress }
        )
      ),
      Layer.provide(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true))
    )
    yield* Effect.logInfo("status page").pipe(
      Effect.annotateLogs({
        url: `http://${settings.bindAddress}:${settings.port}/`,
        web: hasWeb ? webRoot : "not built"
      })
    )
    return yield* Layer.launch(server)
  }).pipe(
    Effect.catchTag("ServeError", (error) =>
      Effect.logError("status page not served; the gateway runs on without it").pipe(
        Effect.annotateLogs({ port: settings.port, error: String(error.cause) })
      )
    )
  )

/** Without a config file (the demo, a test) there is nothing to edit: why, and how to get a gateway that can. */
const noEditor = {
  reason: "This gateway runs without a config file (the demo), so there is nothing to edit here.",
  fix: "Run a gateway from its folder (ot-gateway init, then ot-gateway run or docker compose up -d) to edit its config in this page."
}
const noEditorStatus: EditStatus = { enabled: false, auth: "none", path: "", ...noEditor }

/**
 * Every request that is not a GET or HEAD goes through the edit guard (EditGuard.ts): same origin, the
 * `X-OT-Gateway` header, a loopback bind or the token. Refused with 403 and the reason, as `EditingDisabled`, so
 * the page's typed client reads it like any other answer. CORS preflights (OPTIONS) are refused too: never granted.
 */
const writeGuard = (editor: ConfigEditor | undefined) =>
  HttpRouter.middleware(
    (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (isReadOnlyMethod(request.method)) return yield* httpEffect
        const refusal =
          editor === undefined
            ? `${noEditor.reason} ${noEditor.fix}`
            : writeRefusal(
                {
                  host: request.headers["host"],
                  origin: request.headers["origin"],
                  [EDIT_HEADER]: request.headers[EDIT_HEADER],
                  authorization: request.headers["authorization"]
                },
                editor.access,
                editor.token
              )
        if (refusal === undefined) return yield* httpEffect
        return HttpServerResponse.jsonUnsafe({ _tag: "EditingDisabled", message: refusal }, { status: 403 })
      }),
    { global: true }
  )

/** An IPv4 address in 127.0.0.0/8, written as four decimal octets. */
const isLoopbackIpv4 = (name: string) => {
  const octets = name.split(".")
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  )
}

/** A port in a Host header: digits only, 1-65535. */
const isValidPort = (port: string) => /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535

/**
 * Whether a Host header names this machine by a loopback name (`localhost`,
 * `127.x.x.x`, `[::1]` or the bind address), with any valid port or none.
 * DNS rebinding depends on the name, not the port, and an SSH tunnel often
 * forwards from another local port.
 */
export const isLoopbackHost = (host: string, bindAddress: string): boolean => {
  const bracketEnd = host.startsWith("[") ? host.indexOf("]") : -1
  if (host.startsWith("[") && bracketEnd < 0) return false
  const colon = host.indexOf(":")
  const nameEnd = bracketEnd >= 0 ? bracketEnd + 1 : colon >= 0 ? colon : host.length
  const name = host.slice(0, nameEnd).toLowerCase()
  const rest = host.slice(nameEnd)
  if (rest !== "" && !(rest.startsWith(":") && isValidPort(rest.slice(1)))) return false
  const bindName = (bindAddress.includes(":") ? `[${bindAddress}]` : bindAddress).toLowerCase()
  return name === "localhost" || name === "[::1]" || isLoopbackIpv4(name) || name === bindName
}

/**
 * On a loopback address, answer only requests for a loopback host name. A
 * web page in a browser on the gateway's machine could otherwise point a DNS
 * name of its own at 127.0.0.1 and read the API (DNS rebinding). Bound to
 * another address, the page is meant for the network, and any host goes.
 */
const hostCheck = (settings: StatusSettings) => {
  if (!isLoopbackAddress(settings.bindAddress)) return Layer.empty
  // A fixed message: the Host header is not echoed back.
  const misdirected =
    `Misdirected request: open the status page as http://127.0.0.1:${settings.port} or ` +
    `http://localhost:${settings.port} (an SSH tunnel to it works on any local port)`
  return HttpRouter.middleware(
    (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (isLoopbackHost(request.headers.host ?? "", settings.bindAddress)) return yield* httpEffect
        return HttpServerResponse.text(misdirected, { status: 421 })
      }),
    { global: true }
  )
}
