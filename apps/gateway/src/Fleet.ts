/**
 * `ot-gateway gateways`: the gateways a broker knows, read from what they already keep there, with no config of
 * their own, no status page and no database. The MQTT topics are the source of truth:
 *
 * - `gateways` (list): every retained `+/+/$gateway/+/health`, one line per gateway: online or offline, since when,
 *   and its devices by status.
 * - `gateways status <gateway>`: one gateway's health in full, each device with why it fails; exits with 1 when the
 *   gateway is offline or a device fails.
 * - `gateways points <gateway>`: the gateway's points from their retained `$meta` (name, unit, writable).
 *
 * A gateway is `site/building/id`, or only its id when no other gateway on the broker has it. The broker is
 * `--broker <url>` (with `--username` and the password in `OT_GATEWAY_BROKER_PASSWORD`), or else the config's.
 *
 * Retained messages come right after the subscription, so a command connects, waits `--wait` seconds (2 by default)
 * and answers from what arrived; `status` answers as soon as the one health message is in.
 */
import {
  type DeviceHealthPayload,
  HealthPayload,
  type HostHealthPayload,
  MetaPayload,
  MqttSettings
} from "@ot-gateway/core"
import type { InboundMessage } from "@ot-gateway/mqtt"
import { Deferred, type Duration, Effect, Option, Schema } from "effect"
import { brokerClient, firstDialOf } from "./Broker.ts"
import { withoutControls } from "./Discover.ts"
import { type ConfigFileError, loadConfig } from "./LoadConfig.ts"
import { localTime, UsageMistake } from "./Output.ts"
import { ago } from "./StatusReport.ts"
import { count, firstOf, LISTED, named, plural } from "./Words.ts"

/** Where `--broker` takes the password from, as the config's `mqtt.passwordEnv` would name it. */
export const BROKER_PASSWORD_ENV = "OT_GATEWAY_BROKER_PASSWORD"

/** How long a command waits for retained messages after the broker accepted its subscription, by default. */
export const DEFAULT_WAIT_SECONDS = 2

/** How long a command waits for the broker to answer its SUBSCRIBE before it waits for messages anyway. */
const SUBSCRIBE_TIMEOUT = "10 seconds"

/** Why a `gateways` command gave no answer: which gateway, or that there was none to name. */
export const FleetCode = Schema.Literals([
  "no-broker",
  "gateway-not-found",
  "gateway-ambiguous",
  "gateway-offline",
  "gateway-unhealthy",
  "health-unreadable",
  "subscribe-refused"
])
export type FleetCode = typeof FleetCode.Type

export class FleetError extends Schema.TaggedError<FleetError>()("FleetError", {
  message: Schema.String,
  code: FleetCode,
  hint: Schema.optionalKey(Schema.String)
}) {}

/**
 * The broker of `--broker`: the URL checked as a config's `mqtt.url` is. With `--username`, the password is read from
 * `OT_GATEWAY_BROKER_PASSWORD` (from ot-gateway.env too), never from a flag that would land in the shell's history.
 */
export const brokerSettings = (url: string, username: string | undefined) =>
  Schema.decodeUnknownEffect(MqttSettings)({
    url,
    ...(username === undefined ? {} : { username, passwordEnv: BROKER_PASSWORD_ENV })
  }).pipe(
    Effect.mapError(
      (error) =>
        new FleetError({
          code: "no-broker",
          message: `--broker ${withoutControls(url)}: ${error.message}`,
          hint: `name the broker as mqtt://host:1883 or mqtts://host:8883, without credentials: --username, and the password in ${BROKER_PASSWORD_ENV}`
        })
    )
  )

/**
 * The broker a `gateways` command asks: `--broker`, or else the broker of the config (./ot-gateway.json unless one is
 * named), so the commands work in a gateway's folder as they are and anywhere else with `--broker`.
 */
export const fleetBroker = Effect.fn("fleetBroker")(function* (options: {
  readonly broker: string | undefined
  readonly username: string | undefined
  readonly config: string
}) {
  if (options.broker !== undefined) return yield* brokerSettings(options.broker, options.username)
  if (options.username !== undefined) {
    return yield* new UsageMistake({
      code: "usage",
      message: "--username goes with --broker: without it the config's broker and login are used",
      missing: ["--broker"],
      hint: "pass --broker as well, or leave out --username"
    })
  }
  const config = yield* loadConfig(options.config).pipe(
    Effect.catchTag("ConfigFileError", (error): Effect.Effect<never, ConfigFileError | FleetError> =>
      error.code === "no-config"
        ? Effect.fail(
            new FleetError({
              code: "no-broker",
              message: `no broker to ask: no --broker, and no config at ${options.config}`,
              hint: "pass --broker mqtt://host:1883 (with --username and OT_GATEWAY_BROKER_PASSWORD when it needs a login), or run it in a gateway's folder"
            })
          )
        : Effect.fail(error)
    )
  )
  return config.mqtt
})

