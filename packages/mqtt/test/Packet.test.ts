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
  decodeSuback,
  decodeSubscribe,
  encodeConnack,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePingresp,
  encodePuback,
  encodePublish,
  encodeSuback,
  encodeSubscribe,
  makeFrameReader,
  PacketType,
  Property,
  pubackRefusesMessage,
  refusesProtocolLevel,
  takePacket,
  topicMatches
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

describe("makeFrameReader", () => {
  it("reassembles packets split across chunks and keeps what follows", () => {
    const stream = new Uint8Array([...encodePuback(7), ...encodePingresp()])
    const frames = makeFrameReader()
    expect(frames.next()._tag).toBe("Incomplete")
    for (const byte of stream.subarray(0, 4)) frames.push(Uint8Array.of(byte))
    expect(frames.next()._tag).toBe("Incomplete")
    frames.push(stream.subarray(4))
    const first = frames.next()
    expect(first).toMatchObject({ _tag: "Packet", type: PacketType.PUBACK })
    expect(decodePuback(first._tag === "Packet" ? first.body : new Uint8Array())).toEqual(
      Result.succeed({ packetId: 7, reasonCode: 0 })
    )
    expect(frames.next()).toMatchObject({ _tag: "Packet", type: PacketType.PINGRESP, body: new Uint8Array() })
    expect(frames.next()._tag).toBe("Incomplete")
  })

  it("reads a large packet dribbled in small chunks in linear time", () => {
    const size = 32 * 1024 * 1024
    const frames = makeFrameReader()
    // QoS 0 PUBLISH with a remaining length of 32 MiB (Variable Byte Integer 0x80 0x80 0x80 0x10).
    frames.push(Uint8Array.of(0x30, 0x80, 0x80, 0x80, 0x10))
    const chunk = new Uint8Array(16 * 1024)
    const started = performance.now()
    const early: Array<string> = []
    for (let sent = chunk.length; sent < size; sent += chunk.length) {
      frames.push(chunk)
      // Asked after every chunk, as the client does; copying all so far each time would take minutes.
      early.push(frames.next()._tag)
    }
    frames.push(chunk)
    expect(new Set(early)).toEqual(new Set(["Incomplete"]))
    const frame = frames.next()
    expect(frame._tag === "Packet" && frame.body.length).toBe(size)
    expect(performance.now() - started).toBeLessThan(5000)
  })

  it("reports a packet above the limit from its fixed header alone (§3.1.2.11.4)", () => {
    const frames = makeFrameReader(1024)
    frames.push(Uint8Array.of(0x30, 0x80, 0x80, 0x80, 0x10))
    expect(frames.next()).toEqual({ _tag: "TooLarge", size: 5 + 32 * 1024 * 1024 })
    const fits = makeFrameReader(4)
    fits.push(encodePuback(1).subarray(0, 4))
    expect(fits.next()._tag).toBe("TooLarge")
  })

  it("rejects a remaining length longer than four bytes (§1.5.5)", () => {
    const frames = makeFrameReader()
    frames.push(bytes(0x30, 0xff, 0xff, 0xff, 0xff, 0x01))
    expect(frames.next()._tag).toBe("Invalid")
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
      clientId: "ot-gateway-pi",
      keepAliveSeconds: 60,
      cleanStart: true,
      sessionExpirySeconds: 0,
      username: "gateway",
      password: "s3cret",
      will: { topic: "site/b/$gateway/pi/health", payload: '{"status":"offline"}', qos: 1, retain: true }
    } as const
    const { body } = bodyOf(encodeConnect(connect), PacketType.CONNECT)
    expect(body[7]).toBe(0x80 | 0x40 | 0x20 | 0x08 | 0x04 | 0x02)
    expect(decodeConnect(body)).toEqual(Result.succeed({ protocolVersion: 5, ...connect }))
  })

  it("announces a Maximum Packet Size (§3.1.2.11.4)", () => {
    const connect = {
      clientId: "gw",
      keepAliveSeconds: 30,
      cleanStart: true,
      sessionExpirySeconds: 0,
      maximumPacketSize: 1024 * 1024
    }
    const { body } = bodyOf(encodeConnect(connect), PacketType.CONNECT)
    expect(decodeConnect(body)).toEqual(Result.succeed({ protocolVersion: 5, ...connect }))
  })

  it("rejects a protocol level it does not speak (MQTT 3.1 is level 3)", () => {
    const { body } = bodyOf(
      encodeConnect({ clientId: "gw", keepAliveSeconds: 30, cleanStart: true, sessionExpirySeconds: 0 }),
      PacketType.CONNECT
    )
    const v31 = Uint8Array.from(body)
    v31[6] = 3
    const decoded = decodeConnect(v31)
    expect(Result.isFailure(decoded) && decoded.failure.message.startsWith("unsupported protocol")).toBe(true)
  })
})

