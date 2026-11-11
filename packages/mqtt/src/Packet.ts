/**
 * MQTT control packets as pure encode/decode functions, in MQTT 5 (OASIS MQTT
 * Version 5.0, chapter 3) and MQTT 3.1.1 (OASIS MQTT Version 3.1.1, chapter
 * 3). The client uses the CONNECT/PUBLISH/PINGREQ/DISCONNECT encoders and the
 * CONNACK/PUBACK/PINGRESP/DISCONNECT decoders; the test broker uses the
 * opposite directions. Section numbers are MQTT 5's unless they say 3.1.1.
 *
 * 3.1.1 has no properties, no reason codes on PUBACK and DISCONNECT, and only
 * the QoS in a subscription's options. Its CONNACK return codes are mapped to
 * the MQTT 5 reason codes that mean the same, so callers check one set.
 *
 * Publishing, and subscribing for commands (v0.4): no QoS 2, no AUTH
 * exchange, no shared subscriptions.
 */
import { Result } from "effect"
import {
  decodeVariableByteInteger,
  encodeUtf8String,
  encodeVariableByteInteger,
  MAX_VARIABLE_BYTE_INTEGER,
  MqttCodecError,
  PacketType
} from "./Codec.ts"

const encoder = new TextEncoder()

/** The protocol level in CONNECT: 4 is MQTT 3.1.1 (3.1.1 §3.1.2.2), 5 is MQTT 5 (§3.1.2.2). */
export type ProtocolVersion = 4 | 5
const decoder = new TextDecoder("utf-8", { fatal: true })

/** Property identifiers used here (§2.2.2.2). */
export const Property = {
  PayloadFormatIndicator: 0x01,
  MessageExpiryInterval: 0x02,
  ResponseTopic: 0x08,
  CorrelationData: 0x09,
  ContentType: 0x03,
  SessionExpiryInterval: 0x11,
  AssignedClientIdentifier: 0x12,
  ServerKeepAlive: 0x13,
  ReasonString: 0x1f,
  ReceiveMaximum: 0x21,
  TopicAliasMaximum: 0x22,
  MaximumQoS: 0x24,
  RetainAvailable: 0x25,
  MaximumPacketSize: 0x27
} as const

/** Wire type of every property identifier (§2.2.2.2), so unknown ones can be skipped. */
const propertyKinds: Record<number, "byte" | "u16" | "u32" | "vbi" | "string" | "binary" | "pair"> = {
  0x01: "byte",
  0x02: "u32",
  0x03: "string",
  0x08: "string",
  0x09: "binary",
  0x0b: "vbi",
  0x11: "u32",
  0x12: "string",
  0x13: "u16",
  0x15: "string",
  0x16: "binary",
  0x17: "byte",
  0x18: "u32",
  0x19: "byte",
  0x1a: "string",
  0x1c: "string",
  0x1f: "string",
  0x21: "u16",
  0x22: "u16",
  0x23: "u16",
  0x24: "byte",
  0x25: "byte",
  0x26: "pair",
  0x27: "u32",
  0x28: "byte",
  0x29: "byte",
  0x2a: "byte"
}

/** Properties by identifier: numbers, strings and binary data (a copy). User properties are skipped. */
export type Properties = ReadonlyMap<number, number | string | Uint8Array>

// ---------------------------------------------------------------------------
// Byte writing

class Writer {
  private readonly parts: Array<Uint8Array> = []
  bytes(bytes: Uint8Array) {
    this.parts.push(bytes)
    return this
  }
  byte(value: number) {
    return this.bytes(Uint8Array.of(value & 0xff))
  }
  u16(value: number) {
    return this.bytes(Uint8Array.of((value >> 8) & 0xff, value & 0xff))
  }
  u32(value: number) {
    const out = new Uint8Array(4)
    new DataView(out.buffer).setUint32(0, value >>> 0)
    return this.bytes(out)
  }
  string(value: string) {
    return this.bytes(encodeUtf8String(value))
  }
  binary(value: Uint8Array) {
    return this.u16(value.length).bytes(value)
  }
  get length() {
    return this.parts.reduce((n, p) => n + p.length, 0)
  }
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.length)
    let offset = 0
    for (const p of this.parts) {
      out.set(p, offset)
      offset += p.length
    }
    return out
  }
}

