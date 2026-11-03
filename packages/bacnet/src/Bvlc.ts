/**
 * BACnet Virtual Link Control (BVLC) for BACnet/IP (ASHRAE 135, Annex J).
 * Every BACnet/IP datagram on UDP 47808 starts with this 4-byte header.
 */
import { Schema } from "effect"

export const BVLC_TYPE_BACNET_IP = 0x81
export const DEFAULT_PORT = 47808

export const BvlcFunction = {
  Result: 0x00,
  WriteBroadcastDistributionTable: 0x01,
  ReadBroadcastDistributionTable: 0x02,
  ReadBroadcastDistributionTableAck: 0x03,
  ForwardedNpdu: 0x04,
  RegisterForeignDevice: 0x05,
  ReadForeignDeviceTable: 0x06,
  ReadForeignDeviceTableAck: 0x07,
  DeleteForeignDeviceTableEntry: 0x08,
  DistributeBroadcastToNetwork: 0x09,
  OriginalUnicastNpdu: 0x0a,
  OriginalBroadcastNpdu: 0x0b,
  SecureBvll: 0x0c
} as const

export class BvlcError extends Schema.TaggedError<BvlcError>()("BvlcError", {
  message: Schema.String
}) {}

/** Wrap an NPDU in a BVLC header. */
export const encodeBvlc = (fn: number, npdu: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + npdu.length)
  const view = new DataView(out.buffer)
  view.setUint8(0, BVLC_TYPE_BACNET_IP)
  view.setUint8(1, fn)
  view.setUint16(2, out.length)
  out.set(npdu, 4)
  return out
}

/** Split a datagram into its BVLC function and payload. */
export const decodeBvlc = (datagram: Uint8Array): { readonly fn: number; readonly payload: Uint8Array } | BvlcError => {
  if (datagram.length < 4) return new BvlcError({ message: "datagram too short" })
  const view = new DataView(datagram.buffer, datagram.byteOffset, datagram.byteLength)
  if (view.getUint8(0) !== BVLC_TYPE_BACNET_IP) return new BvlcError({ message: "not a BACnet/IP datagram" })
  const length = view.getUint16(2)
  if (length !== datagram.length) return new BvlcError({ message: `length ${length} does not match datagram` })
  return { fn: view.getUint8(1), payload: datagram.subarray(4) }
}
