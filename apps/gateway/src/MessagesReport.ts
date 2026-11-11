/**
 * `ot-gateway messages`: how many messages the running gateway published per topic, and how many reached the
 * broker, from its status page (`/api/messages`). The counts run since the gateway started, and the report says so:
 * the gateway keeps no per-window count of what it sent (its history keeps reads, not publishes). For "how many in
 * the last 10 minutes", ask twice and subtract, or `ot-gateway history` for the reads.
 */
import type { MessageStatus } from "@ot-gateway/api"
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

/** One line per topic, aligned: the topic below the site and building, the counts, when the last went, its payload. */
export const formatMessages = (messages: ReadonlyArray<MessageStatus>, prefix: string, now: number) => {
  const width = Math.max(0, ...messages.map((message) => message.topic.length - prefix.length))
  const countWidth = Math.max(0, ...messages.map((message) => String(message.count).length))
  return messages.map((message) => {
    const flat = withoutControls(message.payload.replace(/\s+/g, " "))
    const payload = flat.length > MAX_PAYLOAD ? `${flat.slice(0, MAX_PAYLOAD)}…` : flat
    const lost = message.count - message.delivered
    return [
      `  ${withoutControls(message.topic.slice(prefix.length)).padEnd(width)}`,
      `${String(message.count).padStart(countWidth)} sent, ${message.delivered} reached the broker${lost > 0 ? ` (${lost} waiting or lost)` : ""},`,
      `last ${localTime(message.at, now)}${message.retained ? " retained" : ""}  ${payload}`
    ].join("  ")
  })
}

export interface MessagesOptions {
  readonly json?: boolean
}

/**
 * Prints the messages the gateway `target` expects published, per topic, since it started: all under its site and
 * building, or the ones `selections` name.
 */
export const messagesReport = Effect.fn("messagesReport")(function* (
  target: GatewayTarget,
  selections: ReadonlyArray<PointSelection>,
  options: MessagesOptions = {}
) {
  const status = yield* fetchGatewayStatus(target.url, "none")
  yield* checkIdentity(target, status)
  const answer = yield* askGateway(target.url, (client) => client.status.messages())
  const prefix = `${status.site}/${status.building}/`
  const messages = selectMessages(answer.messages, prefix, selections)
  const gateway = { site: status.site, building: status.building, id: status.id }
  if (options.json === true) {
    return yield* printJson({
      ok: true,
      gateway,
      now: status.now,
      since: status.since,
      droppedTopics: answer.droppedTopics,
      messages
    })
  }
  const window = `since it started at ${localTime(status.since, status.now)} (${ago(status.now - status.since)} ago)`
  yield* printResult(
    [
      `${gatewayName(gateway)} at ${target.url}: messages per topic ${window}`,
      ...(messages.length === 0
        ? [
            selections.length === 0
              ? "  nothing published yet"
              : "  nothing published on these topics yet: ot-gateway status lists the devices"
          ]
        : formatMessages(messages, prefix, status.now)),
      ...(answer.droppedTopics > 0
        ? [`  (${answer.droppedTopics} more topic(s) not kept: the gateway keeps the latest message of 2000 topics)`]
        : [])
    ].join("\n")
  )
})