/** Property block: its length as a Variable Byte Integer, then the properties. */
const encodeProperties = (write: (w: Writer) => void): Uint8Array => {
  const body = new Writer()
  write(body)
  return new Writer().bytes(encodeVariableByteInteger(body.length)).bytes(body.toBytes()).toBytes()
}

/** Fixed header (§2.1.1) in front of a variable header and payload. */
const packet = (type: number, flags: number, body: Uint8Array): Uint8Array =>
  new Writer()
    .byte((type << 4) | (flags & 0x0f))
    .bytes(encodeVariableByteInteger(body.length))
    .bytes(body)
    .toBytes()

// ---------------------------------------------------------------------------
// Byte reading. Readers return a Result so a truncated packet is a typed error, not a throw.

class Reader {
  offset = 0
  readonly data: Uint8Array
  constructor(data: Uint8Array) {
    this.data = data
  }
  get remaining() {
    return this.data.length - this.offset
  }
  private need(n: number) {
    if (this.remaining < n) throw new MqttCodecError({ message: `packet truncated: need ${n} more byte(s)` })
  }
  byte() {
    this.need(1)
    return this.data[this.offset++] ?? 0
  }
  u16() {
    return (this.byte() << 8) | this.byte()
  }
  u32() {
    return ((this.u16() << 16) >>> 0) + this.u16()
  }
  vbi() {
    const decoded = decodeVariableByteInteger(this.data, this.offset)
    if (decoded === undefined) throw new MqttCodecError({ message: "packet truncated in a variable byte integer" })
    if (decoded instanceof MqttCodecError) throw decoded
    this.offset += decoded.length
    return decoded.value
  }
  bytes(n: number) {
    this.need(n)
    const out = this.data.subarray(this.offset, this.offset + n)
    this.offset += n
    return out
  }
  binary() {
    return this.bytes(this.u16())
  }
  string() {
    try {
      return decoder.decode(this.binary())
    } catch {
      throw new MqttCodecError({ message: "malformed UTF-8 string" })
    }
  }
  rest() {
    return this.bytes(this.remaining)
  }
  properties(): Properties {
    const end = this.vbi() + this.offset
    const props = new Map<number, number | string | Uint8Array>()
    while (this.offset < end) {
      const id = this.vbi()
      switch (propertyKinds[id]) {
        case "byte":
          props.set(id, this.byte())
          break
        case "u16":
          props.set(id, this.u16())
          break
        case "u32":
          props.set(id, this.u32())
          break
        case "vbi":
          props.set(id, this.vbi())
          break
        case "string":
          props.set(id, this.string())
          break
        case "binary":
          // A copy as a plain Uint8Array: on a Node Buffer, slice() returns a view of the socket chunk.
          props.set(id, new Uint8Array(this.binary()))
          break
        case "pair":
          this.string()
          this.string()
          break
        case undefined:
          throw new MqttCodecError({ message: `unknown property 0x${id.toString(16)}` })
      }
    }
    if (this.offset !== end) throw new MqttCodecError({ message: "property length mismatch" })
    return props
  }
}

/**
 * Run a decoder over a packet body. The reader signals truncation by throwing
 * an MqttCodecError internally; it never escapes this function.
 */
const decodeWith = <A>(body: Uint8Array, decode: (r: Reader) => A): Result.Result<A, MqttCodecError> => {
  try {
    return Result.succeed(decode(new Reader(body)))
  } catch (error) {
    if (error instanceof MqttCodecError) return Result.fail(error)
    throw error
  }
}

// ---------------------------------------------------------------------------
// Stream framing

export type PacketSplit =
  | { readonly _tag: "Incomplete" }
  | {
      readonly _tag: "Packet"
      readonly type: number
      readonly flags: number
      readonly body: Uint8Array
      readonly rest: Uint8Array
    }
  | { readonly _tag: "Invalid"; readonly message: string }

/** Take one control packet off the front of a byte stream (§2.1: fixed header, remaining length). */
export const takePacket = (buffer: Uint8Array): PacketSplit => {
  const first = buffer[0]
  if (first === undefined) return { _tag: "Incomplete" }
  const length = decodeVariableByteInteger(buffer, 1)
  if (length === undefined) return { _tag: "Incomplete" }
  if (length instanceof MqttCodecError) return { _tag: "Invalid", message: length.message }
  const start = 1 + length.length
  const end = start + length.value
  if (buffer.length < end) return { _tag: "Incomplete" }
  return {
    _tag: "Packet",
    type: first >> 4,
    flags: first & 0x0f,
    body: buffer.subarray(start, end),
    rest: buffer.subarray(end)
  }
}

