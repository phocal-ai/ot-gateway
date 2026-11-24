/**
 * Filtering the Messages tab: the latest message on each topic, narrowed by what a topic carries and by text.
 */
import { MESSAGE_WINDOW_MINUTES, type Messages, type MessageStatus, messageTotals } from "@ot-gateway/api"
import { formatNumber } from "./format"
import { type TopicKind, topicKind } from "./status"

export interface MessageFilter {
  /** Words that must each appear in the topic or the payload, in any case. */
  readonly query: string
  /** One kind of topic, or every kind. */
  readonly kind: TopicKind | "all"
}

export const matchesMessage = (message: MessageStatus, filter: MessageFilter) => {
  if (filter.kind !== "all" && topicKind(message.topic) !== filter.kind) return false
  const words = filter.query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
  if (words.length === 0) return true
  const text = `${message.topic} ${message.payload}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

/**
 * What the Messages column counts: since the gateway started (`/api/messages`), or the last 15 or 60 minutes
 * (`/api/messages/window`), the most the gateway keeps per-minute counts for (`MESSAGE_WINDOW_MINUTES`).
 */
export const messageRanges = [
  { id: "start", label: "Since start", minutes: undefined },
  { id: "15m", label: "15 min", minutes: 15 },
  { id: "60m", label: `${MESSAGE_WINDOW_MINUTES} min`, minutes: MESSAGE_WINDOW_MINUTES }
] as const
export type MessageRange = (typeof messageRanges)[number]

/** Where a window of `minutes` starts, on the gateway's clock (`now`, from its status). */
export const windowSince = (minutes: number, now: number) => now - minutes * 60_000

/**
 * What the Messages column counts, under the table: "since the gateway started at 08:02", or "from 14:27 to 14:42,
 * in whole minutes, …" for a window, which starts at the gateway's start when that is later (`startedAt`, Unix ms).
 */
export const countsNote = (answer: Messages, startedAt: number | undefined) => {
  if (answer.window === undefined)
    return startedAt === undefined
      ? "Messages counts every message since the gateway started."
      : `Messages counts every message since the gateway started at ${minuteClock(startedAt)}.`
  const from =
    startedAt !== undefined && startedAt > answer.window.from
      ? `the gateway's start at ${minuteClock(startedAt)}`
      : minuteClock(answer.window.from)
  return `Messages counts from ${from} to ${minuteClock(answer.window.to)}, in whole minutes, and lists only topics with a message in that time: the gateway keeps counts per minute for the last ${MESSAGE_WINDOW_MINUTES} minutes.`
}

/** 14:27 on the 24-hour clock, as a window's minute edges are. */
const minuteClock = (at: number) =>
  new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })

/** How many topics there are of each kind, for the kind filter's options. */
export const countKinds = (messages: ReadonlyArray<MessageStatus>): ReadonlyMap<TopicKind, number> => {
  const counts = new Map<TopicKind, number>()
  for (const message of messages) {
    const kind = topicKind(message.topic)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return counts
}

const plural = (count: number, one: string, many: string) => `${formatNumber(count)} ${count === 1 ? one : many}`

/**
 * The topics shown added up, under the table, as `ot-gateway messages` ends: "1,204 messages on 12 topics: 1,180
 * values, 12 metadata, 12 health; 1,204 reached the broker." Undefined without a topic.
 */
export const totalsNote = (messages: ReadonlyArray<MessageStatus>) => {
  if (messages.length === 0) return undefined
  const totals = messageTotals(messages)
  const kinds = [
    plural(totals.values, "value", "values"),
    `${formatNumber(totals.meta)} metadata`,
    `${formatNumber(totals.health)} health`,
    ...(totals.other > 0 ? [`${formatNumber(totals.other)} other`] : [])
  ].join(", ")
  const lost = totals.all - totals.delivered
  return `${plural(totals.all, "message", "messages")} on ${plural(messages.length, "topic", "topics")}: ${kinds}; ${formatNumber(totals.delivered)} reached the broker${lost > 0 ? `, ${formatNumber(lost)} waiting or lost` : ""}.`
}
