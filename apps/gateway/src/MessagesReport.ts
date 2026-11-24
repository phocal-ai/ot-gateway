/**
 * `ot-gateway messages`: how many messages the running gateway published per topic, and how many reached the
 * broker, from its status page. Without `--since` the counts run since the gateway started (`/api/messages`); with
 * `--since 10m` they cover the last minutes (`/api/messages/window`), as far back as the gateway keeps a count per
 * topic per minute (`MESSAGE_WINDOW_MINUTES`, an hour), in whole minutes. A point's `$meta` line shows its publish
 * mode, from the point catalog, instead of the JSON cut at 80 characters; `--json` has the whole payload and
 * `publish` on the point's topics. A last line adds up the topics listed: values, `$meta`, health and all, and how
 * many of them reached the broker (`totals` in `--json`).
 */
import { MESSAGE_WINDOW_MINUTES, type MessageStatus, type MessageTotals, messageTotals } from "@ot-gateway/api"
import { Effect } from "effect"
import { withoutControls } from "./Discover.ts"
import { checkIdentity, gatewayName, type GatewayTarget } from "./GatewayTarget.ts"
import type { PointSelection } from "./HistoryReport.ts"
import { localTime, printJson, printResult } from "./Output.ts"
import { ago, askGateway, fetchGatewayStatus } from "./StatusReport.ts"

/** Payloads are cut here on the terminal; `--json` has them as the gateway keeps them (2,000 characters). */
const MAX_PAYLOAD = 80

/**
 * The messages under `prefix` (`site/building/`) that `selections` name: a device's topics, or a point's own topic
 * and the ones below it (`$meta`, `$set/result`). Every message under the prefix without a selection.
 */
export const selectMessages = (
  messages: ReadonlyArray<MessageStatus>,
  prefix: string,
  selections: ReadonlyArray<PointSelection>
) =>
  messages.filter((message) => {
    if (!message.topic.startsWith(prefix)) return false
    if (selections.length === 0) return true
    const rest = message.topic.slice(prefix.length)
    return selections.some((selection) => {
      const named = selection.point === undefined ? selection.device : `${selection.device}/${selection.point}`
      return rest === named || rest.startsWith(`${named}/`)
    })
  })

/** Each configured point's publish mode in words (`every read`, `on change ≥ 0.5`), by its value topic. */
export type PublishModes = ReadonlyMap<string, string>

/** The publish mode of the point whose value or `$meta` topic `topic` is; undefined for any other topic. */
const publishModeOf = (topic: string, modes: PublishModes) =>
  modes.get(topic.endsWith("/$meta") ? topic.slice(0, -"/$meta".length) : topic)

/**
 * One line per topic, aligned: the topic below the site and building, the counts, when the last went, its payload;
 * for a point's `$meta`, its publish mode instead of the payload.
 */
export const formatMessages = (
  messages: ReadonlyArray<MessageStatus>,
  prefix: string,
  now: number,
  modes: PublishModes = new Map()
) => {
  const width = Math.max(0, ...messages.map((message) => message.topic.length - prefix.length))
  const countWidth = Math.max(0, ...messages.map((message) => String(message.count).length))
  return messages.map((message) => {
    const flat = withoutControls(message.payload.replace(/\s+/g, " "))
    const mode = message.topic.endsWith("/$meta") ? publishModeOf(message.topic, modes) : undefined
    const payload =
      mode !== undefined ? `publish: ${mode}` : flat.length > MAX_PAYLOAD ? `${flat.slice(0, MAX_PAYLOAD)}…` : flat
    const lost = message.count - message.delivered
    return [
      `  ${withoutControls(message.topic.slice(prefix.length)).padEnd(width)}`,
      `${String(message.count).padStart(countWidth)} sent, ${message.delivered} reached the broker${lost > 0 ? ` (${lost} waiting or lost)` : ""},`,
      `last ${localTime(message.at, now)}${message.retained ? " retained" : ""}  ${payload}`
    ].join("  ")
  })
}