export type Frame =
  | { readonly _tag: "Incomplete" }
  | { readonly _tag: "Packet"; readonly type: number; readonly flags: number; readonly body: Uint8Array }
  | { readonly _tag: "Invalid"; readonly message: string }
  /** The fixed header announces a packet of `size` bytes, above the limit; its body is not waited for. */
  | { readonly _tag: "TooLarge"; readonly size: number }

/**
 * Reassembles control packets from the chunks a socket delivers. Chunks are
 * kept as they arrive and each packet is copied out once, so reading a large
 * packet costs its size, not its size times the number of chunks. A packet
 * whose fixed header (§2.1.1) says it is longer than `maximumPacketSize`
 * bytes (header included, §3.1.2.11.4) is reported as soon as the header is
 * in, before any of its body is buffered.
 */
export interface FrameReader {
  /** Append bytes read from the stream. */
  readonly push: (chunk: Uint8Array) => void
  /** Take the next complete packet, if all of it has arrived. */
  readonly next: () => Frame
}

export const makeFrameReader = (maximumPacketSize = Number.POSITIVE_INFINITY): FrameReader => {
  const chunks: Array<Uint8Array> = []
  // Bytes of chunks[0] already consumed, and bytes held in total.
  let head = 0
  let buffered = 0

  /** Copy up to `n` bytes from the front without consuming them. */
  const peek = (n: number): Uint8Array => {
    const out = new Uint8Array(Math.min(n, buffered))
    let filled = 0
    let skip = head
    for (const chunk of chunks) {
      if (filled === out.length) break
      const part = chunk.subarray(skip, skip + out.length - filled)
      out.set(part, filled)
      filled += part.length
      skip = 0
    }
    return out
  }

  /** Consume `n` bytes from the front; a view when they sit in one chunk, else one copy. */
  const take = (n: number): Uint8Array => {
    buffered -= n
    const first = chunks[0]
    if (first !== undefined && first.length - head >= n) {
      const out = first.subarray(head, head + n)
      head += n
      if (head === first.length) {
        chunks.shift()
        head = 0
      }
      return out
    }
    const out = new Uint8Array(n)
    let filled = 0
    while (filled < n) {
      const chunk = chunks[0]
      if (chunk === undefined) break
      const part = chunk.subarray(head, head + n - filled)
      out.set(part, filled)
      filled += part.length
      head += part.length
      if (head === chunk.length) {
        chunks.shift()
        head = 0
      }
    }
    return out
  }

  return {
    push: (chunk) => {
      if (chunk.length === 0) return
      chunks.push(chunk)
      buffered += chunk.length
    },
    next: () => {
      // A fixed header is at most 5 bytes: the type byte and a 4-byte remaining length.
      const header = peek(5)
      const first = header[0]
      if (first === undefined) return { _tag: "Incomplete" }
      const length = decodeVariableByteInteger(header, 1)
      if (length === undefined) return { _tag: "Incomplete" }
      if (length instanceof MqttCodecError) return { _tag: "Invalid", message: length.message }
      const headerLength = 1 + length.length
      const size = headerLength + length.value
      if (size > maximumPacketSize) return { _tag: "TooLarge", size }
      if (buffered < size) return { _tag: "Incomplete" }
      take(headerLength)
      return { _tag: "Packet", type: first >> 4, flags: first & 0x0f, body: take(length.value) }
    }
  }
}

// ---------------------------------------------------------------------------
// CONNECT (§3.1)

export interface Will {
  readonly topic: string
  readonly payload: string
  readonly qos: 0 | 1
  readonly retain: boolean
}

export interface Connect {
  /** 5 when absent. */
  readonly protocolVersion?: ProtocolVersion
  readonly clientId: string
  readonly keepAliveSeconds: number
  readonly cleanStart: boolean
  /** Seconds the broker keeps the session after a disconnect (0 = none). */
  readonly sessionExpirySeconds: number
  /** Largest packet the client accepts (§3.1.2.11.4); absent means no limit. */
  readonly maximumPacketSize?: number
  readonly username?: string
  readonly password?: string
  readonly will?: Will
}

