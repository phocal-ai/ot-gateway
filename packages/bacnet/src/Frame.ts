/**
 * Whole BACnet/IP datagrams: BVLC (Annex J) + NPDU (clause 6) + APDU
 * (clause 20). The transport sends and receives these; everything below is
 * pure.
 */
import { Result } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import { type Apdu, decodeApdu, encodeApdu } from "./Apdu.ts"
import { BvlcFunction, decodeBvlc, encodeBvlc } from "./Bvlc.ts"
import { BacnetCodecError } from "./Encoding.ts"
import { decodeNpdu, encodeNpdu, type NetworkAddress } from "./Npdu.ts"

/** A decoded datagram carrying an APDU. */
export interface Frame {
  readonly apdu: Apdu
  /** Set when the datagram came through a router from another BACnet network. */
  readonly source?: NetworkAddress
  /** Set when it is addressed to a device on another BACnet network (or 0xFFFF, all of them). */
  readonly destination?: NetworkAddress
  /** Set when a BBMD forwarded it: the IP address and port of the original sender (Annex J.2.5). */
  readonly forwardedFrom?: NetAddress.InetAddress
}

export interface EncodeOptions {
  readonly broadcast?: boolean
  /** A device on another BACnet network, reached through a router. */
  readonly destination?: NetworkAddress
  /** Where the message comes from on another network; set by a router, or a simulated device behind one. */
  readonly source?: NetworkAddress
}

/** Encode an APDU as a BACnet/IP datagram. */
export const encodeFrame = (apdu: Apdu, options: EncodeOptions = {}): Uint8Array =>
  encodeBvlc(
    options.broadcast === true ? BvlcFunction.OriginalBroadcastNpdu : BvlcFunction.OriginalUnicastNpdu,
    encodeNpdu({
      expectingReply: apdu._tag === "ConfirmedRequest",
      priority: 0,
      ...(options.destination === undefined ? {} : { destination: { ...options.destination, hopCount: 255 } }),
      ...(options.source === undefined ? {} : { source: options.source }),
      payload: encodeApdu(apdu)
    })
  )

/**
 * Decode a BACnet/IP datagram. Returns `undefined` for valid datagrams that
 * carry no APDU (BVLC results, network layer messages), which a client
 * ignores.
 */
export const decodeFrame = (datagram: Uint8Array): Result.Result<Frame | undefined, BacnetCodecError> => {
  const bvlc = decodeBvlc(datagram)
  if (bvlc instanceof Error) return Result.fail(new BacnetCodecError({ message: bvlc.message }))
  let payload = bvlc.payload
  let forwardedFrom: Frame["forwardedFrom"]
  switch (bvlc.fn) {
    case BvlcFunction.OriginalUnicastNpdu:
    case BvlcFunction.OriginalBroadcastNpdu:
      break
    case BvlcFunction.ForwardedNpdu: {
      if (payload.length < 6) return Result.fail(new BacnetCodecError({ message: "forwarded NPDU without its origin" }))
      // Four address bytes and a 16-bit port always make a valid IPv4 socket address.
      forwardedFrom = NetAddress.inetAddressUnsafe(
        NetAddress.ipv4FromBytesUnsafe(payload.subarray(0, 4)),
        ((payload[4] ?? 0) << 8) | (payload[5] ?? 0)
      )
      payload = payload.subarray(6)
      break
    }
    default:
      return Result.succeed(undefined)
  }
  const npdu = decodeNpdu(payload)
  if (Result.isFailure(npdu)) return Result.fail(npdu.failure)
  if (npdu.success.networkMessage !== undefined) return Result.succeed(undefined)
  const apdu = decodeApdu(npdu.success.payload)
  if (Result.isFailure(apdu)) return Result.fail(apdu.failure)
  return Result.succeed({
    apdu: apdu.success,
    ...(npdu.success.source === undefined ? {} : { source: npdu.success.source }),
    ...(npdu.success.destination === undefined
      ? {}
      : { destination: { network: npdu.success.destination.network, address: npdu.success.destination.address } }),
    ...(forwardedFrom === undefined ? {} : { forwardedFrom })
  })
}
