/**
 * MQTT 5 control packets (OASIS MQTT 5.0, chapter 3): fixed bytes where the
 * spec pins them, round trips through the broker-side decoders otherwise.
 */
import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import {
  decodeConnack,
  decodeConnect,
  decodeDisconnect,
  decodePuback,
  decodePublish,
  encodeConnack,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePingresp,
  encodePuback,
  encodePublish,
  PacketType,
  Property,
  takePacket
} from "../src/index.ts"

const bytes = (...values: Array<number>) => Uint8Array.from(values)
const text = new TextEncoder()

/** Frame a packet and return its body, checking the fixed header type. */
const bodyOf = (packet: Uint8Array, type: number) => {
  const split = takePacket(packet)
  if (split._tag !== "Packet") throw new Error(`expected a whole packet, got ${split._tag}`)
  expect(split.type).toBe(type)
  expect(split.rest.length).toBe(0)
  return split
}

describe("takePacket", () => {
  it("waits for the whole packet, then returns the rest of the stream", () => {
    const stream = new Uint8Array([...encodePuback(7), ...encodePingresp()])
    expect(takePacket(stream.subarray(0, 0))._tag).toBe("Incomplete")
    expect(takePacket(stream.subarray(0, 1))._tag).toBe("Incomplete")
    expect(takePacket(stream.subarray(0, 4))._tag).toBe("Incomplete")
    const first = takePacket(stream)
    expect(first).toMatchObject({ _tag: "Packet", type: PacketType.PUBACK })
    if (first._tag !== "Packet") return
    expect(takePacket(first.rest)).toMatchObject({ _tag: "Packet", type: PacketType.PINGRESP, rest: new Uint8Array() })
  })

  it("rejects a remaining length longer than four bytes (§1.5.5)", () => {
    expect(takePacket(bytes(0x30, 0xff, 0xff, 0xff, 0xff, 0x01))._tag).toBe("Invalid")
  })
})

describe("fixed packets", () => {
  it("encodes PINGREQ, PINGRESP and a normal DISCONNECT as two bytes (§3.12, §3.13, §3.14.2.1)", () => {
    expect(encodePingreq()).toEqual(bytes(0xc0, 0x00))
    expect(encodePingresp()).toEqual(bytes(0xd0, 0x00))
    expect(encodeDisconnect()).toEqual(bytes(0xe0, 0x00))
  })

  it("decodes a DISCONNECT with and without a reason code", () => {
    expect(decodeDisconnect(new Uint8Array())).toEqual(Result.succeed({ reasonCode: 0 }))
    const split = bodyOf(encodeDisconnect(0x8b), PacketType.DISCONNECT)
    expect(decodeDisconnect(split.body)).toEqual(Result.succeed({ reasonCode: 0x8b }))
  })
})

describe("CONNECT", () => {
  it("starts with the protocol name, level 5 and the flags (§3.1.2)", () => {
    const packet = encodeConnect({ clientId: "gw", keepAliveSeconds: 30, cleanStart: true, sessionExpirySeconds: 0 })
    const { body } = bodyOf(packet, PacketType.CONNECT)
    // "MQTT", level 5, clean start only, keep alive 30.
    expect(Array.from(body.subarray(0, 10))).toEqual([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x05, 0x02, 0x00, 0x1e])
  })

  it("round-trips credentials and a will", () => {
    const connect = {
      clientId: "plenum-pi",
      keepAliveSeconds: 60,
      cleanStart: true,
      sessionExpirySeconds: 0,
      username: "gateway",
      password: "s3cret",
      will: { topic: "site/b/$gateway/pi/health", payload: '{"status":"offline"}', qos: 1, retain: true }
    } as const
    const { body } = bodyOf(encodeConnect(connect), PacketType.CONNECT)
    expect(body[7]).toBe(0x80 | 0x40 | 0x20 | 0x08 | 0x04 | 0x02)
    expect(decodeConnect(body)).toEqual(Result.succeed(connect))
  })

  it("rejects MQTT 3.1.1", () => {
    const { body } = bodyOf(
      encodeConnect({ clientId: "gw", keepAliveSeconds: 30, cleanStart: true, sessionExpirySeconds: 0 }),
      PacketType.CONNECT
    )
    const v311 = Uint8Array.from(body)
    v311[6] = 4
    expect(Result.isFailure(decodeConnect(v311))).toBe(true)
  })
})

describe("CONNACK", () => {
  it("round-trips the reason code and numeric properties", () => {
    const properties = new Map([
      [Property.ReceiveMaximum, 20],
      [Property.MaximumQoS, 0],
      [Property.MaximumPacketSize, 1024]
    ])
    const { body } = bodyOf(encodeConnack(0x00, properties), PacketType.CONNACK)
    expect(decodeConnack(body)).toEqual(Result.succeed({ sessionPresent: false, reasonCode: 0, properties }))
  })

  it("reads a refusal", () => {
    const { body } = bodyOf(encodeConnack(0x86), PacketType.CONNACK)
    expect(decodeConnack(body)).toMatchObject(Result.succeed({ reasonCode: 0x86 }))
  })

  it("fails on a truncated body", () => {
    expect(Result.isFailure(decodeConnack(bytes(0x00)))).toBe(true)
  })
})

describe("PUBLISH", () => {
  it("encodes QoS 0 without a packet id and marks the payload as UTF-8 (§3.3.2.3.2)", () => {
    const packet = encodePublish({ topic: "a/b", payload: text.encode("hi"), qos: 0, retain: false })
    // Fixed header, topic "a/b", properties (length 2: payload format indicator 1), payload.
    expect(packet).toEqual(bytes(0x30, 0x0a, 0x00, 0x03, 0x61, 0x2f, 0x62, 0x02, 0x01, 0x01, 0x68, 0x69))
  })

  it("round-trips QoS 1 with retain and a packet id", () => {
    const publish = {
      topic: "s/b/d/p/$meta",
      payload: text.encode('{"unit":"°C"}'),
      qos: 1,
      retain: true,
      packetId: 513
    } as const
    const split = bodyOf(encodePublish(publish), PacketType.PUBLISH)
    expect(split.flags).toBe(0x03)
    expect(decodePublish(split.flags, split.body)).toEqual(Result.succeed(publish))
  })

  it("rejects QoS 2", () => {
    const split = bodyOf(
      encodePublish({ topic: "t", payload: new Uint8Array(), qos: 1, retain: false, packetId: 1 }),
      PacketType.PUBLISH
    )
    expect(Result.isFailure(decodePublish(0x04, split.body))).toBe(true)
  })
})

describe("PUBACK", () => {
  it("round-trips a packet id and reason", () => {
    const { body } = bodyOf(encodePuback(65_535, 0x87), PacketType.PUBACK)
    expect(decodePuback(body)).toEqual(Result.succeed({ packetId: 65_535, reasonCode: 0x87 }))
  })

  it("reads the short form, where a missing reason means success (§3.4.2.1)", () => {
    expect(decodePuback(bytes(0x00, 0x07))).toEqual(Result.succeed({ packetId: 7, reasonCode: 0 }))
  })
})