export const encodeConnect = (connect: Connect): Uint8Array => {
  const flags =
    (connect.username === undefined ? 0 : 0x80) |
    (connect.password === undefined ? 0 : 0x40) |
    (connect.will?.retain === true ? 0x20 : 0) |
    ((connect.will?.qos ?? 0) << 3) |
    (connect.will === undefined ? 0 : 0x04) |
    (connect.cleanStart ? 0x02 : 0)
  const v5 = (connect.protocolVersion ?? 5) === 5
  // In 3.1.1 bit 1 is Clean Session (3.1.1 §3.1.2.4), and there are no properties: the session ends with the
  // connection when it is set, as a session expiry of 0 does in MQTT 5.
  const body = new Writer()
    .string("MQTT")
    .byte(v5 ? 5 : 4)
    .byte(flags)
    .u16(connect.keepAliveSeconds)
  if (v5) {
    body.bytes(
      encodeProperties((w) => {
        w.byte(Property.SessionExpiryInterval).u32(connect.sessionExpirySeconds)
        if (connect.maximumPacketSize !== undefined) w.byte(Property.MaximumPacketSize).u32(connect.maximumPacketSize)
      })
    )
  }
  body.string(connect.clientId)
  if (connect.will !== undefined) {
    if (v5) body.bytes(encodeProperties((w) => w.byte(Property.PayloadFormatIndicator).byte(1)))
    body.string(connect.will.topic).binary(encoder.encode(connect.will.payload))
  }
  if (connect.username !== undefined) body.string(connect.username)
  if (connect.password !== undefined) body.binary(encoder.encode(connect.password))
  return packet(PacketType.CONNECT, 0, body.toBytes())
}

/**
 * Decode a CONNECT body (broker side), MQTT 5 or 3.1.1. A protocol level it
 * does not speak fails with a message starting "unsupported protocol", so the
 * broker can answer with the CONNACK for it (§3.1.2.2) before closing.
 */
export const decodeConnect = (body: Uint8Array): Result.Result<Connect, MqttCodecError> =>
  decodeWith(body, (r) => {
    const protocol = r.string()
    const level = r.byte()
    if (protocol !== "MQTT" || (level !== 5 && level !== 4)) {
      throw new MqttCodecError({ message: `unsupported protocol ${protocol} level ${level}` })
    }
    const v5 = level === 5
    const flags = r.byte()
    const keepAliveSeconds = r.u16()
    const properties: Properties = v5 ? r.properties() : new Map()
    const clientId = r.string()
    let will: Will | undefined
    if ((flags & 0x04) !== 0) {
      if (v5) r.properties()
      const topic = r.string()
      // Binary on the wire (§3.1.3.4), held as a string: decoded by the reader, so bad UTF-8 is a codec error.
      const payload = r.string()
      will = { topic, payload, qos: (flags >> 3) & 0x01 ? 1 : 0, retain: (flags & 0x20) !== 0 }
    }
    const username = (flags & 0x80) !== 0 ? r.string() : undefined
    const password = (flags & 0x40) !== 0 ? r.string() : undefined
    const expiry = properties.get(Property.SessionExpiryInterval)
    const maximumPacketSize = properties.get(Property.MaximumPacketSize)
    return {
      protocolVersion: v5 ? 5 : 4,
      clientId,
      keepAliveSeconds,
      cleanStart: (flags & 0x02) !== 0,
      sessionExpirySeconds: typeof expiry === "number" ? expiry : 0,
      ...(typeof maximumPacketSize === "number" ? { maximumPacketSize } : {}),
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      ...(will === undefined ? {} : { will })
    }
  })

// ---------------------------------------------------------------------------
// CONNACK (§3.2)

export interface Connack {
  readonly sessionPresent: boolean
  /** 0x00 success; 0x80 and above refuse the connection (§3.2.2.2). */
  readonly reasonCode: number
  readonly properties: Properties
}

/**
 * The 3.1.1 CONNACK return codes (3.1.1 §3.2.2.3) as the MQTT 5 reason codes
 * that mean the same: unacceptable protocol version, identifier rejected,
 * server unavailable, bad user name or password, not authorized.
 */
const returnCodeReasons: Record<number, number> = { 1: 0x84, 2: 0x85, 3: 0x88, 4: 0x86, 5: 0x87 }
const reasonReturnCodes: Record<number, number> = { 0x84: 1, 0x85: 2, 0x88: 3, 0x86: 4, 0x87: 5 }

