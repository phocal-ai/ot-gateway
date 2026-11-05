/**
 * `ot-gateway watch`: what the gateway publishes, as it arrives at the broker in the config. It subscribes to
 * `site/building/#` (or a filter of its own) with a client id of its own, so it runs next to the gateway, and
 * prints one line per message: the time, `retained` for what the broker kept, the topic and the payload.
 */
import type { GatewayConfig } from "@ot-gateway/core"
import { type InboundMessage, makeMqttClient, parseBrokerUrl } from "@ot-gateway/mqtt"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Config, Console, Effect, Random } from "effect"

/** Payloads are cut here on the terminal; the status page and any MQTT client show them whole. */
const MAX_PAYLOAD = 300

/** Everything under the config's site and building: values, `$meta`, the gateway's health and command results. */
export const watchFilter = (config: Pick<GatewayConfig, "site" | "building">) => `${config.site}/${config.building}/#`

const twoDigits = (value: number) => String(value).padStart(2, "0")

/** One line for a message: local time, a retained marker, the topic and the payload on one line. */
export const formatMessage = (message: Pick<InboundMessage, "topic" | "payload" | "retain">, at: Date) => {
  const time = `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}:${twoDigits(at.getSeconds())}`
  const flat = message.payload.replace(/\s*\n\s*/g, " ")
  const payload = flat.length > MAX_PAYLOAD ? `${flat.slice(0, MAX_PAYLOAD)}…` : flat
  return `${time} ${message.retain ? "retained " : ""}${message.topic} ${payload}`
}

export interface WatchOptions {
  /** A topic filter instead of the config's site and building (`#` for everything on the broker). */
  readonly topic?: string | undefined
}

/** Prints the broker's messages until interrupted (Ctrl-C), reconnecting as the gateway does. */
export const watch = Effect.fn("watch")(function* (config: GatewayConfig, options: WatchOptions = {}) {
  const address = yield* parseBrokerUrl(config.mqtt.url)
  const password = config.mqtt.passwordEnv === undefined ? undefined : yield* Config.Redacted(config.mqtt.passwordEnv)
  const filter = options.topic ?? watchFilter(config)
  const openTimeout = "10 seconds"
  const socket = address.tls
    ? yield* NodeSocket.makeTls({ host: address.host, port: address.port, servername: address.host, openTimeout })
    : yield* NodeSocket.makeNet({ host: address.host, port: address.port, openTimeout })
  const suffix = (yield* Random.nextIntBetween(0, 0xffffff)).toString(16).padStart(6, "0")
  yield* makeMqttClient(socket, {
    clientId: `ot-gateway-watch-${suffix}`,
    ...(config.mqtt.username === undefined ? {} : { username: config.mqtt.username }),
    ...(password === undefined ? {} : { password }),
    subscriptions: [{ filter, qos: 0, retainAsPublished: true }],
    onConnect: () => Console.error(`watching ${filter} on ${config.mqtt.url} (Ctrl-C to stop)`),
    onMessage: (message) => Console.log(formatMessage(message, new Date()))
  })
  yield* Console.error(`connecting to ${config.mqtt.url}…`)
  return yield* Effect.never
}, Effect.scoped)
