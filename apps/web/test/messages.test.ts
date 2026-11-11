import { describe, expect, it } from "@effect/vitest"
import type { MessageStatus } from "@ot-gateway/api"
import { countKinds, countsNote, matchesMessage, messageRanges, windowSince } from "../src/lib/messages.ts"

describe("message counts over a window", () => {
  it("offers since start, 15 and 60 minutes, and starts a window on the gateway's clock", () => {
    expect(messageRanges.map((range) => range.label)).toEqual(["Since start", "15 min", "60 min"])
    expect(windowSince(15, 1_000_000_000)).toBe(1_000_000_000 - 900_000)
  })

  it("says what the column counts, and the 60-minute limit for a window", () => {
    const started = new Date(2026, 10, 11, 8, 2, 11).getTime()
    expect(countsNote({ messages: [], droppedTopics: 0 }, started)).toBe(
      "Messages counts every message since the gateway started at 08:02."
    )
    const from = new Date(2026, 10, 11, 14, 27).getTime()
    const window = { from, to: from + 900_000 }
    const note = countsNote({ messages: [], droppedTopics: 0, window }, started)
    expect(note).toContain("from 14:27 to 14:42, in whole minutes")
    expect(note).toContain("the last 60 minutes")
    // A window that reaches back before the gateway's start counts from the start.
    expect(countsNote({ messages: [], droppedTopics: 0, window }, from + 120_000)).toContain(
      "from the gateway's start at 14:29 to 14:42"
    )
  })
})

const message = (topic: string, payload = "{}"): MessageStatus => ({
  topic,
  payload,
  truncated: false,
  retained: false,
  at: 0,
  count: 1,
  delivered: 1
})

const value = message("site/hq/ahu-1/supply-temp", '{"value":21.5}')
const meta = message("site/hq/ahu-1/supply-temp/$meta", '{"unit":"unit:DEG_C"}')
const health = message("site/hq/$gateway/gw-1/health", '{"status":"online"}')

describe("matchesMessage", () => {
  it("keeps everything with no query and every kind", () => {
    expect([value, meta, health].filter((m) => matchesMessage(m, { query: "", kind: "all" }))).toEqual([
      value,
      meta,
      health
    ])
  })

  it("keeps one kind of topic", () => {
    expect([value, meta, health].filter((m) => matchesMessage(m, { query: "", kind: "metadata" }))).toEqual([meta])
  })

  it("needs every word in the topic or the payload, in any case", () => {
    expect([value, meta, health].filter((m) => matchesMessage(m, { query: "AHU-1 deg_c", kind: "all" }))).toEqual([
      meta
    ])
    expect(matchesMessage(health, { query: "online", kind: "all" })).toBe(true)
    expect(matchesMessage(health, { query: "online", kind: "value" })).toBe(false)
  })
})

describe("countKinds", () => {
  it("counts the topics of each kind", () => {
    const counts = countKinds([value, meta, health, message("site/hq/ahu-1/fan")])
    expect(counts.get("value")).toBe(2)
    expect(counts.get("metadata")).toBe(1)
    expect(counts.get("health")).toBe(1)
    expect(counts.has("command result")).toBe(false)
  })
})