/**
 * Decode a CONNACK. In 3.1.1 the return code is mapped to its MQTT 5 reason
 * code. Read as MQTT 5, a reason code of 0x01 is no MQTT 5 code at all: it is
 * a 3.1.1 broker refusing the protocol level (3.1.1 §3.2.2.3), which
 * `refusesProtocolLevel` recognizes.
 */
export const decodeConnack = (body: Uint8Array, version: ProtocolVersion = 5): Result.Result<Connack, MqttCodecError> =>
  decodeWith(body, (r) => {
    const sessionPresent = (r.byte() & 0x01) !== 0
    const code = r.byte()
    if (version === 4) {
      return { sessionPresent, reasonCode: code === 0 ? 0 : (returnCodeReasons[code] ?? 0x80), properties: new Map() }
    }
    return { sessionPresent, reasonCode: code, properties: r.remaining > 0 ? r.properties() : new Map() }
  })

/** Whether a CONNACK read as MQTT 5 says the broker does not speak MQTT 5: 0x84 from MQTT 5, 0x01 from 3.1.1. */
export const refusesProtocolLevel = (connack: Connack): boolean =>
  connack.reasonCode === 0x84 || connack.reasonCode === 0x01

/**
 * Encode a CONNACK (broker side). Numeric properties only, as the test broker
 * needs. In 3.1.1 the reason code becomes its return code (unspecified errors
 * become 3, server unavailable), and there are no properties.
 */
export const encodeConnack = (
  reasonCode: number,
  properties: ReadonlyMap<number, number> = new Map(),
  version: ProtocolVersion = 5
): Uint8Array => {
  if (version === 4) {
    const returnCode = reasonCode === 0 ? 0 : (reasonReturnCodes[reasonCode] ?? 3)
    return packet(PacketType.CONNACK, 0, Uint8Array.of(0, returnCode))
  }
  return packet(
    PacketType.CONNACK,
    0,
    new Writer()
      .byte(0)
      .byte(reasonCode)
      .bytes(
        encodeProperties((w) => {
          for (const [id, value] of properties) {
            w.byte(id)
            const kind = propertyKinds[id]
            if (kind === "u16") w.u16(value)
            else if (kind === "u32") w.u32(value)
            else w.byte(value)
          }
        })
      )
      .toBytes()
  )
}

/** The CONNACK a 3.1.1 broker sends for a protocol level it does not speak (3.1.1 §3.1.2.2): return code 1. */
export const encodeUnsupportedLevelConnack = (): Uint8Array => packet(PacketType.CONNACK, 0, Uint8Array.of(0, 1))

/** Names for the CONNACK reason codes a gateway is likely to meet (§3.2.2.2). */
export const connackReasonName = (code: number): string =>
  ({
    0x80: "unspecified error",
    0x81: "malformed packet",
    0x82: "protocol error",
    0x84: "unsupported protocol version",
    0x85: "client identifier not valid",
    0x86: "bad user name or password",
    0x87: "not authorized",
    0x88: "server unavailable",
    0x89: "server busy",
    0x8a: "banned",
    0x8c: "bad authentication method",
    0x95: "packet too large",
    0x97: "quota exceeded",
    0x9f: "connection rate exceeded"
  })[code] ?? `reason code 0x${code.toString(16)}`

// ---------------------------------------------------------------------------
// PUBLISH (§3.3)

export interface Publish {
  readonly topic: string
  readonly payload: Uint8Array
  readonly qos: 0 | 1
  readonly retain: boolean
  /** Required for QoS 1, absent for QoS 0. */
  readonly packetId?: number
  /** Seconds the message stays deliverable (§3.3.2.3.3); the broker discards it after. */
  readonly messageExpirySeconds?: number
  /** Where the receiver should answer (§3.3.2.3.5, request/response). */
  readonly responseTopic?: string
  /** Echoed in the answer so the requester can match it (§3.3.2.3.6). */
  readonly correlationData?: Uint8Array
}

/**
 * Encode a PUBLISH. Payloads are marked UTF-8 (payload format indicator 1):
 * OT Gateway publishes JSON. 3.1.1 has no properties (3.1.1 §3.3.2), so
 * expiry, response topic and correlation data are left out there.
 */
