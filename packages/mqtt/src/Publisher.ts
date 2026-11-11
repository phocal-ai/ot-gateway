/**
 * The core `Publisher` service over an MQTT 5 broker connection.
 *
 * The connection opens in the background when the layer is built and is
 * kept open (with reconnects) for the layer's lifetime, so a broker that is
 * down at startup delays publishing but does not stop the gateway.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import {
  type MqttSettings,
  mqttPasswordWarning,
  type Network,
  offlinePayload,
  Publisher,
  PublishError
} from "@ot-gateway/core"
import { Config, Effect, Layer, type Redacted, Schema } from "effect"
import { hostname } from "node:os"
import { makeMqttClient, MqttPublishError } from "./Client.ts"
import type { ConnectionInfo, MqttClient, MqttClientOptions } from "./Client.ts"

/** `mqtt.url` (or another setting) cannot be used. */
export class MqttSettingsError extends Schema.TaggedError<MqttSettingsError>()("MqttSettingsError", {
  message: Schema.String
}) {}

/**
 * The broker password from the variable `mqtt.passwordEnv` names, or undefined when it names none. An unset
 * variable fails with a message that names it and the file it goes in, instead of Effect's bare config error.
 * Shared by the publisher and the CLI's broker commands.
 */
export const readBrokerPassword = (
  settings: Pick<MqttSettings, "passwordEnv">
): Effect.Effect<Redacted.Redacted | undefined, MqttSettingsError> =>
  Effect.gen(function* () {
    const name = settings.passwordEnv
    if (name === undefined) return undefined
    return yield* Config.Redacted(name).pipe(
      Effect.catchTag("ConfigError", () =>
        Effect.fail(
          new MqttSettingsError({
            message: `${name} is not set: the config's mqtt.passwordEnv names it. Put the broker password in ot-gateway.env (${name}=...), or in /etc/ot-gateway/gateway.env under systemd.`
          })
        )
      )
    )
  })

export interface BrokerAddress {
  readonly tls: boolean
  readonly host: string
  readonly port: number
}

/** Parse `mqtt://host[:port]` (default 1883) or `mqtts://host[:port]` (TLS, default 8883). */
export const parseBrokerUrl = (url: string): Effect.Effect<BrokerAddress, MqttSettingsError> =>
  Effect.gen(function* () {
    const parsed = URL.parse(url)
    if (parsed === null) return yield* new MqttSettingsError({ message: "mqtt.url is not a URL" })
    if (parsed.protocol !== "mqtt:" && parsed.protocol !== "mqtts:") {
      return yield* new MqttSettingsError({
        message: `mqtt.url must start with mqtt:// or mqtts://, got ${parsed.protocol}//`
      })
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return yield* new MqttSettingsError({
        message: "mqtt.url must not contain credentials; use mqtt.username and mqtt.passwordEnv"
      })
    }
    const tls = parsed.protocol === "mqtts:"
    // URL keeps IPv6 hosts in brackets; the socket wants them bare.
    const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1")
    if (host === "") return yield* new MqttSettingsError({ message: "mqtt.url has no host" })
    return { tls, host, port: parsed.port === "" ? (tls ? 8883 : 1883) : Number(parsed.port) }
  })

export interface MqttPublisherOptions extends Pick<
  MqttClientOptions,
  | "keepAliveSeconds"
  | "connectTimeout"
  | "publishTimeout"
  | "waitForConnection"
  | "reconnectDelay"
  | "subscriptions"
  | "onMessage"
  | "onDisconnected"
> {
  /**
   * Announce the gateway on its health topic: `online` (rendered fresh by
   * `online`) on every connect, `offline` as the last will and on a clean
   * shutdown.
   */
  readonly health?: { readonly topic: string; readonly online: Effect.Effect<string> }
  /** Connect through this network instead of Node's (a simulation); TLS is then the network's business. */
  readonly network?: Pick<Network, "tcp">
  /** Told on every connect what the broker allowed, before the health message and the retained replay. */
  readonly onConnected?: (connection: ConnectionInfo) => Effect.Effect<void>
}

/** Client errors become the core `PublishError`. */
const translate = <A>(effect: Effect.Effect<A, MqttPublishError>): Effect.Effect<A, PublishError> =>
  effect.pipe(
    Effect.catchTag("MqttPublishError", (error) =>
      Effect.fail(
        new PublishError({
          topic: error.topic,
          reason: error.reason,
          message: error.message,
          ...(error.inFlight === undefined ? {} : { inFlight: error.inFlight })
        })
      )
    )
  )

/**
 * A `Publisher` from the gateway's `mqtt` settings. The password is read from
 * the environment variable named by `passwordEnv`, never from the file. The
 * client id defaults to `ot-gateway-<hostname>`.
 *
 * Retained messages that reached the broker are remembered (the latest per
 * topic) and published again after every reconnect, because a broker without
 * persistence loses them when it restarts. Values are not retained, so they
 * are never replayed.
 */
