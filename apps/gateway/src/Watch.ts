/**
 * `ot-gateway watch`: what the gateway publishes, as it arrives at the broker in the config. It subscribes to
 * `site/building/#` (or a filter of its own) with a client id of its own, so it runs next to the gateway, and
 * prints one line per message: the time, `retained` for what the broker kept, the topic and the payload. With
 * `--json` the line is a JSON object (NDJSON), for scripts and agents. When the broker connection breaks, a line
 * says so, and another when it is back (`{"event":"broker-disconnected"}`, `{"event":"broker-connected"}`).
 *
 * A retained message the broker keeps from another gateway, or for a device or point the config does not have
 * (an old config's, say), is marked with whose it is (`"stale"` in JSON), and the first one prints, once, how to
 * clear it: `ot-gateway publish <topic> --retain`.
 */
import { type GatewayConfig, monotonicMillis } from "@ot-gateway/core"
import type { InboundMessage } from "@ot-gateway/mqtt"
import { Console, Duration, Effect } from "effect"
import { BrokerCommandError, brokerClient, firstDialOf } from "./Broker.ts"
import { withoutControls } from "./Discover.ts"
import { localTime, printResult } from "./Output.ts"
import { metaGateway } from "./StaleMeta.ts"
import { ago } from "./StatusReport.ts"

/** Payloads are cut here on the terminal; the status page and any MQTT client show them whole. */
const MAX_PAYLOAD = 300

/** Everything under the config's site and building: values, `$meta`, the gateway's health and command results. */
export const watchFilter = (config: Pick<GatewayConfig, "site" | "building">) => `${config.site}/${config.building}/#`

/** What `stale` reads of a config: the gateway's id, where it publishes, and its devices and points. */
export type WatchedConfig = Pick<GatewayConfig, "id" | "site" | "building"> & {
  readonly devices: ReadonlyArray<{ readonly id: string; readonly points: ReadonlyArray<{ readonly id: string }> }>
}

/**
 * Why a retained message is not the running gateway's, in a few words: `from gateway b`, `not in this config`. Only
 * under the config's site and building (another filter's topics cannot be told apart); undefined for a live
 * message, an empty one (that clears a topic) and everything the config has.
 */
export const staleReason = (
  config: WatchedConfig,
  message: Pick<InboundMessage, "topic" | "payload" | "retain">
): string | undefined => {
  if (!message.retain || message.payload === "") return undefined
  const [site, building, device, point, ...rest] = message.topic.split("/")
  if (site !== config.site || building !== config.building || device === undefined) return undefined
  // `site/building/$gateway/<id>/health`: the health of a gateway, maybe one long gone.
  if (device === "$gateway") return point === config.id ? undefined : `from gateway ${point ?? ""}`
  const owner = rest[0] === "$meta" ? metaGateway(message.payload) : undefined
  if (owner !== undefined && owner !== config.id) return `from gateway ${owner}`
  const configured = config.devices.find((candidate) => candidate.id === device)
  if (configured === undefined) return "device not in this config"
  if (point !== undefined && !configured.points.some((candidate) => candidate.id === point)) {
    return "point not in this config"
  }
  return undefined
}

/** Printed once, at the first stale retained message. */
export const clearHint =
  "-- marked retained messages are kept by the broker from another gateway or an older config; if nothing needs them, clear one with: ot-gateway publish <topic> --retain"

/**
 * One line for a message: local time, a retained marker (with why it is stale, if it is), the topic and the payload
 * on one line. Anyone who may publish to the broker chooses the topic and the payload, so their control characters
 * never reach the terminal: line breaks and tabs become a space, the rest `?`.
 */
export const formatMessage = (
  message: Pick<InboundMessage, "topic" | "payload" | "retain">,
  at: Date,
  stale?: string
) => {
  const time = localTime(at)
  const flat = withoutControls(message.payload.replace(/\s*\n\s*/g, " ").replace(/[\t\r]/g, " "))
  const payload = flat.length > MAX_PAYLOAD ? `${flat.slice(0, MAX_PAYLOAD)}…` : flat
  const retained = message.retain ? (stale === undefined ? "retained " : `retained (${withoutControls(stale)}) `) : ""
  return `${time} ${retained}${withoutControls(message.topic)} ${payload}`
}

/** One message as a JSON line: the payload parsed when it is JSON, as the gateway's own messages are, whole. */
export const messageRecord = (
  message: Pick<InboundMessage, "topic" | "payload" | "retain">,
  at: Date,
  stale?: string
) => {
  let payload: unknown = message.payload
  try {
    payload = JSON.parse(message.payload)
  } catch {
    // Not JSON (a plain MQTT client's message): kept as the string it is.
  }
  return JSON.stringify({
    at: at.toISOString(),
    topic: message.topic,
    retained: message.retain,
    ...(stale === undefined ? {} : { stale }),
    payload
  })
}

