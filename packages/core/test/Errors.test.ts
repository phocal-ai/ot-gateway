import { describe, expect, it } from "@effect/vitest"
import { DatagramSocketClosedError, DatagramSocketError, DatagramSocketOpenError } from "effect/socket/DatagramSocket"
import { SocketCloseError, SocketError, SocketOpenError, SocketReadError } from "effect/socket/Socket"
import { SocketServerError, SocketServerOpenError } from "effect/socket/SocketServer"
import { describeDatagramSocketError, describeFailure, describeSocketError } from "../src/index.ts"

/** Node's error for one refused address. */
const refusedAt = (address: string) =>
  Object.assign(new Error(`connect ECONNREFUSED ${address}:1883`), { code: "ECONNREFUSED" })

/** A failed open, as the socket reports it. */
const open = (cause: Error) =>
  describeSocketError(new SocketError({ reason: new SocketOpenError({ kind: "Unknown", cause }) }))

/** A Node system error with the fields Node sets on it. */
const system = (message: string, fields: Record<string, string | number>) => Object.assign(new Error(message), fields)

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

  it("says in words who refused or did not answer, when Node names the address", () => {
    expect(
      open(system("connect ECONNREFUSED 127.0.0.1:5020", { code: "ECONNREFUSED", address: "127.0.0.1", port: 5020 }))
    ).toBe("could not connect: connection refused by 127.0.0.1:5020")
    expect(open(system("connect ECONNREFUSED ::1:502", { code: "ECONNREFUSED", address: "::1", port: 502 }))).toBe(
      "could not connect: connection refused by [::1]:502"
    )
    expect(open(system("connect ETIMEDOUT 10.0.0.9:502", { code: "ETIMEDOUT", address: "10.0.0.9", port: 502 }))).toBe(
      "could not connect: no answer from 10.0.0.9:502"
    )
    expect(open(system("connect EHOSTUNREACH 10.0.0.9:502", { code: "EHOSTUNREACH", address: "10.0.0.9" }))).toBe(
      "could not connect: host 10.0.0.9 unreachable"
    )
    expect(open(system("getaddrinfo ENOTFOUND plc.local", { code: "ENOTFOUND", hostname: "plc.local" }))).toBe(
      "could not connect: host name plc.local not found"
    )
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

describe("describeDatagramSocketError", () => {
  it("says when the port is taken, the usual reason a BACnet/IP socket does not open", () => {
    const inUse = Object.assign(new Error("bind EADDRINUSE 0.0.0.0:47808"), { code: "EADDRINUSE" })
    expect(
      describeDatagramSocketError(
        new DatagramSocketError({ reason: new DatagramSocketOpenError({ kind: "AddressInUse", cause: inUse }) })
      )
    ).toBe("could not open the UDP socket, the port is in use: bind EADDRINUSE 0.0.0.0:47808")
    expect(describeDatagramSocketError(new DatagramSocketError({ reason: new DatagramSocketClosedError() }))).toBe(
      "UDP socket closed"
    )
  })
})

/** Node's error for a port another program holds. */
const inUse = (address: string, port: number) =>
  system(`bind EADDRINUSE ${address}:${port}`, { code: "EADDRINUSE", address, port })

describe("describeFailure", () => {
  it("describes a UDP socket that could not bind, whose own message is empty", () => {
    const error = new DatagramSocketError({
      reason: new DatagramSocketOpenError({ kind: "AddressInUse", cause: inUse("127.0.0.1", 47_809) })
    })
    expect(error.message).toBe("")
    expect(describeFailure(error)).toBe("could not open the UDP socket: 127.0.0.1:47809 is in use by another program")
  })

  it("describes a server socket that could not listen, whose own message is a bare Open", () => {
    const error = new SocketServerError({
      reason: new SocketServerOpenError({ cause: inUse("127.0.0.1", 1883) })
    })
    expect(describeFailure(error)).toBe("could not listen: 127.0.0.1:1883 is in use by another program")
  })

  it("keeps any other error's message, and names one without a message by its tag and cause", () => {
    expect(describeFailure(new Error("config not found"))).toBe("config not found")
    const silent = Object.assign(new Error(""), { _tag: "SomethingFailed", cause: new Error("disk full") })
    expect(describeFailure(silent)).toBe("SomethingFailed: disk full")
    expect(describeFailure(new Error(""))).toBe("failed")
  })
})
