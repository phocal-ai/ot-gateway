/**
 * NPDU (clause 6.2), APDU (clause 20.1) and whole BACnet/IP frames.
 */
import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import {
  type Apdu,
  BvlcFunction,
  decodeApdu,
  decodeFrame,
  decodeNpdu,
  encodeApdu,
  encodeBvlc,
  encodeFrame,
  encodeNpdu,
  type Npdu
} from "../src/index.ts"

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ")

describe("NPDU", () => {
  it("encodes a local confirmed request as version and control only", () => {
    const npdu: Npdu = { expectingReply: true, priority: 0, payload: Uint8Array.of(0xaa) }
    expect(hex(encodeNpdu(npdu))).toBe("01 04 aa")
    expect(decodeNpdu(encodeNpdu(npdu))).toEqual(Result.succeed(npdu))
  })

  it("round-trips routing information and priority", () => {
    const npdu: Npdu = {
      expectingReply: false,
      priority: 3,
      destination: { network: 0xffff, address: new Uint8Array(0), hopCount: 255 },
      source: { network: 5, address: Uint8Array.of(0x0a, 0x00, 0x00, 0x05, 0xba, 0xc0) },
      payload: Uint8Array.of(1, 2)
    }
    expect(decodeNpdu(encodeNpdu(npdu))).toEqual(Result.succeed(npdu))
  })

  it("rejects another NPDU version", () => {
    expect(Result.isFailure(decodeNpdu(Uint8Array.of(0x02, 0x00)))).toBe(true)
  })
})

describe("APDU", () => {
  it("encodes a confirmed request header (Annex F ReadProperty example)", () => {
    const apdu: Apdu = {
      _tag: "ConfirmedRequest",
      invokeId: 1,
      service: 12,
      maxApdu: 206,
      segmentedResponseAccepted: false,
      body: Uint8Array.of(0x0c, 0x00, 0x00, 0x00, 0x05, 0x19, 0x55)
    }
    expect(hex(encodeApdu(apdu))).toBe("00 02 01 0c 0c 00 00 00 05 19 55")
    expect(decodeApdu(encodeApdu(apdu))).toEqual(Result.succeed(apdu))
  })

  it.each<Apdu>([
    { _tag: "UnconfirmedRequest", service: 8, body: new Uint8Array(0) },
    { _tag: "SimpleAck", invokeId: 9, service: 15 },
    { _tag: "ComplexAck", invokeId: 2, service: 14, body: Uint8Array.of(1) },
    {
      _tag: "ComplexAck",
      invokeId: 2,
      service: 14,
      segment: { sequenceNumber: 0, moreFollows: true, windowSize: 4 },
      body: Uint8Array.of(1)
    },
    { _tag: "SegmentAck", invokeId: 3, negative: true, fromServer: false, sequenceNumber: 1, windowSize: 1 },
    { _tag: "Error", invokeId: 4, service: 12, body: Uint8Array.of(0x91, 0x02, 0x91, 0x20) },
    { _tag: "Reject", invokeId: 5, reason: 9 },
    { _tag: "Abort", invokeId: 6, reason: 4, fromServer: true }
  ])("round-trips $_tag", (apdu) => {
    expect(decodeApdu(encodeApdu(apdu))).toEqual(Result.succeed(apdu))
  })

  it("rounds a max APDU size down to the nearest code", () => {
    const apdu: Apdu = {
      _tag: "ConfirmedRequest",
      invokeId: 1,
      service: 12,
      maxApdu: 1500,
      segmentedResponseAccepted: false,
      body: new Uint8Array(0)
    }
    expect(decodeApdu(encodeApdu(apdu))).toMatchObject(Result.succeed({ maxApdu: 1476 }))
  })

  it("rejects a segmented request, which Plenum does not reassemble", () => {
    expect(Result.isFailure(decodeApdu(Uint8Array.of(0x08, 0x05, 0x01, 0x00, 0x04, 0x0c)))).toBe(true)
  })
})

describe("frames", () => {
  it("wraps an unconfirmed broadcast in BVLC and NPDU", () => {
    const whoIs: Apdu = { _tag: "UnconfirmedRequest", service: 8, body: new Uint8Array(0) }
    const datagram = encodeFrame(whoIs, { broadcast: true })
    expect(hex(datagram)).toBe("81 0b 00 08 01 00 10 08")
    expect(decodeFrame(datagram)).toEqual(Result.succeed({ apdu: whoIs }))
  })

  it("reads the original sender of a forwarded NPDU (J.2.5)", () => {
    const npdu = encodeNpdu({ expectingReply: false, priority: 0, payload: Uint8Array.of(0x10, 0x08) })
    const datagram = encodeBvlc(BvlcFunction.ForwardedNpdu, Uint8Array.of(192, 168, 1, 20, 0xba, 0xc0, ...npdu))
    expect(decodeFrame(datagram)).toMatchObject(
      Result.succeed({ forwardedFrom: { host: "192.168.1.20", port: 47808 } })
    )
  })

  it("ignores BVLC results and network layer messages", () => {
    expect(decodeFrame(encodeBvlc(BvlcFunction.Result, Uint8Array.of(0, 0)))).toEqual(Result.succeed(undefined))
    const whoIsRouter = encodeNpdu({
      expectingReply: false,
      priority: 0,
      networkMessage: { type: 0 },
      payload: new Uint8Array(0)
    })
    expect(decodeFrame(encodeBvlc(BvlcFunction.OriginalBroadcastNpdu, whoIsRouter))).toEqual(Result.succeed(undefined))
  })
})
