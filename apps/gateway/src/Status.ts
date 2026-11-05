/**
 * The local status page: `GET /api/status` (the `OtGatewayApi` contract from
 * `@ot-gateway/api`) and the built web app (`apps/web/out`), served by the
 * gateway itself on `status.bindAddress:status.port`. Read-only: commands
 * reach devices only through MQTT and the command guard.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { type CommandStatus, type DeviceStatus, type GatewayStatus, type Messages, OtGatewayApi } from "@ot-gateway/api"
import type { HostSnapshot } from "./Host.ts"
import {
  bufferRows,
  type CommandOutcome,
  type GatewayConfig,
  type HealthRegistry,
  mqttConnected,
  type StatusSettings
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
  readonly recordCommand: (
    at: number,
    command: { readonly device: string; readonly point: string },
    outcome: CommandOutcome
  ) => void
  readonly snapshot: Effect.Effect<GatewayStatus>
  readonly messages: Effect.Effect<Messages>
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
  const latest = new Map<string, { payload: string; retained: boolean; at: number; count: number }>()
  const droppedTopics = new Set<string>()
  const commands: Array<CommandStatus> = []
  const attributes = { site: config.site, building: config.building }
  return {
    recordPublish: (topic, payload, message) => {
      if (!topic.startsWith(prefix)) return
      const previous = latest.get(topic)
      if (previous !== undefined || latest.size < MAX_TOPICS) {
        latest.set(topic, { payload, retained: message.retained, at: message.at, count: (previous?.count ?? 0) + 1 })
      } else if (droppedTopics.size < MAX_TOPICS) droppedTopics.add(topic)
      const rest = topic.slice(prefix.length)
      const slash = rest.indexOf("/")
      if (slash <= 0 || rest.indexOf("/", slash + 1) !== -1) return
      payloads.set(rest, payload)
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
    snapshot: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const connected = (yield* Metric.value(Metric.withAttributes(mqttConnected, attributes))).value === 1
      const rows = (yield* Metric.value(Metric.withAttributes(bufferRows, attributes))).value
      const devices = config.devices.map((device): DeviceStatus => {
        const state = health.devices.get(device.id) ?? { status: "starting" as const }
        return {
          id: device.id,
          protocol: device.protocol,
          status: state.status,
          pollIntervalMs: device.pollIntervalMs,
          ...(state.reason === undefined ? {} : { reason: state.reason }),
          ...(state.lastSuccess === undefined ? {} : { lastSuccess: state.lastSuccess }),
          points: device.points.map((point) => {
            const payload = payloads.get(`${device.id}/${point.id}`)
            const decoded = payload === undefined ? Option.none() : decodeValue(payload)
            const last = Option.getOrUndefined(decoded)
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
        broker: { url: config.mqtt.url, connected },
        ...(config.buffer === undefined ? {} : { buffer: { path: config.buffer.path, rows: Math.max(0, rows) } }),
        ...(host === undefined || sample === undefined
          ? {}
          : { host: { version: host.version, node: process.versions.node, ...sample } }),
        devices,
        commands: [...commands]
      }
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
    }))
  }
}

/**
 * Serve the API and, when it is built, the web app, until the scope closes.
 * A port that is taken is logged and the gateway runs on without its page:
 * the page must never cost the readings.
 */
export const serveStatus = (settings: StatusSettings, state: StatusState) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const webRoot = settings.webRoot ?? defaultWebRoot
    const hasWeb = yield* fs.exists(`${webRoot}/index.html`).pipe(Effect.orElseSucceed(() => false))
    const api = HttpApiBuilder.layer(OtGatewayApi).pipe(
      Layer.provide(
        HttpApiBuilder.group(OtGatewayApi, "status", (handlers) =>
          handlers.handle("status", () => state.snapshot).handle("messages", () => state.messages)
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
    const server = HttpRouter.serve(Layer.mergeAll(api, web, hostCheck(settings)), {
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

/** Loopback addresses a page served on this machine is reached at. */
const isLoopback = (address: string) => address === "localhost" || address === "::1" || address.startsWith("127.")

/**
 * On a loopback address, answer only requests for a loopback host name. A
 * web page in a browser on the gateway's machine could otherwise point a DNS
 * name of its own at 127.0.0.1 and read the API (DNS rebinding). Bound to
 * another address, the page is meant for the network, and any host goes.
 */
const hostCheck = (settings: StatusSettings) => {
  if (!isLoopback(settings.bindAddress)) return Layer.empty
  const port = String(settings.port)
  const allowed = new Set(
    ["localhost", "127.0.0.1", "[::1]", settings.bindAddress].flatMap((host) => [host, `${host}:${port}`])
  )
  return HttpRouter.middleware(
    (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (allowed.has(request.headers.host ?? "")) return yield* httpEffect
        return HttpServerResponse.text("Misdirected request: use a loopback address", { status: 421 })
      }),
    { global: true }
  )
}
