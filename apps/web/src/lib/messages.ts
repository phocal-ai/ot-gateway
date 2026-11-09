/**
 * Filtering the Messages tab: the latest message on each topic, narrowed by what a topic carries and by text.
 */
import type { MessageStatus } from "@ot-gateway/api"
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

/** How many topics there are of each kind, for the kind filter's options. */
export const countKinds = (messages: ReadonlyArray<MessageStatus>): ReadonlyMap<TopicKind, number> => {
  const counts = new Map<TopicKind, number>()
  for (const message of messages) {
    const kind = topicKind(message.topic)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return counts
}
