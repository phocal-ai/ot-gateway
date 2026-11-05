/**
 * The page's helpers: what kind of message a topic carries, by its shape.
 */
import { describe, expect, it } from "@effect/vitest"
import { topicKind } from "../src/lib/status.ts"

describe("topicKind", () => {
  it("tells values, metadata, health and command results apart", () => {
    expect(topicKind("demo-site/b1/main-meter/active-power")).toBe("value")
    expect(topicKind("demo-site/b1/main-meter/active-power/$meta")).toBe("metadata")
    expect(topicKind("demo-site/b1/$gateway/main/health")).toBe("health")
    expect(topicKind("demo-site/b1/ahu-1/setpoint/$set/result")).toBe("command result")
    expect(topicKind("demo-site/b1/something")).toBe("other")
  })
})
