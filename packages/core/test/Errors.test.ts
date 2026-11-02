import { describe, expect, it } from "@effect/vitest"
import { SocketCloseError, SocketError, SocketOpenError, SocketReadError } from "effect/socket/Socket"
import { describeSocketError } from "../src/index.ts"

describe("describeSocketError", () => {
  it("names a normal close instead of printing the bare code", () => {
    expect(describeSocketError(new SocketError({ reason: new SocketCloseError({ code: 1000 }) }))).toBe(
      "connection closed by the peer"
    )
    expect(
      describeSocketError(new SocketError({ reason: new SocketCloseError({ code: 1006, closeReason: "abnormal" }) }))
    ).toBe("connection closed with code 1006: abnormal")
  })

  it("keeps the operating system's reason for a failed open", () => {
    const refused = new Error("connect ECONNREFUSED 127.0.0.1:1883")
    expect(
      describeSocketError(new SocketError({ reason: new SocketOpenError({ kind: "Unknown", cause: refused }) }))
    ).toBe("could not connect: connect ECONNREFUSED 127.0.0.1:1883")
    expect(
      describeSocketError(new SocketError({ reason: new SocketOpenError({ kind: "Timeout", cause: undefined }) }))
    ).toBe("timed out opening the connection")
  })

  it("adds the cause of a read failure when there is one", () => {
    expect(
      describeSocketError(new SocketError({ reason: new SocketReadError({ cause: new Error("ECONNRESET") }) }))
    ).toBe("read failed: ECONNRESET")
    expect(describeSocketError(new SocketError({ reason: new SocketReadError({ cause: "?" }) }))).toBe("read failed")
  })
})
