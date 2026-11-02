/**
 * The core `Publisher` service over an MQTT 5 broker connection.
 *
 * The connection opens in the background when the layer is built and is
 * kept open (with reconnects) for the layer's lifetime, so a broker that is
 * down at startup delays publishing but does not stop the gateway.
 */
import { NodeSocket } from "@effect/platform-node"
import { type MqttSettings, Publisher, PublishError } from "@plenum/core"
import { Config, Effect, Layer, Schema } from "effect"
import { hostname } from "node:os"
import { makeMqttClient } from "./Client.ts"
import type { MqttClientOptions } from "./Client.ts"

/** `mqtt.url` (or another setting) cannot be used. */
export class MqttSettingsError extends Schema.TaggedError<MqttSettingsError>()("MqttSettingsError", {
  message: Schema.String
}) {}

export interface BrokerAddress {
  readonly tls: boolean
  readonly host: string
  readonly port: number
}

/** Parse `mqtt://host[:port]` (default 1883) or `mqtts://host[:port]` (TLS, default 8883). */
export const parseBrokerUrl = (url: string): Effect.Effect<BrokerAddress, MqttSettingsError> =>
  Effect.gen(function* () {
    const parsed = URL.parse(url)
    if (parsed === null) return yield* new MqttSettingsError({ message: `mqtt.url is not a URL: ${url}` })
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
  "keepAliveSeconds" | "connectTimeout" | "publishTimeout" | "will" | "reconnectDelay"
> {}

/**
 * A `Publisher` from the gateway's `mqtt` settings. The password is read from
 * the environment variable named by `passwordEnv`, never from the file. The
 * client id defaults to `plenum-<hostname>`.
 */
export const MqttPublisher = (
  settings: MqttSettings,
  options: MqttPublisherOptions = {}
): Layer.Layer<Publisher, MqttSettingsError | Config.ConfigError> =>
  Layer.effect(
    Publisher,
    Effect.gen(function* () {
      const address = yield* parseBrokerUrl(settings.url)
      const password = settings.passwordEnv === undefined ? undefined : yield* Config.Redacted(settings.passwordEnv)
      const openTimeout = options.connectTimeout ?? "10 seconds"
      const socket = address.tls
        ? yield* NodeSocket.makeTls({ host: address.host, port: address.port, servername: address.host, openTimeout })
        : yield* NodeSocket.makeNet({ host: address.host, port: address.port, openTimeout })
      const client = yield* makeMqttClient(socket, {
        ...options,
        clientId: settings.clientId ?? `plenum-${hostname()}`,
        ...(settings.username === undefined ? {} : { username: settings.username }),
        ...(password === undefined ? {} : { password })
      })
      yield* Effect.logInfo("MQTT publisher started").pipe(
        Effect.annotateLogs({ broker: `${address.host}:${address.port}`, tls: address.tls })
      )
      return Publisher.of({
        publish: (topic, payload, publishOptions) =>
          publishOptions?.qos === 2
            ? Effect.fail(new PublishError({ topic, message: "QoS 2 is not supported" }))
            : client
                .publish(topic, payload, {
                  ...(publishOptions?.qos === undefined ? {} : { qos: publishOptions.qos }),
                  ...(publishOptions?.retain === undefined ? {} : { retain: publishOptions.retain })
                })
                .pipe(
                  Effect.catchTag("MqttPublishError", (error) =>
                    Effect.fail(new PublishError({ topic: error.topic, message: error.message }))
                  )
                )
      })
    })
  )
