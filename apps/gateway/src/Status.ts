/**
 * The local status page: `GET /api/status` (the `PlenumApi` contract from
 * `@plenum/api`) and the built web app (`apps/web/out`), served by the
 * gateway itself on `status.bindAddress:status.port`. Read-only: commands
 * reach devices only through MQTT and the command guard.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { type CommandStatus, type DeviceStatus, type GatewayStatus, PlenumApi } from "@plenum/api"
import {
  bufferRows,
  type CommandOutcome,
  type GatewayConfig,
  type HealthRegistry,
  mqttConnected,
  type StatusSettings
} from "@plenum/core"
import { Clock, Effect, FileSystem, Layer, Metric, Option, Schema } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

/** Commands kept for the page, newest first. */
const RECENT_COMMANDS = 50

/** A value message as the pipeline publishes it; read back from what the gateway itself sent. */
const ValueMessage = Schema.fromJsonString(
  Schema.Struct({ value: Schema.Union([Schema.Number, Schema.Boolean]), ts: Schema.Number })
)
const decodeValue = Schema.decodeUnknownOption(ValueMessage)

/** The built web app, when the config does not name one: apps/web/out next to this app. */
export const defaultWebRoot = fileURLToPath(new URL("../../web/out", import.meta.url))

export interface StatusState {
  /** Note a message the gateway published; values (`site/building/device/point`) are kept, the rest ignored. */
  readonly recordPublish: (topic: string, payload: string) => void
  readonly recordCommand: (
    at: number,
    command: { readonly device: string; readonly point: string },
    outcome: CommandOutcome
  ) => void
  readonly snapshot: Effect.Effect<GatewayStatus>
}

export const makeStatusState = (config: GatewayConfig, health: HealthRegistry, since: number): StatusState => {
  const prefix = `${config.site}/${config.building}/`
  const values = new Map<string, { readonly value: number | boolean; readonly ts: number }>()
  const commands: Array<CommandStatus> = []
  const attributes = { site: config.site, building: config.building }
  return {
    recordPublish: (topic, payload) => {
      if (!topic.startsWith(prefix)) return
      const levels = topic.slice(prefix.length).split("/")
      if (levels.length !== 2) return
      const decoded = decodeValue(payload)
      if (Option.isSome(decoded)) values.set(levels.join("/"), decoded.value)
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
          ...(state.reason === undefined ? {} : { reason: state.reason }),
          ...(state.lastSuccess === undefined ? {} : { lastSuccess: state.lastSuccess }),
          points: device.points.map((point) => {
            const last = values.get(`${device.id}/${point.id}`)
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
      return {
        site: config.site,
        building: config.building,
        id: config.id,
        since,
        now,
        broker: { url: config.mqtt.url, connected },
        ...(config.buffer === undefined ? {} : { buffer: { path: config.buffer.path, rows: Math.max(0, rows) } }),
        devices,
        commands: [...commands]
      }
    })
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
    const api = HttpApiBuilder.layer(PlenumApi).pipe(
      Layer.provide(
        HttpApiBuilder.group(PlenumApi, "status", (handlers) => handlers.handle("status", () => state.snapshot))
      )
    )
    const web = hasWeb
      ? HttpStaticServer.layer({ root: webRoot, spa: true })
      : HttpRouter.add(
          "GET",
          "/",
          HttpServerResponse.text(
            "Plenum gateway: the status page is not built (pnpm --filter @plenum/web build). The API is at /api/status."
          )
        )
    // An open page asks every two seconds: neither a log line nor a trace per request (the edge log budget).
    const server = HttpRouter.serve(Layer.mergeAll(api, web), { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port: settings.port, host: settings.bindAddress })),
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
    Effect.catch((error) =>
      Effect.logError("status page not served; the gateway runs on without it").pipe(
        Effect.annotateLogs({ port: settings.port, error: String(error) })
      )
    )
  )
