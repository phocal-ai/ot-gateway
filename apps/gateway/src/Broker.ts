/**
 * The broker in a config, from the command line, so no MQTT client of its own is needed on the machine:
 *
 * - `ot-gateway broker` connects, says which MQTT the broker speaks and what it allows, and sends a message
 *   through it and back.
 * - `ot-gateway publish` sends one message, retained or not; an empty retained one clears the topic.
 *
 * Both connect with a client id of their own, so they run next to the gateway without taking its session.
 */
import type { GatewayConfig, MqttSettings } from "@ot-gateway/core"
import {
  type ConnectionInfo,
  makeMqttClient,
  type MqttClientOptions,
  MqttConnectionError,
  parseBrokerUrl,
  readBrokerPassword
} from "@ot-gateway/mqtt"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Deferred, Effect, Option, Random, Schema } from "effect"

/** How long the first dial may take, past the client's own connect timeout, before the command gives up. */
const DIAL_TIMEOUT = "15 seconds"
/** How long the round trip of `broker` waits for its message to come back. */
const ROUND_TRIP_TIMEOUT = "5 seconds"

export class BrokerCommandError extends Schema.TaggedError<BrokerCommandError>()("BrokerCommandError", {
  message: Schema.String
}) {}

/** Six hex digits, so two commands at once never share a client id. */
const randomSuffix = Effect.map(Random.nextIntBetween(0, 0xffffff), (value) => value.toString(16).padStart(6, "0"))

/**
 * A client of the config's broker, with its credentials and MQTT version, under a client id of its own
 * (`ot-gateway-<role>-<suffix>`). Shared by `watch`, `broker` and `publish`.
 */
export const brokerClient = Effect.fn("brokerClient")(function* (
  settings: MqttSettings,
  role: string,
  options: Omit<MqttClientOptions, "clientId" | "username" | "password" | "protocolVersion"> = {}
) {
  const address = yield* parseBrokerUrl(settings.url)
  const password = yield* readBrokerPassword(settings)
  const openTimeout = "10 seconds"
  const socket = address.tls
    ? yield* NodeSocket.makeTls({ host: address.host, port: address.port, servername: address.host, openTimeout })
    : yield* NodeSocket.makeNet({ host: address.host, port: address.port, openTimeout })
  return yield* makeMqttClient(socket, {
    ...options,
    clientId: `ot-gateway-${role}-${yield* randomSuffix}`,
    protocolVersion: settings.version,
    ...(settings.username === undefined ? {} : { username: settings.username }),
    ...(password === undefined ? {} : { password })
  })
})

/** The first dial's outcome, as one error a person can read. Shared by `watch --seconds`, `broker` and `publish`. */
export const firstDialOf = (
  client: { readonly firstDial: Effect.Effect<void, { readonly message: string }> },
  url: string
) =>
  client.firstDial.pipe(
    Effect.timeoutOrElse({
      duration: DIAL_TIMEOUT,
      orElse: () => Effect.fail(new MqttConnectionError({ message: `no answer within ${DIAL_TIMEOUT}` }))
    }),
    Effect.mapError(
      (error) =>
        // The socket's message starts with "could not connect" itself: say it once, with the URL.
        new BrokerCommandError({
          message: `could not connect to ${url}: ${error.message.replace(/^could not connect(: )?/, "")}`
        })
    )
  )

export interface BrokerReport extends ConnectionInfo {
  /** False when the round trip's message did not come back: the gateway could not read what it publishes. */
  readonly ok: boolean
  readonly broker: string
  /** How long a QoS 1 message took to the broker and back; absent when it did not come back. */
  readonly roundTripMs?: number
  readonly roundTripTopic: string
  readonly warnings: ReadonlyArray<string>
}

/** The site and building of a round-trip topic (`site/building/$gateway/...`), where the gateway publishes. */
const topicRoot = (topic: string) => topic.split("/").slice(0, 2).join("/")

/** What a broker's limits mean for the gateway, one sentence each. */
export const brokerWarnings = (info: ConnectionInfo, roundTripMs: number | undefined, topic: string) => [
  ...(info.protocolVersion === "3.1.1"
    ? [
        "MQTT 3.1.1: the broker announces no limits, commands get no correlation data and messages no expiry (docs/configuration.md, mqtt.version)"
      ]
    : []),
  ...(info.retainAvailable
    ? []
    : ["the broker keeps no retained messages: $meta and health reach only clients connected at the time"]),
  ...(info.maximumQoS === 0
    ? ["the broker allows QoS 0 only: nothing confirms that a message arrived, so the buffer cannot help"]
    : []),
  ...(roundTripMs === undefined
    ? [
        `a message to ${topic} did not come back within ${ROUND_TRIP_TIMEOUT}: check the broker's access rules (ACL) for this user under ${topicRoot(topic)}/#; they must allow both publishing and subscribing there (the gateway subscribes for commands and its own retained messages)`
      ]
    : [])
]