/**
 * The topics listed added up: `  total  4 sent (3 values, 1 $meta, 0 health), 2 reached the broker (2 waiting or
 * lost)`, with command results and other topics named only when there are some.
 */
export const formatTotals = (totals: MessageTotals) => {
  const lost = totals.all - totals.delivered
  const kinds = [
    `${totals.values} value(s)`,
    `${totals.meta} $meta`,
    `${totals.health} health`,
    ...(totals.other > 0 ? [`${totals.other} other`] : [])
  ].join(", ")
  return `  total: ${totals.all} sent (${kinds}), ${totals.delivered} reached the broker${lost > 0 ? ` (${lost} waiting or lost)` : ""}`
}

export interface MessagesOptions {
  readonly json?: boolean
  /** `--since` as typed (`10m`) and in ms, at most `MESSAGE_WINDOW_MINUTES`: the counts of that window only. */
  readonly since?: string | undefined
  readonly sinceMs?: number | undefined
}

/** The longest `--since` the gateway can count, in ms. */
export const MESSAGE_WINDOW_MS = MESSAGE_WINDOW_MINUTES * 60_000

/**
 * Prints the messages the gateway `target` expects published, per topic, since it started or in the last
 * `options.sinceMs`: all under its site and building, or the ones `selections` name.
 */
export const messagesReport = Effect.fn("messagesReport")(function* (
  target: GatewayTarget,
  selections: ReadonlyArray<PointSelection>,
  options: MessagesOptions = {}
) {
  const status = yield* fetchGatewayStatus(target.url, "none")
  yield* checkIdentity(target, status)
  const sinceMs = options.sinceMs
  const answer = yield* askGateway(target.url, (client) =>
    sinceMs === undefined
      ? client.status.messages()
      : client.status.messagesWindow({ query: { since: status.now - sinceMs } })
  )
  const catalog = yield* askGateway(target.url, (client) => client.status.points())
  const modes: PublishModes = new Map(catalog.points.map((point) => [point.topic, point.publish]))
  const prefix = `${status.site}/${status.building}/`
  const messages = selectMessages(answer.messages, prefix, selections)
  const totals = messageTotals(messages)
  const gateway = { site: status.site, building: status.building, id: status.id }
  if (options.json === true) {
    return yield* printJson({
      ok: true,
      gateway,
      now: status.now,
      since: status.since,
      ...(answer.window === undefined ? {} : { window: answer.window }),
      droppedTopics: answer.droppedTopics,
      totals,
      messages: messages.map((message) => {
        const mode = publishModeOf(message.topic, modes)
        return mode === undefined ? message : { ...message, publish: mode }
      })
    })
  }
  const started = `since it started at ${localTime(status.since, status.now)} (${ago(status.now - status.since)} ago)`
  // The window as the gateway counted it: whole minutes, and never before its start.
  const window =
    answer.window === undefined
      ? started
      : answer.window.from <= status.since
        ? `in the last ${options.since ?? ago(answer.window.to - answer.window.from)}, ${started}`
        : `in the last ${options.since ?? ago(answer.window.to - answer.window.from)} (from ${localTime(answer.window.from, status.now)}, in whole minutes)`
  const why =
    answer.window === undefined
      ? `  (since the gateway started; --since 10m counts the last minutes, up to ${MESSAGE_WINDOW_MINUTES}m back)`
      : undefined
  yield* printResult(
    [
      `${gatewayName(gateway)} at ${target.url}: messages per topic ${window}`,
      ...(messages.length === 0
        ? [
            answer.window !== undefined
              ? "  nothing published in this window"
              : selections.length === 0
                ? "  nothing published yet"
                : "  nothing published on these topics yet: ot-gateway status lists the devices"
          ]
        : [...formatMessages(messages, prefix, status.now, modes), formatTotals(totals)]),
      ...(why === undefined ? [] : [why]),
      ...(answer.droppedTopics > 0
        ? [`  (${answer.droppedTopics} more topic(s) not kept: the gateway keeps the latest message of 2000 topics)`]
        : [])
    ].join("\n")
  )
})
