/**
 * `ot-gateway watch`: what the gateway publishes, as it arrives at the broker in the config. It subscribes to
 * `site/building/#` (or a filter of its own) with a client id of its own, so it runs next to the gateway, and
 * prints one line per message: the time, `retained` for what the broker kept, the topic and the payload.
 */
import type { GatewayConfig } from "@ot-gateway/core"
import type { InboundMessage } from "@ot-gateway/mqtt"
import { Console, Duration, Effect } from "effect"
import { brokerClient } from "./Broker.ts"

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
  /** Stop after this many seconds instead of at Ctrl-C: for scripts and agents, which cannot press it. */
  readonly seconds?: number | undefined
}

/**
 * Prints the broker's messages until interrupted (Ctrl-C) or for `seconds`, reconnecting as the gateway does.
 * The CLI runs in a container without Node on the machine, where killing the docker client leaves the
 * container running: a watch that ends by itself needs no one to stop it.
 */
export const watch = Effect.fn("watch")(function* (config: GatewayConfig, options: WatchOptions = {}) {
  const filter = options.topic ?? watchFilter(config)
  yield* brokerClient(config.mqtt, "watch", {
    subscriptions: [{ filter, qos: 0, retainAsPublished: true }],
    onConnect: () =>
      Console.error(
        `watching ${filter} on ${config.mqtt.url} (${options.seconds === undefined ? "Ctrl-C to stop" : `for ${options.seconds} s`})`
      ),
    onMessage: (message) => Console.log(formatMessage(message, new Date()))
  })
  yield* Console.error(`connecting to ${config.mqtt.url}…`)
  if (options.seconds === undefined) return yield* Effect.never
  yield* Effect.sleep(Duration.seconds(options.seconds))
}, Effect.scoped)