/** A gateway as the broker shows it: where, and what its retained health says. */
export interface FleetGateway {
  readonly site: string
  readonly building: string
  readonly id: string
  /** `site/building/id`, the name the commands take. */
  readonly name: string
  readonly status: "online" | "offline" | "unreadable"
  /** Why it is offline: a clean stop (`shutdown`) or its last will (`connection-lost`). */
  readonly reason?: string
  readonly contract?: string
  /** When it started (Unix ms), while online. */
  readonly since?: number
  /** Its last heartbeat (Unix ms), while online. */
  readonly ts?: number
  readonly devices: ReadonlyArray<{ readonly id: string } & DeviceHealthPayload>
  readonly host?: HostHealthPayload
}

/** `site/building/$gateway/<id>/health` as its three names, or undefined for any other topic. */
export const healthTopicParts = (topic: string) => {
  const parts = topic.split("/")
  if (parts.length !== 5 || parts[2] !== "$gateway" || parts[4] !== "health") return undefined
  const [site = "", building = "", , id = ""] = parts
  return { site, building, id }
}

const decodeHealth = Schema.decodeUnknownOption(Schema.fromJsonString(HealthPayload))

/** A gateway from its health message; undefined for a topic that is not a health topic or an empty (cleared) one. */
export const gatewayOf = (message: Pick<InboundMessage, "topic" | "payload">): FleetGateway | undefined => {
  const where = healthTopicParts(message.topic)
  if (where === undefined || message.payload === "") return undefined
  const base = { ...where, name: `${where.site}/${where.building}/${where.id}` }
  const health = Option.getOrUndefined(decodeHealth(message.payload))
  if (health === undefined) return { ...base, status: "unreadable", devices: [] }
  if (health.status === "offline") return { ...base, status: "offline", reason: health.reason, devices: [] }
  return {
    ...base,
    status: "online",
    contract: health.contract,
    since: health.since,
    ts: health.ts,
    devices: Object.entries(health.devices)
      .map(([id, device]) => ({ id, ...device }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    ...(health.host === undefined ? {} : { host: health.host })
  }
}

/** The gateways in `messages`, sorted by name. */
export const gatewaysOf = (messages: ReadonlyArray<Pick<InboundMessage, "topic" | "payload">>) =>
  messages
    .flatMap((message) => {
      const gateway = gatewayOf(message)
      return gateway === undefined ? [] : [gateway]
    })
    .toSorted((left, right) => left.name.localeCompare(right.name))

/** A gateway as typed: `site/building/id`, or an id alone. */
export interface GatewayRef {
  readonly site?: string
  readonly building?: string
  readonly id: string
}

export const parseGatewayRef = (text: string): Effect.Effect<GatewayRef, FleetError> => {
  const parts = text.split("/")
  const valid = parts.every((part) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(part))
  if (valid && parts.length === 1) return Effect.succeed({ id: parts[0] ?? "" })
  if (valid && parts.length === 3) {
    const [site = "", building = "", id = ""] = parts
    return Effect.succeed({ site, building, id })
  }
  return Effect.fail(
    new FleetError({
      code: "gateway-not-found",
      message: `${withoutControls(text)} names no gateway: write site/building/id, or the id alone`,
      hint: "ot-gateway gateways lists the gateways the broker knows, by site/building/id"
    })
  )
}

/** The health topic filter for a gateway as typed; `+` for what it leaves out. */
export const healthFilter = (ref: GatewayRef) => `${ref.site ?? "+"}/${ref.building ?? "+"}/$gateway/${ref.id}/health`

/** The one gateway of `gateways` that `ref` names, or why there is none. */
export const pickGateway = (
  gateways: ReadonlyArray<FleetGateway>,
  ref: GatewayRef,
  text: string
): Effect.Effect<FleetGateway, FleetError> => {
  const matching = gateways.filter(
    (gateway) =>
      gateway.id === ref.id &&
      (ref.site === undefined || gateway.site === ref.site) &&
      (ref.building === undefined || gateway.building === ref.building)
  )
  const [only] = matching
  if (only !== undefined && matching.length === 1) return Effect.succeed(only)
  if (matching.length > 1) {
    return Effect.fail(
      new FleetError({
        code: "gateway-ambiguous",
        message: `${matching.length} gateways have the id ${ref.id}: ${matching.map((gateway) => gateway.name).join(", ")}`,
        hint: `name one as site/building/id, such as ot-gateway gateways status ${matching[0]?.name ?? ""}`
      })
    )
  }
  return Effect.fail(
    new FleetError({
      code: "gateway-not-found",
      message: `the broker keeps no health of a gateway ${withoutControls(text)}`,
      hint: "ot-gateway gateways lists the gateways the broker knows; a gateway that never connected to this broker is not among them"
    })
  )
}

/**
 * What the broker sends on `filters` within `wait` of the subscription, the latest message per topic (an empty
 * retained message clears its topic). `enough` ends the wait early.
 */
export const collectMessages = Effect.fn("collectMessages")(function* (
  settings: MqttSettings,
  filters: ReadonlyArray<string>,
  wait: Duration.Input,
  enough: (messages: ReadonlyMap<string, InboundMessage>) => boolean = () => false
) {
  const latest = new Map<string, InboundMessage>()
  const done = yield* Deferred.make<void>()
  const subscribed = yield* Deferred.make<ReadonlyArray<string>>()
  const client = yield* brokerClient(settings, "gateways", {
    subscriptions: filters.map((filter) => ({ filter, qos: 0 as const })),
    onSubscribed: (refused) => Deferred.succeed(subscribed, refused).pipe(Effect.asVoid),
    onMessage: (message) =>
      Effect.gen(function* () {
        if (message.payload === "") latest.delete(message.topic)
        else latest.set(message.topic, message)
        if (enough(latest)) yield* Deferred.succeed(done, undefined)
      })
  })
  yield* firstDialOf(client, settings)
  // The wait counts from the broker's answer to the SUBSCRIBE, which the retained messages follow. A broker that
  // does not answer in time gets the wait from now; one that refuses a filter (its ACL) is a failure, not "none".
  const refused = yield* Deferred.await(subscribed).pipe(Effect.timeoutOption(SUBSCRIBE_TIMEOUT))
  if (Option.isSome(refused) && refused.value.length > 0) {
    return yield* new FleetError({
      code: "subscribe-refused",
      message: `${settings.url} refused the subscription to ${refused.value.join(", ")}`,
      hint: `the broker's access rules do not let ${settings.username ?? "this login"} read those topics: allow it to read +/+/$gateway/+/health and +/+/+/+/$meta`
    })
  }
  yield* Effect.raceFirst(Deferred.await(done), Effect.sleep(wait))
  return [...latest.values()]
}, Effect.scoped)

/** Every gateway whose health the broker keeps. */
export const listGateways = Effect.fn("listGateways")(function* (settings: MqttSettings, wait: Duration.Input) {
  const messages = yield* collectMessages(settings, ["+/+/$gateway/+/health"], wait)
  return { ok: true as const, broker: settings.url, gateways: gatewaysOf(messages) }
})

/** One gateway's health, as soon as it arrived (or why there is none). */
export const gatewayStatus = Effect.fn("gatewayStatus")(function* (
  settings: MqttSettings,
  text: string,
  wait: Duration.Input
) {
  const ref = yield* parseGatewayRef(text)
  // With site and building there is one topic: its message is the answer. An id alone waits for every match.
  const exact = ref.site !== undefined
  const messages = yield* collectMessages(settings, [healthFilter(ref)], wait, (latest) => exact && latest.size > 0)
  const gateway = yield* pickGateway(gatewaysOf(messages), ref, text)
  return { ok: gateway.status === "online" && gateway.devices.every((device) => device.status !== "failing"), gateway }
})

/** A point as its retained `$meta` describes it. */
export interface FleetPoint {
  readonly device: string
  readonly point: string
  readonly topic: string
  readonly name: string
  readonly unit?: string
  readonly writable: boolean
}

const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(MetaPayload))

/**
 * The points of `gateway` among retained `$meta` messages: the ones that name it, and under its site and building
 * the ones of its devices that name no gateway (from a release before `$meta` named one).
 */
export const pointsOf = (gateway: FleetGateway, messages: ReadonlyArray<Pick<InboundMessage, "topic" | "payload">>) => {
  const devices = new Set(gateway.devices.map((device) => device.id))
  return messages
    .flatMap((message): ReadonlyArray<FleetPoint> => {
      const [site, building, device = "", point = "", suffix, ...rest] = message.topic.split("/")
      if (site !== gateway.site || building !== gateway.building || suffix !== "$meta" || rest.length > 0) return []
      const meta = Option.getOrUndefined(decodeMeta(message.payload))
      if (meta === undefined) return []
      const owned = meta.gateway === undefined ? devices.has(device) : meta.gateway === gateway.id
      if (!owned) return []
      return [
        {
          device,
          point,
          topic: message.topic.slice(0, -"/$meta".length),
          name: meta.name,
          ...(meta.unit === undefined ? {} : { unit: meta.unit }),
          writable: meta.writable
        }
      ]
    })
    .toSorted((left, right) => left.topic.localeCompare(right.topic))
}

/** One gateway's points, from the `$meta` the broker keeps under its site and building. */
export const gatewayPoints = Effect.fn("gatewayPoints")(function* (
  settings: MqttSettings,
  text: string,
  wait: Duration.Input
) {
  const ref = yield* parseGatewayRef(text)
  const site = ref.site ?? "+"
  const building = ref.building ?? "+"
  const messages = yield* collectMessages(settings, [healthFilter(ref), `${site}/${building}/+/+/$meta`], wait)
  const gateway = yield* pickGateway(gatewaysOf(messages), ref, text)
  return { ok: true as const, gateway: gateway.name, status: gateway.status, points: pointsOf(gateway, messages) }
})

// ---------------------------------------------------------------------------------------------------------------
// Text

const deviceCounts = (gateway: FleetGateway) => {
  const inState = (status: DeviceHealthPayload["status"]) =>
    gateway.devices.filter((device) => device.status === status).length
  const parts = [
    `${count(inState("ok"))} ok`,
    `${count(inState("failing"))} failing`,
    `${count(inState("starting"))} starting`
  ].filter((part) => !part.startsWith("0 ") || part.endsWith(" ok"))
  return `${plural(gateway.devices.length, "device")}: ${parts.join(", ")}`
}

/** One gateway's line: name, status, and while online its devices, since when it runs and its last heartbeat. */
const gatewayLine = (gateway: FleetGateway, now: number, width: number) => {
  const name = withoutControls(gateway.name).padEnd(width)
  if (gateway.status === "unreadable") return `  ${name}  unreadable  its health is not one this CLI reads`
  if (gateway.status === "offline") return `  ${name}  offline     ${gateway.reason ?? ""}`
  const since = gateway.since === undefined ? "" : `, up since ${localTime(gateway.since, now)}`
  const heartbeat = gateway.ts === undefined ? "" : `, heartbeat ${ago(now - gateway.ts)} ago`
  return `  ${name}  online      ${deviceCounts(gateway)}${since}${heartbeat}`
}

export const formatGatewayList = (
  report: { readonly broker: string; readonly gateways: ReadonlyArray<FleetGateway> },
  now: number
) => {
  if (report.gateways.length === 0) {
    return [
      `no gateway keeps its health on ${report.broker}`,
      "  A gateway publishes it retained on site/building/$gateway/<id>/health once it connects: check the broker it is configured with."
    ].join("\n")
  }
  const width = Math.max(...report.gateways.map((gateway) => gateway.name.length))
  return [
    `${plural(report.gateways.length, "gateway")} on ${report.broker}`,
    ...report.gateways.map((gateway) => gatewayLine(gateway, now, width))
  ].join("\n")
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`

/** The options of the text for a person: `brief` (a terminal, no --all) lists only what needs a look. */
export interface FleetTextOptions {
  readonly brief?: boolean
}

/**
 * One gateway: its line, its machine, then a line per device. `brief` with more than a few devices lists only the
 * ones not ok, the first few; --all, a pipe and --json have every device.
 */
export const formatGatewayStatus = (gateway: FleetGateway, now: number, options: FleetTextOptions = {}) => {
  const brief = (options.brief ?? false) && gateway.devices.length > LISTED
  const needing = gateway.devices.filter((device) => device.status !== "ok")
  const { shown, more } = brief ? firstOf(needing) : { shown: gateway.devices, more: 0 }
  const width = Math.max(0, ...shown.map((device) => device.id.length))
  const host = gateway.host
  const hostLine =
    host === undefined
      ? []
      : [
          `  host: ${[
            `memory ${megabytes(host.memoryBytes)}`,
            `event-loop lag ${Math.round(host.eventLoopLagMs)} ms`,
            host.diskFreeBytes === undefined ? undefined : `disk free ${megabytes(host.diskFreeBytes)}`,
            host.temperatureC === undefined ? undefined : `${Math.round(host.temperatureC)} °C`,
            host.throttled === undefined || host.throttled.length === 0 ? undefined : host.throttled.join(", ")
          ]
            .filter((part) => part !== undefined)
            .join(", ")}`
        ]
  return [
    gatewayLine(gateway, now, gateway.name.length).trimStart(),
    ...(gateway.contract === undefined ? [] : [`  MQTT contract ${gateway.contract}`]),
    ...hostLine,
    ...shown.map((device) => {
      const id = withoutControls(device.id).padEnd(width)
      const last = device.lastSuccess === undefined ? "" : `, last read ${ago(now - device.lastSuccess)} ago`
      if (device.status !== "failing") return `  ${id}  ${device.status}${last}`
      const since = device.failingSince === undefined ? "" : ` since ${localTime(device.failingSince, now)}`
      return `  ${id}  failing${since} (${device.reason ?? "no reason given"})${last}`
    }),
    ...(more > 0
      ? [`  and ${count(more)} more ${needing.every((device) => device.status === "failing") ? "failing" : "not ok"}`]
      : []),
    ...(brief ? ["  --all lists every device"] : [])
  ].join("\n")
}

/** Up to this many points, a terminal lists each; beyond, how many and the writable ones. */
const POINTS_LISTED = 20

export const formatGatewayPoints = (
  report: {
    readonly gateway: string
    readonly status: FleetGateway["status"]
    readonly points: ReadonlyArray<FleetPoint>
  },
  options: FleetTextOptions = {}
) => {
  if (report.points.length === 0) {
    return report.status === "online"
      ? `${report.gateway}: the broker keeps no $meta of its points`
      : `${report.gateway}: no $meta names it. It is ${report.status}, so its devices are not known, and the $meta of a release before $meta named its gateway cannot be told apart.`
  }
  const devices = new Set(report.points.map((point) => point.device)).size
  const writable = report.points.filter((point) => point.writable)
  const brief = (options.brief ?? false) && report.points.length > POINTS_LISTED
  // A terminal with many points: how many, and the writable ones, which take commands.
  const { shown, more } = brief ? firstOf(writable, LISTED) : { shown: report.points, more: 0 }
  const width = Math.max(0, ...shown.map((point) => `${point.device}/${point.point}`.length))
  return [
    `${report.gateway}: ${plural(report.points.length, "point")} on ${plural(devices, "device")}${brief ? `, ${count(writable.length)} writable${writable.length > 0 ? ":" : ""}` : ""}`,
    ...shown.map((point) =>
      [
        `  ${withoutControls(`${point.device}/${point.point}`).padEnd(width)}`,
        withoutControls(point.name),
        point.unit === undefined ? undefined : `[${withoutControls(point.unit)}]`,
        point.writable ? "writable" : undefined
      ]
        .filter((part) => part !== undefined)
        .join("  ")
    ),
    ...(more > 0 ? [`  and ${count(more)} more writable`] : []),
    ...(brief ? ["  --all lists every point, --json each with its topic"] : [])
  ].join("\n")
}

/** The failure after `gateways status` printed its report: offline, or a device failing. */
export const statusFailure = (gateway: FleetGateway) => {
  if (gateway.status === "unreadable") {
    return new FleetError({
      code: "health-unreadable",
      message: `${gateway.name}: its health is not a message this CLI reads, so it may well be online`,
      hint: "the gateway likely runs a newer release than this CLI (npm i -g ot-gateway@latest, or pnpm add -g ot-gateway@VERSION with the VERSION npm view ot-gateway version prints), or something else publishes on its health topic: ot-gateway watch --topic '<site>/<building>/$gateway/#' shows it"
    })
  }
  if (gateway.status !== "online") {
    return new FleetError({
      code: "gateway-offline",
      message: `${gateway.name} is ${gateway.status}${gateway.reason === undefined ? "" : ` (${gateway.reason})`}`,
      hint: "connection-lost is its last will: the gateway, its machine or its network to the broker went away. shutdown is a clean stop."
    })
  }
  const failing = gateway.devices.filter((device) => device.status === "failing").map((device) => device.id)
  if (failing.length === 0) return undefined
  return new FleetError({
    code: "gateway-unhealthy",
    message: `${gateway.name}: ${plural(failing.length, "device")} failing: ${named(failing)}`,
    hint: "on the gateway's machine, ot-gateway status says what to check for each, and ot-gateway events since when"
  })
}
