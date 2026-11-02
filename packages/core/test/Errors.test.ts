import { describe, expect, it } from "@effect/vitest"
import { SocketCloseError, SocketError, SocketOpenError, SocketReadError } from "effect/socket/Socket"
import { describeSocketError } from "../src/index.ts"

/** Node's error for one refused address. */
const refusedAt = (address: string) =>
  Object.assign(new Error(`connect ECONNREFUSED ${address}:1883`), { code: "ECONNREFUSED" })

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

  it("spells out an AggregateError, which Node uses when every address of a name refused", () => {
    const aggregate = Object.assign(new AggregateError([refusedAt("::1"), refusedAt("127.0.0.1")], ""), {
      code: "ECONNREFUSED"
    })
    expect(
      describeSocketError(new SocketError({ reason: new SocketOpenError({ kind: "Unknown", cause: aggregate }) }))
    ).toBe("could not connect: connect ECONNREFUSED ::1:1883; connect ECONNREFUSED 127.0.0.1:1883")
  })

  it("adds the cause of a read failure when there is one", () => {
    expect(
      describeSocketError(new SocketError({ reason: new SocketReadError({ cause: new Error("ECONNRESET") }) }))
    ).toBe("read failed: ECONNRESET")
    expect(describeSocketError(new SocketError({ reason: new SocketReadError({ cause: "?" }) }))).toBe("read failed")
  })
})
