import { describe, expect, it } from "@effect/vitest"
import { BvlcFunction, decodeBvlc, encodeBvlc } from "../src/index.ts"

describe("BVLC", () => {
  it("round-trips an original unicast NPDU", () => {
    const npdu = Uint8Array.from([0x01, 0x04])
    const datagram = encodeBvlc(BvlcFunction.OriginalUnicastNpdu, npdu)
    expect(Array.from(datagram)).toEqual([0x81, 0x0a, 0x00, 0x06, 0x01, 0x04])
    const decoded = decodeBvlc(datagram)
    expect(decoded).toMatchObject({ fn: BvlcFunction.OriginalUnicastNpdu })
  })

  it("rejects non BACnet/IP datagrams", () => {
    expect(decodeBvlc(Uint8Array.from([0x82, 0x0a, 0x00, 0x04]))).toMatchObject({ _tag: "BvlcError" })
  })
})
