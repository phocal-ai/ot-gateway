/**
 * Why the broker dropped the gateway, in words: a DISCONNECT reason code named (MQTT 5 §3.14.2.1), and a twin with
 * the same client id named as the likely cause when an MQTT 3.1.1 broker keeps closing the connection without one.
 */
import { describe, expect, it } from "vitest"
import { describeDisconnect, explainQuickDrops } from "../src/index.ts"

describe("describeDisconnect", () => {
  it("says a session taken over by another client with the same client id", () => {
    expect(describeDisconnect(0x8e, undefined)).toBe(
      "session taken over: another client connected with the same client id (set a client id no other client uses) (0x8e)"
    )
  })

  it("keeps the broker's reason string and the code of a reason it does not know", () => {
    expect(describeDisconnect(0x8b, "restarting")).toBe("server shutting down (0x8b) restarting")
    expect(describeDisconnect(0xa0, undefined)).toBe("0xa0")
  })
})

describe("explainQuickDrops", () => {
  it("names a client id in use twice once the broker closed the connection right after connecting three times", () => {
    expect(explainQuickDrops("connection closed", 2)).toBe("connection closed")
    expect(explainQuickDrops("connection closed", 3)).toContain("another client may be using the same client id")
  })

  it("leaves an error that already says why alone", () => {
    expect(explainQuickDrops("broker silent for 90 s", 5)).toBe("broker silent for 90 s")
  })
})