export const encodePublish = (publish: Publish, version: ProtocolVersion = 5): Uint8Array => {
  // The hot path of the gateway, one call per value: sizes first, then one buffer written in place.
  const topic = utf8String(publish.topic)
  const withProperties = version === 5
  const responseTopic =
    withProperties && publish.responseTopic !== undefined ? utf8String(publish.responseTopic) : undefined
  const expiry = withProperties ? publish.messageExpirySeconds : undefined
  const correlation = withProperties ? publish.correlationData : undefined
  let propertiesLength = 0
  if (withProperties) {
    propertiesLength = 2
    if (expiry !== undefined) propertiesLength += 5
    if (responseTopic !== undefined) propertiesLength += 3 + responseTopic.length
    if (correlation !== undefined) propertiesLength += 3 + correlation.length
  }
  const bodyLength =
    2 +
    topic.length +
    (publish.qos > 0 ? 2 : 0) +
    (withProperties ? variableByteIntegerLength(propertiesLength) + propertiesLength : 0) +
    publish.payload.length
  const out = new Uint8Array(1 + variableByteIntegerLength(bodyLength) + bodyLength)
  out[0] = (PacketType.PUBLISH << 4) | (publish.qos << 1) | (publish.retain ? 1 : 0)
  let offset = writeVariableByteInteger(out, 1, bodyLength)
  offset = writeU16(out, offset, topic.length)
  out.set(topic, offset)
  offset += topic.length
  if (publish.qos > 0) offset = writeU16(out, offset, publish.packetId ?? 0)
  if (withProperties) {
    offset = writeVariableByteInteger(out, offset, propertiesLength)
    out[offset++] = Property.PayloadFormatIndicator
    out[offset++] = 1
    if (expiry !== undefined) {
      out[offset++] = Property.MessageExpiryInterval
      new DataView(out.buffer).setUint32(offset, expiry >>> 0)
      offset += 4
    }
    if (responseTopic !== undefined) {
      out[offset++] = Property.ResponseTopic
      offset = writeU16(out, offset, responseTopic.length)
      out.set(responseTopic, offset)
      offset += responseTopic.length
    }
    if (correlation !== undefined) {
      out[offset++] = Property.CorrelationData
      offset = writeU16(out, offset, correlation.length)
      out.set(correlation, offset)
      offset += correlation.length
    }
  }
  out.set(publish.payload, offset)
  return out
}

/** A string's UTF-8 bytes, at most 65,535 of them (§1.5.4). */
const utf8String = (value: string): Uint8Array => {
  const bytes = encoder.encode(value)
  if (bytes.length > 0xffff) throw new RangeError("string too long")
  return bytes
}

/** How many bytes `value` takes as a Variable Byte Integer (§1.5.5). */
const variableByteIntegerLength = (value: number): number => {
  if (value > MAX_VARIABLE_BYTE_INTEGER) throw new RangeError(`value out of range: ${value}`)
  return value < 128 ? 1 : value < 16_384 ? 2 : value < 2_097_152 ? 3 : 4
}

/** Writes `value` as a Variable Byte Integer at `offset` (§1.5.5); returns the offset after it. */
const writeVariableByteInteger = (out: Uint8Array, offset: number, value: number): number => {
  let rest = value
  do {
    let byte = rest % 128
    rest = Math.floor(rest / 128)
    if (rest > 0) byte |= 0x80
    out[offset++] = byte
  } while (rest > 0)
  return offset
}

const writeU16 = (out: Uint8Array, offset: number, value: number): number => {
  out[offset] = (value >> 8) & 0xff
  out[offset + 1] = value & 0xff
  return offset + 2
}

/** Decode a PUBLISH body with its fixed-header flags (the broker, and a client receiving commands). */
export const decodePublish = (
  flags: number,
  body: Uint8Array,
  version: ProtocolVersion = 5
): Result.Result<Publish, MqttCodecError> =>
  decodeWith(body, (r) => {
    const qos = (flags >> 1) & 0x03
    if (qos > 1) throw new MqttCodecError({ message: `QoS ${qos} is not supported` })
    const topic = r.string()
    const packetId = qos > 0 ? r.u16() : undefined
    const properties: Properties = version === 5 ? r.properties() : new Map()
    const expiry = properties.get(Property.MessageExpiryInterval)
    const responseTopic = properties.get(Property.ResponseTopic)
    const correlationData = properties.get(Property.CorrelationData)
    return {
      topic,
      payload: new Uint8Array(r.rest()),
      qos: qos === 1 ? 1 : 0,
      retain: (flags & 0x01) !== 0,
      ...(packetId === undefined ? {} : { packetId }),
      ...(typeof expiry === "number" ? { messageExpirySeconds: expiry } : {}),
      ...(typeof responseTopic === "string" ? { responseTopic } : {}),
      ...(correlationData instanceof Uint8Array ? { correlationData } : {})
    }
  })

