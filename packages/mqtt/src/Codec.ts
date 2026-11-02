/**
 * MQTT 5 wire primitives (OASIS MQTT Version 5.0, section 1.5).
 * Pure functions; the client builds packets from these.
 */
import { Schema } from "effect"

export const PacketType = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  PUBREC: 5,
  PUBREL: 6,
  PUBCOMP: 7,
  SUBSCRIBE: 8,
  SUBACK: 9,
  UNSUBSCRIBE: 10,
  UNSUBACK: 11,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
  AUTH: 15
} as const

export class MqttCodecError extends Schema.TaggedError<MqttCodecError>()("MqttCodecError", {
  message: Schema.String
}) {}

/** Largest value a Variable Byte Integer can hold (4 bytes). */
export const MAX_VARIABLE_BYTE_INTEGER = 268_435_455

/** Encode a Variable Byte Integer (1 to 4 bytes). */
export const encodeVariableByteInteger = (value: number): Uint8Array => {
  if (!Number.isInteger(value) || value < 0 || value > MAX_VARIABLE_BYTE_INTEGER) {
    throw new RangeError(`value out of range: ${value}`)
  }
  const bytes: Array<number> = []
  let x = value
  do {
    let byte = x % 128
    x = Math.floor(x / 128)
    if (x > 0) byte |= 0x80
    bytes.push(byte)
  } while (x > 0)
  return Uint8Array.from(bytes)
}

/**
 * Decode a Variable Byte Integer starting at `offset`.
 * Returns the value and the number of bytes consumed, or `undefined` when
 * more bytes are needed (useful while reading a stream).
 */
export const decodeVariableByteInteger = (
  bytes: Uint8Array,
  offset = 0
): { readonly value: number; readonly length: number } | undefined | MqttCodecError => {
  let value = 0
  let multiplier = 1
  for (let i = 0; i < 4; i++) {
    const byte = bytes[offset + i]
    if (byte === undefined) return undefined
    value += (byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) return { value, length: i + 1 }
    multiplier *= 128
  }
  return new MqttCodecError({ message: "malformed variable byte integer" })
}

/** Encode a UTF-8 string with its 2-byte length prefix. */
export const encodeUtf8String = (value: string): Uint8Array => {
  const encoded = new TextEncoder().encode(value)
  if (encoded.length > 0xffff) throw new RangeError("string too long")
  const out = new Uint8Array(2 + encoded.length)
  new DataView(out.buffer).setUint16(0, encoded.length)
  out.set(encoded, 2)
  return out
}
