/**
 * The BACnet network layer header, NPDU (ASHRAE 135, clause 6.2). OT Gateway
 * talks to devices on its own IP network or through routers, so it reads
 * and writes destination/source specifiers and passes network layer
 * messages through undecoded.
 */
import type { Result } from "effect"
import { type BacnetCodecError, decodeWith, Writer } from "./Encoding.ts"

export const NPDU_VERSION = 0x01

/** A device on another BACnet network, reached through a router. */
export interface NetworkAddress {
  /** Network number; 0xFFFF in a destination means every network (global broadcast). */
  readonly network: number
  /** MAC address on that network; empty for a broadcast on it. */
  readonly address: Uint8Array
}

export interface Npdu {
  /** Set on confirmed requests (clause 6.2.2). */
  readonly expectingReply: boolean
  /** Network priority, 0 (normal) to 3 (life safety). */
  readonly priority: 0 | 1 | 2 | 3
  readonly destination?: NetworkAddress & { readonly hopCount: number }
  readonly source?: NetworkAddress
  /** A network layer message instead of an APDU (clause 6.4); its type, and the vendor for proprietary ones. */
  readonly networkMessage?: { readonly type: number; readonly vendorId?: number }
  /** The APDU, or the network layer message's data. */
  readonly payload: Uint8Array
}

const priorities = [0, 1, 2, 3] as const

export const encodeNpdu = (npdu: Npdu): Uint8Array => {
  const writer = new Writer()
  let control = npdu.priority & 0x03
  if (npdu.networkMessage !== undefined) control |= 0x80
  if (npdu.destination !== undefined) control |= 0x20
  if (npdu.source !== undefined) control |= 0x08
  if (npdu.expectingReply) control |= 0x04
  writer.byte(NPDU_VERSION).byte(control)
  if (npdu.destination !== undefined) {
    writer.u16(npdu.destination.network).byte(npdu.destination.address.length).bytes(npdu.destination.address)
  }
  if (npdu.source !== undefined) {
    writer.u16(npdu.source.network).byte(npdu.source.address.length).bytes(npdu.source.address)
  }
  if (npdu.destination !== undefined) writer.byte(npdu.destination.hopCount)
  if (npdu.networkMessage !== undefined) {
    writer.byte(npdu.networkMessage.type)
    if (npdu.networkMessage.type >= 0x80) writer.u16(npdu.networkMessage.vendorId ?? 0)
  }
  return Uint8Array.from([...writer.toBytes(), ...npdu.payload])
}

export const decodeNpdu = (bytes: Uint8Array): Result.Result<Npdu, BacnetCodecError> =>
  decodeWith(
    bytes,
    (reader) => {
      const version = reader.byte()
      if (version !== NPDU_VERSION) reader.fail(`NPDU version ${version}`)
      const control = reader.byte()
      const priority = priorities[control & 0x03] ?? 0
      const readAddress = (): NetworkAddress => {
        const network = reader.u16()
        const length = reader.byte()
        return { network, address: Uint8Array.from(reader.bytes(length)) }
      }
      const destination = (control & 0x20) !== 0 ? readAddress() : undefined
      const source = (control & 0x08) !== 0 ? readAddress() : undefined
      const hopCount = destination === undefined ? 0 : reader.byte()
      let networkMessage: Npdu["networkMessage"]
      if ((control & 0x80) !== 0) {
        const type = reader.byte()
        networkMessage = type >= 0x80 ? { type, vendorId: reader.u16() } : { type }
      }
      return {
        expectingReply: (control & 0x04) !== 0,
        priority,
        ...(destination === undefined ? {} : { destination: { ...destination, hopCount } }),
        ...(source === undefined ? {} : { source }),
        ...(networkMessage === undefined ? {} : { networkMessage }),
        payload: Uint8Array.from(reader.bytes(reader.remaining))
      }
    },
    { whole: false }
  )