// ---------------------------------------------------------------------------
// PUBACK (§3.4)

export interface Puback {
  readonly packetId: number
  /** 0x00 success, 0x10 no matching subscribers (also success); 0x80 and above failed. */
  readonly reasonCode: number
}

/**
 * PUBACK reason codes that refuse this message for good (§3.4.2.1): not
 * authorized (0x87), topic name invalid (0x90), payload format invalid
 * (0x99), and packet too large (0x95), which some brokers send although the
 * table lists it for DISCONNECT only. Every other code of 0x80 and above
 * (unspecified 0x80, implementation specific 0x83, packet identifier in use
 * 0x91, quota exceeded 0x97, …) may pass, so the message is worth retrying.
 */
export const pubackRefusesMessage = (reasonCode: number): boolean =>
  reasonCode === 0x87 || reasonCode === 0x90 || reasonCode === 0x95 || reasonCode === 0x99

/** A PUBACK may stop after the packet id (reason 0x00) or after the reason code (§3.4.2.1). */
export const decodePuback = (body: Uint8Array): Result.Result<Puback, MqttCodecError> =>
  decodeWith(body, (r) => ({ packetId: r.u16(), reasonCode: r.remaining > 0 ? r.byte() : 0 }))

/** Encode a PUBACK. In 3.1.1 it is the packet identifier alone (3.1.1 §3.4.2), so a refusal cannot be said. */
export const encodePuback = (packetId: number, reasonCode = 0, version: ProtocolVersion = 5): Uint8Array =>
  version === 4
    ? packet(PacketType.PUBACK, 0, new Writer().u16(packetId).toBytes())
    : packet(
        PacketType.PUBACK,
        0,
        new Writer()
          .u16(packetId)
          .byte(reasonCode)
          .bytes(encodeProperties(() => {}))
          .toBytes()
      )

// ---------------------------------------------------------------------------
// SUBSCRIBE (§3.8) and SUBACK (§3.9)

export interface Subscription {
  readonly filter: string
  readonly qos: 0 | 1
  /**
   * Retain As Published (§3.8.3.1): live messages keep the retain flag they
   * were published with. Without it a retained publish reaches a client that
   * is already subscribed as if it were live, and only a later subscribe
   * shows it as retained.
   */
  readonly retainAsPublished?: boolean
  /**
   * No Local (§3.8.3.1): the broker does not send the client its own
   * publishes on this filter. A gateway answering on topics near the ones it
   * takes commands on must never read its own answers as commands.
   */
  readonly noLocal?: boolean
}

export interface Subscribe {
  readonly packetId: number
  readonly subscriptions: ReadonlyArray<Subscription>
}

/**
 * Encode a SUBSCRIBE. Options per filter (§3.8.3.1): the maximum QoS, No
 * Local and Retain As Published as asked, and Retain Handling 0 (send
 * retained messages on subscribe), so a retained message on a filter is
 * seen, flagged as retained, and can be refused. In 3.1.1 the options are
 * the QoS alone (3.1.1 §3.8.3.1): No Local and Retain As Published do not
 * exist there, and the broker clears the retain flag of live messages.
 */
export const encodeSubscribe = (subscribe: Subscribe, version: ProtocolVersion = 5): Uint8Array => {
  const body = new Writer().u16(subscribe.packetId)
  if (version === 5) body.bytes(encodeProperties(() => {}))
  for (const { filter, qos, retainAsPublished, noLocal } of subscribe.subscriptions) {
    const options = version === 5 ? qos | (noLocal === true ? 0x04 : 0) | (retainAsPublished === true ? 0x08 : 0) : qos
    body.string(filter).byte(options)
  }
  // The fixed header flags of SUBSCRIBE are reserved as 0b0010 (§3.8.1).
  return packet(PacketType.SUBSCRIBE, 0b0010, body.toBytes())
}

