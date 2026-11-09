import { describe, expect, it } from "@effect/vitest"
import type { MessageStatus } from "@ot-gateway/api"
import { countKinds, matchesMessage } from "../src/lib/messages.ts"

const message = (topic: string, payload = "{}"): MessageStatus => ({
  topic,
  payload,
  truncated: false,
  retained: false,
  at: 0,
  count: 1
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