export const MqttPublisher = (
  settings: MqttSettings,
  options: MqttPublisherOptions = {}
): Layer.Layer<Publisher, MqttSettingsError> =>
  Layer.effect(
    Publisher,
    Effect.gen(function* () {
      const address = yield* parseBrokerUrl(settings.url)
      const password = yield* readBrokerPassword(settings)
      // Once per layer, not per connection: reconnects happen inside the client.
      const passwordWarning = mqttPasswordWarning(settings)
      if (passwordWarning !== undefined) {
        yield* Effect.logWarning(passwordWarning).pipe(
          Effect.annotateLogs({ broker: `${address.host}:${address.port}`, tls: address.tls })
        )
      }
      const openTimeout = options.connectTimeout ?? "10 seconds"
      const socket = options.network
        ? yield* options.network.tcp({ host: address.host, port: address.port, openTimeout })
        : address.tls
          ? yield* NodeSocket.makeTls({ host: address.host, port: address.port, servername: address.host, openTimeout })
          : yield* NodeSocket.makeNet({ host: address.host, port: address.port, openTimeout })
      const { health, network: _network, onConnected, ...clientOptions } = options
      // The latest retained payload per topic, tagged with the connection it went out on.
      const retained = new Map<string, { readonly payload: string; readonly connection: number }>()
      let connection = 0

      const publishRetained = Effect.fnUntraced(function* (client: MqttClient, topic: string, payload: string) {
        yield* client.publish(topic, payload, { retain: true })
        // A PUBACK arrives on the connection the message went out on, and a dropped
        // connection fails its publishes, so the current connection is the right one.
        retained.set(topic, { payload, connection })
      })

      // Each message on its own: one the broker refuses must not keep the others off it.
      // If the connection drops meanwhile, this is interrupted and the next connect starts over.
      const onConnect = Effect.fnUntraced(function* (client: MqttClient) {
        connection++
        const info = yield* client.connection
        if (info !== undefined && onConnected !== undefined) yield* onConnected(info)
        if (health !== undefined) {
          yield* publishRetained(client, health.topic, yield* health.online).pipe(
            Effect.catchTag("MqttPublishError", (error) =>
              Effect.logWarning("announcing the gateway failed").pipe(Effect.annotateLogs({ error: error.message }))
            )
          )
        }
        // Only what went out on earlier connections; anything since is already on this broker.
        const replay = [...retained].filter(
          ([topic, entry]) => topic !== health?.topic && entry.connection < connection
        )
        if (replay.length === 0) return
        // Bounded by the broker's Receive Maximum inside the client as well.
        const outcomes = yield* Effect.forEach(
          replay,
          ([topic, entry]) =>
            client.publish(topic, entry.payload, { retain: true }).pipe(
              Effect.as(true),
              Effect.catchTag("MqttPublishError", (error) =>
                Effect.logWarning("replaying a retained message failed").pipe(
                  Effect.annotateLogs({ topic: error.topic, error: error.message }),
                  Effect.as(false)
                )
              )
            ),
          { concurrency: 16 }
        )
        const replayed = outcomes.filter(Boolean).length
        yield* Effect.logInfo("replayed retained messages").pipe(
          Effect.annotateLogs({ count: replayed, failed: outcomes.length - replayed })
        )
      })

      const client = yield* makeMqttClient(socket, {
        ...clientOptions,
        clientId: settings.clientId ?? `ot-gateway-${hostname()}`,
        protocolVersion: settings.version,
        ...(settings.username === undefined ? {} : { username: settings.username }),
        ...(password === undefined ? {} : { password }),
        ...(health === undefined
          ? {}
          : { will: { topic: health.topic, payload: offlinePayload("connection-lost"), qos: 1, retain: true } }),
        onConnect
      })
      if (health !== undefined) {
        // Runs before the client's scope closes, so the goodbye goes out ahead of DISCONNECT.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (!(yield* client.isConnected)) return
            yield* client.publish(health.topic, offlinePayload("shutdown"), { retain: true })
          }).pipe(
            Effect.timeoutOrElse({
              duration: "2 seconds",
              orElse: () =>
                Effect.fail(
                  new MqttPublishError({ topic: health.topic, reason: "unavailable", message: "no PUBACK in time" })
                )
            }),
            // DISCONNECT follows and discards the will, so the retained health message keeps saying online: log why.
            Effect.catchTag("MqttPublishError", (error) =>
              Effect.logWarning("publishing offline at shutdown failed").pipe(
                Effect.annotateLogs({ error: error.message })
              )
            )
          )
        )
      }
      yield* Effect.logInfo("MQTT publisher started").pipe(
        Effect.annotateLogs({ broker: `${address.host}:${address.port}`, tls: address.tls })
      )
      return Publisher.of({
        publish: (topic, payload, publishOptions) => {
          if (publishOptions?.qos === 2)
            return Effect.fail(new PublishError({ topic, reason: "rejected", message: "QoS 2 is not supported" }))
          const qos = publishOptions?.qos === undefined ? {} : { qos: publishOptions.qos }
          const correlation =
            publishOptions?.correlationData === undefined ? {} : { correlationData: publishOptions.correlationData }
          return publishOptions?.retain === true
            ? translate(publishRetained(client, topic, payload))
            : translate(client.publish(topic, payload, { ...qos, ...correlation }))
        }
      })
    })
  )