export const decodeSubscribe = (
  body: Uint8Array,
  version: ProtocolVersion = 5
): Result.Result<Subscribe, MqttCodecError> =>
  decodeWith(body, (r) => {
    const packetId = r.u16()
    if (version === 5) r.properties()
    const subscriptions: Array<Subscription> = []
    while (r.remaining > 0) {
      const filter = r.string()
      const options = r.byte()
      const qos = options & 0x03
      if (qos > 1) throw new MqttCodecError({ message: `QoS ${qos} is not supported` })
      // The upper six bits are reserved in 3.1.1 (3.1.1 §3.8.3.1).
      if (version === 4 && (options & 0xfc) !== 0) {
        throw new MqttCodecError({ message: "reserved bits set in a subscription's options" })
      }
      subscriptions.push({
        filter,
        qos: qos === 1 ? 1 : 0,
        ...((options & 0x04) === 0 ? {} : { noLocal: true }),
        ...((options & 0x08) === 0 ? {} : { retainAsPublished: true })
      })
    }
    // A SUBSCRIBE with no filter is a protocol error (§3.8.3).
    if (subscriptions.length === 0) throw new MqttCodecError({ message: "SUBSCRIBE without a topic filter" })
    return { packetId, subscriptions }
  })

export interface Suback {
  readonly packetId: number
  /** One per filter, in order: the granted QoS (0x00, 0x01), or 0x80 and above for a refusal (§3.9.3). */
  readonly reasonCodes: ReadonlyArray<number>
}

/** Encode a SUBACK. 3.1.1 has no properties, and refuses with 0x80 only (3.1.1 §3.9.3). */
export const encodeSuback = (suback: Suback, version: ProtocolVersion = 5): Uint8Array => {
  const body = new Writer().u16(suback.packetId)
  if (version === 5) body.bytes(encodeProperties(() => {}))
  const codes = version === 5 ? suback.reasonCodes : suback.reasonCodes.map((code) => (code >= 0x80 ? 0x80 : code))
  return packet(PacketType.SUBACK, 0, body.bytes(Uint8Array.from(codes)).toBytes())
}

export const decodeSuback = (body: Uint8Array, version: ProtocolVersion = 5): Result.Result<Suback, MqttCodecError> =>
  decodeWith(body, (r) => {
    const packetId = r.u16()
    if (version === 5) r.properties()
    return { packetId, reasonCodes: [...r.rest()] }
  })

/**
 * Whether `topic` matches the subscription `filter` (§4.7): `+` matches one
 * level, `#` (last) the rest. Wildcards at the first level do not match
 * topics starting with `$` (§4.7.2).
 */
export const topicMatches = (filter: string, topic: string): boolean => {
  const filterLevels = filter.split("/")
  const topicLevels = topic.split("/")
  if (topic.startsWith("$") && (filterLevels[0] === "+" || filterLevels[0] === "#")) return false
  for (let index = 0; index < filterLevels.length; index++) {
    const level = filterLevels[index]
    if (level === "#") return true
    if (index >= topicLevels.length) return false
    if (level !== "+" && level !== topicLevels[index]) return false
  }
  return filterLevels.length === topicLevels.length
}

// ---------------------------------------------------------------------------
// PINGREQ, PINGRESP (§3.12, §3.13) and DISCONNECT (§3.14)

export const encodePingreq = (): Uint8Array => Uint8Array.of(PacketType.PINGREQ << 4, 0)
export const encodePingresp = (): Uint8Array => Uint8Array.of(PacketType.PINGRESP << 4, 0)

/**
 * Normal disconnection: reason 0x00 and no properties, so remaining length 0
 * (§3.14.2.1). 3.1.1's DISCONNECT has no reason (3.1.1 §3.14), so there every
 * disconnection looks normal.
 */
export const encodeDisconnect = (reasonCode = 0, version: ProtocolVersion = 5): Uint8Array =>
  reasonCode === 0 || version === 4
    ? Uint8Array.of(PacketType.DISCONNECT << 4, 0)
    : packet(PacketType.DISCONNECT, 0, Uint8Array.of(reasonCode, 0))

export interface Disconnect {
  readonly reasonCode: number
  readonly reasonString?: string
}

export const decodeDisconnect = (body: Uint8Array): Result.Result<Disconnect, MqttCodecError> =>
  decodeWith(body, (r) => {
    const reasonCode = r.remaining > 0 ? r.byte() : 0
    const reason = r.remaining > 0 ? r.properties().get(Property.ReasonString) : undefined
    return { reasonCode, ...(typeof reason === "string" ? { reasonString: reason } : {}) }
  })
