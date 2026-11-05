/**
 * The page's helpers: what kind of message a topic carries, by its shape, and the clock its ages count on.
 */
import { describe, expect, it } from "@effect/vitest"
import { ago, gatewayNow, topicKind } from "../src/lib/status.ts"

describe("topicKind", () => {
  it("tells values, metadata, health and command results apart", () => {
    expect(topicKind("demo-site/b1/main-meter/active-power")).toBe("value")
    expect(topicKind("demo-site/b1/main-meter/active-power/$meta")).toBe("metadata")
    expect(topicKind("demo-site/b1/$gateway/main/health")).toBe("health")
    expect(topicKind("demo-site/b1/ahu-1/setpoint/$set/result")).toBe("command result")
    expect(topicKind("demo-site/b1/something")).toBe("other")
  })
})

describe("gatewayNow", () => {
  const serverNow = 1_793_881_441_000
  const receivedAt = 50_000 // a browser clock far off the gateway's

  it("moves the gateway's time on by the seconds since its answer, one at a time", () => {
    expect(gatewayNow(serverNow, receivedAt, receivedAt)).toBe(serverNow)
    expect(ago(serverNow - 1000, gatewayNow(serverNow, receivedAt, receivedAt + 1000))).toBe("2 s ago")
    expect(ago(serverNow - 1000, gatewayNow(serverNow, receivedAt, receivedAt + 2000))).toBe("3 s ago")
  })

  it("keeps counting while the gateway does not answer", () => {
    expect(ago(serverNow, gatewayNow(serverNow, receivedAt, receivedAt + 90_000))).toBe("2 min ago")
  })

  it("never goes back when the browser's clock steps backwards", () => {
    expect(gatewayNow(serverNow, receivedAt, receivedAt - 5000)).toBe(serverNow)
  })
})