describe("MQTT 3.1.1", () => {
  it("CONNECT: level 4, Clean Session, and no properties (3.1.1 §3.1.2)", () => {
    const connect = {
      protocolVersion: 4,
      clientId: "gw",
      keepAliveSeconds: 30,
      cleanStart: true,
      sessionExpirySeconds: 0,
      username: "u",
      password: "p",
      will: { topic: "w", payload: "off", qos: 1, retain: true }
    } as const
    const { body } = bodyOf(encodeConnect({ ...connect, maximumPacketSize: 1024 }), PacketType.CONNECT)
    // Variable header (§3.1.2), then client id, will topic and payload, user name, password (§3.1.3).
    const variableHeader = [
      0x00,
      0x04,
      0x4d,
      0x51,
      0x54,
      0x54,
      0x04,
      0x80 | 0x40 | 0x20 | 0x08 | 0x04 | 0x02,
      0x00,
      0x1e
    ]
    const clientId = [0x00, 0x02, 0x67, 0x77]
    const will = [0x00, 0x01, 0x77, 0x00, 0x03, 0x6f, 0x66, 0x66]
    const credentials = [0x00, 0x01, 0x75, 0x00, 0x01, 0x70]
    expect(Array.from(body)).toEqual([...variableHeader, ...clientId, ...will, ...credentials])
    // The packet size limit cannot be announced in 3.1.1, so it does not come back.
    expect(decodeConnect(body)).toEqual(Result.succeed(connect))
  })

  it("CONNACK: return codes map to the MQTT 5 reason codes and back (3.1.1 §3.2.2.3)", () => {
    expect(Array.from(encodeConnack(0, new Map([[Property.ReceiveMaximum, 5]]), 4))).toEqual([0x20, 0x02, 0x00, 0x00])
    expect(Array.from(encodeConnack(0x86, new Map(), 4))).toEqual([0x20, 0x02, 0x00, 0x04])
    // A reason 3.1.1 has no code for becomes server unavailable.
    expect(Array.from(encodeConnack(0x97, new Map(), 4))).toEqual([0x20, 0x02, 0x00, 0x03])
    expect(decodeConnack(bytes(0x00, 0x05), 4)).toEqual(
      Result.succeed({ sessionPresent: false, reasonCode: 0x87, properties: new Map() })
    )
    expect(decodeConnack(bytes(0x01, 0x00), 4)).toEqual(
      Result.succeed({ sessionPresent: true, reasonCode: 0, properties: new Map() })
    )
  })

  it("CONNACK: a 3.1.1 broker's answer to MQTT 5 reads as a refused protocol level", () => {
    const answer = decodeConnack(bytes(0x00, 0x01))
    expect(Result.isSuccess(answer) && refusesProtocolLevel(answer.success)).toBe(true)
    const v5 = decodeConnack(bodyOf(encodeConnack(0x84), PacketType.CONNACK).body)
    expect(Result.isSuccess(v5) && refusesProtocolLevel(v5.success)).toBe(true)
    const ok = decodeConnack(bodyOf(encodeConnack(0), PacketType.CONNACK).body)
    expect(Result.isSuccess(ok) && refusesProtocolLevel(ok.success)).toBe(false)
  })

  it("PUBLISH: topic, packet identifier and payload, no properties (3.1.1 §3.3.2)", () => {
    const packet = encodePublish(
      { topic: "a/b", payload: text.encode("x"), qos: 1, retain: true, packetId: 10, messageExpirySeconds: 5 },
      4
    )
    expect(Array.from(packet)).toEqual([0x33, 0x08, 0x00, 0x03, 0x61, 0x2f, 0x62, 0x00, 0x0a, 0x78])
    const { flags, body } = bodyOf(packet, PacketType.PUBLISH)
    expect(decodePublish(flags, body, 4)).toEqual(
      Result.succeed({ topic: "a/b", payload: text.encode("x"), qos: 1, retain: true, packetId: 10 })
    )
  })

  it("PUBACK: the packet identifier alone (3.1.1 §3.4.2)", () => {
    const packet = encodePuback(10, 0x87, 4)
    expect(Array.from(packet)).toEqual([0x40, 0x02, 0x00, 0x0a])
    expect(decodePuback(bodyOf(packet, PacketType.PUBACK).body)).toEqual(
      Result.succeed({ packetId: 10, reasonCode: 0 })
    )
  })

  it("SUBSCRIBE: the options are the QoS alone (3.1.1 §3.8.3.1)", () => {
    const packet = encodeSubscribe(
      { packetId: 1, subscriptions: [{ filter: "a/#", qos: 1, noLocal: true, retainAsPublished: true }] },
      4
    )
    expect(Array.from(packet)).toEqual([0x82, 0x08, 0x00, 0x01, 0x00, 0x03, 0x61, 0x2f, 0x23, 0x01])
    const { body } = bodyOf(packet, PacketType.SUBSCRIBE)
    expect(decodeSubscribe(body, 4)).toEqual(
      Result.succeed({ packetId: 1, subscriptions: [{ filter: "a/#", qos: 1 }] })
    )
    const reserved = Uint8Array.from(body)
    reserved[reserved.length - 1] = 0x05
    expect(Result.isFailure(decodeSubscribe(reserved, 4))).toBe(true)
  })

  it("SUBACK: no properties, and 0x80 for every refusal (3.1.1 §3.9.3)", () => {
    const packet = encodeSuback({ packetId: 1, reasonCodes: [1, 0x87] }, 4)
    expect(Array.from(packet)).toEqual([0x90, 0x04, 0x00, 0x01, 0x01, 0x80])
    expect(decodeSuback(bodyOf(packet, PacketType.SUBACK).body, 4)).toEqual(
      Result.succeed({ packetId: 1, reasonCodes: [1, 0x80] })
    )
  })

  it("DISCONNECT: no reason code (3.1.1 §3.14)", () => {
    expect(Array.from(encodeDisconnect(0x95, 4))).toEqual([0xe0, 0x00])
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

  it("round-trips every property, across the lengths where the remaining length grows a byte (§1.5.5)", () => {
    // 127/128 and 16,383/16,384 bytes of body are where the Variable Byte Integer goes from 1 to 2 and 2 to 3 bytes.
    for (const payloadLength of [0, 100, 101, 102, 16_350, 16_360, 16_400, 70_000]) {
      for (const version of [5, 4] as const) {
        const publish = {
          topic: "gebäude/wärme/°C",
          payload: new Uint8Array(payloadLength).fill(0x61),
          qos: 1,
          retain: false,
          packetId: 0xfffe,
          ...(version === 5
            ? { messageExpirySeconds: 3600, responseTopic: "réponse/1", correlationData: bytes(1, 2, 3) }
            : {})
        } as const
        const split = bodyOf(encodePublish(publish, version), PacketType.PUBLISH)
        expect(decodePublish(split.flags, split.body, version)).toEqual(Result.succeed(publish))
      }
    }
  })

  it("refuses a topic longer than 65,535 bytes", () => {
    expect(() =>
      encodePublish({ topic: "ä".repeat(40_000), payload: new Uint8Array(), qos: 0, retain: false })
    ).toThrow(RangeError)
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

  it("refuses a message for good only on permanent reason codes (§3.4.2.1)", () => {
    expect([0x87, 0x90, 0x95, 0x99].every(pubackRefusesMessage)).toBe(true)
    expect([0x00, 0x10, 0x80, 0x83, 0x91, 0x97].some(pubackRefusesMessage)).toBe(false)
  })

  it("reads the short form, where a missing reason means success (§3.4.2.1)", () => {
    expect(decodePuback(bytes(0x00, 0x07))).toEqual(Result.succeed({ packetId: 7, reasonCode: 0 }))
  })
})

describe("PUBLISH request/response properties (§3.3.2.3)", () => {
  it("round-trips message expiry, response topic and correlation data", () => {
    const encoded = encodePublish({
      topic: "s/b/ahu-1/setpoint/$set",
      payload: new TextEncoder().encode('{"value":21.5}'),
      qos: 1,
      retain: false,
      packetId: 7,
      messageExpirySeconds: 30,
      responseTopic: "app/responses",
      correlationData: Uint8Array.of(1, 2, 3)
    })
    const split = bodyOf(encoded, PacketType.PUBLISH)
    expect(Result.getOrThrow(decodePublish(split.flags, split.body))).toMatchObject({
      topic: "s/b/ahu-1/setpoint/$set",
      packetId: 7,
      messageExpirySeconds: 30,
      responseTopic: "app/responses",
      correlationData: Uint8Array.of(1, 2, 3)
    })
  })
})

describe("SUBSCRIBE and SUBACK (§3.8, §3.9)", () => {
  it("encodes SUBSCRIBE with the reserved flags 0b0010 and round-trips its filters", () => {
    const encoded = encodeSubscribe({
      packetId: 1,
      subscriptions: [
        { filter: "s/b/+/+/$set", qos: 1 },
        { filter: "s/#", qos: 0 }
      ]
    })
    expect(encoded[0]).toBe((PacketType.SUBSCRIBE << 4) | 0b0010)
    const split = bodyOf(encoded, PacketType.SUBSCRIBE)
    expect(Result.getOrThrow(decodeSubscribe(split.body))).toEqual({
      packetId: 1,
      subscriptions: [
        { filter: "s/b/+/+/$set", qos: 1 },
        { filter: "s/#", qos: 0 }
      ]
    })
  })

  it("refuses a SUBSCRIBE without filters (§3.8.3)", () => {
    expect(Result.isFailure(decodeSubscribe(Uint8Array.of(0, 1, 0)))).toBe(true)
  })

  it("round-trips a SUBACK's reason codes", () => {
    const split = bodyOf(encodeSuback({ packetId: 9, reasonCodes: [0x01, 0x87] }), PacketType.SUBACK)
    expect(Result.getOrThrow(decodeSuback(split.body))).toEqual({ packetId: 9, reasonCodes: [0x01, 0x87] })
  })
})

describe("topicMatches (§4.7)", () => {
  it.each([
    // The examples of §4.7.1.2 and §4.7.1.3.
    ["sport/tennis/player1/#", "sport/tennis/player1", true],
    ["sport/tennis/player1/#", "sport/tennis/player1/ranking", true],
    ["sport/tennis/player1/#", "sport/tennis/player1/score/wimbledon", true],
    ["sport/#", "sport", true],
    ["sport/tennis/+", "sport/tennis/player1", true],
    ["sport/tennis/+", "sport/tennis/player1/ranking", false],
    ["sport/+", "sport", false],
    ["sport/+", "sport/", true],
    ["+/+", "/finance", true],
    ["/+", "/finance", true],
    ["+", "/finance", false],
    // §4.7.2: wildcards at the first level do not match $ topics; a $ deeper down is an ordinary level.
    ["#", "$SYS/broker", false],
    ["+/monitor/Clients", "$SYS/monitor/Clients", false],
    ["$SYS/#", "$SYS/broker", true],
    ["s/b/+/+/$set", "s/b/ahu-1/setpoint/$set", true],
    ["s/b/+/+/$set", "s/b/ahu-1/setpoint/$meta", false]
  ])("%s against %s is %s", (filter, topic, matches) => {
    expect(topicMatches(filter, topic)).toBe(matches)
  })
})