/** `ot-gateway broker`: connect, report what the broker allows, send a message through it and back. */
export const checkBroker = Effect.fn("checkBroker")(function* (config: GatewayConfig) {
  const topic = `${config.site}/${config.building}/$gateway/${config.id}/check/${yield* randomSuffix}`
  const payload = "ot-gateway broker check"
  const received = yield* Deferred.make<number>()
  const client = yield* brokerClient(config.mqtt, "check", {
    subscriptions: [{ filter: topic, qos: 1 }],
    onMessage: (message) =>
      message.topic === topic
        ? Effect.flatMap(
            Effect.clockWith((clock) => clock.currentTimeMillis),
            (now) => Deferred.succeed(received, now)
          ).pipe(Effect.asVoid)
        : Effect.void
  })
  yield* firstDialOf(client, config.mqtt.url)
  const info = yield* client.connection
  if (info === undefined) {
    return yield* new BrokerCommandError({ message: `connected to ${config.mqtt.url}, then lost the connection` })
  }
  const sentAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
  yield* client
    .publish(topic, payload, { qos: 1 })
    .pipe(
      Effect.mapError(
        (error) => new BrokerCommandError({ message: `${config.mqtt.url} did not take a message: ${error.message}` })
      )
    )
  const arrivedAt = yield* Deferred.await(received).pipe(Effect.timeoutOption(ROUND_TRIP_TIMEOUT))
  const roundTripMs = Option.match(arrivedAt, {
    onNone: () => undefined,
    onSome: (at) => Math.max(0, at - sentAt)
  })
  const report: BrokerReport = {
    ok: roundTripMs !== undefined,
    broker: config.mqtt.url,
    ...info,
    ...(roundTripMs === undefined ? {} : { roundTripMs }),
    roundTripTopic: topic,
    warnings: brokerWarnings(info, roundTripMs, topic)
  }
  return report
}, Effect.scoped)

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)} MiB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KiB`
      : `${bytes} B`

/** `broker` for a person: the connection, what the broker allows, the round trip and the warnings. */
export const formatBrokerReport = (report: BrokerReport) =>
  [
    `${report.broker}: connected with MQTT ${report.protocolVersion}`,
    `  allows QoS ${report.maximumQoS}, ${report.retainAvailable ? "retained messages" : "NO retained messages"}, ${report.receiveMaximum} in flight, ${report.maximumPacketSize === undefined ? "packets of any size" : `packets up to ${sizeText(report.maximumPacketSize)}`}, keep-alive ${report.keepAliveSeconds} s`,
    report.roundTripMs === undefined
      ? `  round trip: NO ANSWER within ${ROUND_TRIP_TIMEOUT}`
      : `  round trip: ${report.roundTripMs} ms (QoS 1, through ${report.roundTripTopic})`,
    ...report.warnings.map((warning) => `  warning: ${warning}`)
  ].join("\n")

/** `broker`'s failure after its report: the message did not come back, so the gateway would not work as it should. */
export const roundTripFailure = (report: BrokerReport) =>
  new BrokerCommandError({
    message: `${report.broker}: a message to ${report.roundTripTopic} did not come back within ${ROUND_TRIP_TIMEOUT}; see the warning above`
  })

export interface PublishCommandOptions {
  readonly retain: boolean
  readonly qos: 0 | 1
}

/**
 * `ot-gateway publish`: one message to the config's broker. With QoS 1 it returns once the broker confirmed it.
 * An empty retained payload clears what the broker keeps on the topic (MQTT 5 §3.3.1.3).
 */
export const publishOnce = Effect.fn("publishOnce")(function* (
  config: GatewayConfig,
  topic: string,
  payload: string,
  options: PublishCommandOptions
) {
  const client = yield* brokerClient(config.mqtt, "publish")
  yield* firstDialOf(client, config.mqtt.url)
  // The client lowers the QoS to what the broker's CONNACK allows: report the one that was used.
  const connection = yield* client.connection
  const qos: 0 | 1 = options.qos === 1 && (connection?.maximumQoS ?? 1) === 1 ? 1 : 0
  yield* client
    .publish(topic, payload, { qos: options.qos, retain: options.retain })
    .pipe(Effect.mapError((error) => new BrokerCommandError({ message: `${topic}: ${error.message}` })))
  return {
    ok: true as const,
    broker: config.mqtt.url,
    topic,
    bytes: new TextEncoder().encode(payload).length,
    qos,
    ...(qos === options.qos ? {} : { requestedQos: options.qos }),
    retain: options.retain,
    cleared: options.retain && payload === ""
  }
}, Effect.scoped)

/** `publish` for a person, one line. */
export const formatPublished = (result: Effect.Success<ReturnType<typeof publishOnce>>) =>
  result.cleared
    ? `cleared the retained message on ${result.topic}`
    : `published ${result.bytes} byte(s) to ${result.topic} (QoS ${result.qos}${result.requestedQos === undefined ? "" : ": the broker allows QoS 0 only"}${result.retain ? ", retained" : ""})`