export interface WatchOptions {
  /** A topic filter instead of the config's site and building (`#` for everything on the broker). */
  readonly topic?: string | undefined
  /** Stop after this many seconds instead of at Ctrl-C: for scripts and agents, which cannot press it. */
  readonly seconds?: number | undefined
  /** One JSON object per line on stdout (`messageRecord`) instead of the terminal's lines. */
  readonly json?: boolean | undefined
}

/**
 * Prints the broker's messages until interrupted (Ctrl-C) or for `seconds`, reconnecting as the gateway does.
 * The CLI runs in a container without Node on the machine, where killing the docker client leaves the
 * container running: a watch that ends by itself needs no one to stop it. With `seconds` a first dial that fails
 * fails the watch (`BrokerCommandError`), so "never connected" does not look like "connected, nothing arrived";
 * without, someone is watching and it keeps trying.
 */
export const watch = Effect.fn("watch")(function* (config: GatewayConfig, options: WatchOptions = {}) {
  const filter = options.topic ?? watchFilter(config)
  const json = options.json === true
  /** Whether the watch has had a connection, and while it has none since then: since when (monotonic) and why. */
  let everConnected = false
  let away: { readonly since: number; readonly at: Date; readonly error: string } | undefined
  let hinted = false
  const say = (record: BrokerRecord, at: Date) =>
    json ? printResult(brokerRecordLine(record, at)) : Console.log(formatBrokerRecord(record, at))
  const client = yield* brokerClient(config.mqtt, "watch", {
    subscriptions: [{ filter, qos: 0, retainAsPublished: true }],
    onConnect: () =>
      Effect.gen(function* () {
        const was = away
        away = undefined
        if (everConnected && was !== undefined) {
          const downMs = (yield* monotonicMillis) - was.since
          yield* say({ event: "broker-connected", downMs }, new Date())
          return
        }
        everConnected = true
        yield* Console.error(
          `watching ${filter} on ${config.mqtt.url} (${options.seconds === undefined ? "Ctrl-C to stop" : `for ${options.seconds} s`})`
        )
      }),
    // Every failed redial calls this; only the first of an outage is printed. Before the first connect, `--seconds`
    // fails on the first dial anyway, and without it the client's own warning says why it keeps trying.
    onDisconnected: (failure) =>
      Effect.gen(function* () {
        if (away !== undefined || !everConnected) return
        const at = new Date()
        away = { since: yield* monotonicMillis, at, error: failure.error }
        yield* say({ event: "broker-disconnected", error: failure.error }, at)
      }),
    onMessage: (message) =>
      Effect.gen(function* () {
        const stale = staleReason(config, message)
        const at = new Date()
        yield* json ? printResult(messageRecord(message, at, stale)) : Console.log(formatMessage(message, at, stale))
        if (stale !== undefined && !hinted) {
          hinted = true
          yield* Console.error(clearHint)
        }
      })
  })
  yield* Console.error(`connecting to ${config.mqtt.url}…`)
  if (options.seconds === undefined) return yield* Effect.never
  yield* firstDialOf(client, config.mqtt.url)
  yield* Effect.sleep(Duration.seconds(options.seconds))
  // A watch that ends without its broker saw only part of the time it was asked for: say so with the exit code.
  const lost = away
  if (lost !== undefined) {
    return yield* new BrokerCommandError({
      message: `lost ${config.mqtt.url} at ${localTime(lost.at)} and it did not come back: ${lost.error}`
    })
  }
}, Effect.scoped)

/** What `watch` says about its own connection, between the messages. */
export type BrokerRecord =
  | { readonly event: "broker-disconnected"; readonly error: string }
  | { readonly event: "broker-connected"; readonly downMs: number }

/** The line `watch` prints when it loses or regains the broker: local time, then what happened. */
export const formatBrokerRecord = (record: BrokerRecord, at: Date) =>
  record.event === "broker-disconnected"
    ? `${localTime(at)} -- lost the broker: ${withoutControls(record.error)}; reconnecting`
    : `${localTime(at)} -- broker back after ${ago(record.downMs)}`

/** The same as a JSON line for `--json`, next to the messages': `at`, then the event. */
export const brokerRecordLine = (record: BrokerRecord, at: Date) => JSON.stringify({ at: at.toISOString(), ...record })
