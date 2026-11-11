/**
 * Chaos: codec fuzzing. Bytes from the broker are untrusted: every decoder
 * must return a Result and the framing a known frame tag, never throw.
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
  encodePuback,
  encodePublish,
  encodeSuback,
  encodeSubscribe,
  makeFrameReader,
  Property,
  takePacket
} from "../../src/Packet.ts"
import type { ProtocolVersion } from "../../src/Packet.ts"

// Small deterministic PRNG (mulberry32).
const rng = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const text = new TextEncoder()
const versions: ReadonlyArray<ProtocolVersion> = [4, 5]

/** Whole encoded packets, fixed header included: the framing seeds. */
const packets: Array<Uint8Array> = [
  encodeConnect({
    clientId: "gateway",
    keepAliveSeconds: 30,
    cleanStart: true,
    sessionExpirySeconds: 3600,
    maximumPacketSize: 1 << 20,
    username: "user",
    password: "pässword",
    will: { topic: "s/b/$gateway/g/health", payload: '{"online":false}', qos: 1, retain: true }
  }),
  encodeConnect({
    protocolVersion: 4,
    clientId: "g",
    keepAliveSeconds: 60,
    cleanStart: false,
    sessionExpirySeconds: 0
  }),
  encodeConnack(
    0,
    new Map([
      [Property.ReceiveMaximum, 20],
      [Property.MaximumPacketSize, 65_536],
      [Property.ServerKeepAlive, 30],
      [Property.MaximumQoS, 1]
    ])
  ),
  encodeConnack(0x86, new Map(), 4),
  encodePublish({
    topic: "s/b/ventilation-1/setpoint/$set",
    payload: text.encode('{"value":21.5}'),
    qos: 1,
    retain: false,
    packetId: 0xffff,
    messageExpirySeconds: 300,
    responseTopic: "app/responses/ünicode",
    correlationData: Uint8Array.of(0, 1, 2, 0xff)
  }),
  encodePublish({ topic: "s/b/d/p", payload: text.encode("1"), qos: 0, retain: true }),
  encodePublish({ topic: "s/b/d/p", payload: new Uint8Array(200), qos: 1, retain: false, packetId: 1 }, 4),
  encodePuback(7, 0x97),
  encodePuback(7, 0, 4),
  encodeSuback({ packetId: 3, reasonCodes: [0, 1, 0x87] }),
  encodeSuback({ packetId: 3, reasonCodes: [1, 0x80] }, 4),
  encodeSubscribe({
    packetId: 3,
    subscriptions: [
      { filter: "s/b/+/+/$set", qos: 1, noLocal: true, retainAsPublished: true },
      { filter: "#", qos: 0 }
    ]
  }),
  encodeSubscribe({ packetId: 4, subscriptions: [{ filter: "a/+/c", qos: 1 }] }, 4),
  encodeDisconnect(0x95),
  // A DISCONNECT with a reason string (§3.14.2.2.3), which no encoder here writes.
  Uint8Array.of(0xe0, 0x07, 0x81, 0x05, Property.ReasonString, 0x00, 0x02, 0x6f, 0x6b)
]

/** The body of a whole packet, as the client's framing hands it to a decoder. */
const bodyOf = (packet: Uint8Array): Uint8Array => {
  const split = takePacket(packet)
  if (split._tag !== "Packet") throw new Error(`expected a whole packet, got ${split._tag}`)
  return split.body
}
const bodies = packets.map(bodyOf)

/** Every decoder of broker bytes, for each protocol version it takes and, for PUBLISH, every fixed-header flag value. */
const decoders: Array<[string, (bytes: Uint8Array) => unknown]> = [
  ["decodeConnect", decodeConnect],
  ["decodePuback", decodePuback],
  ["decodeDisconnect", decodeDisconnect],
  ...versions.flatMap((version): Array<[string, (bytes: Uint8Array) => unknown]> => [
    [`decodeConnack v${version}`, (bytes) => decodeConnack(bytes, version)],
    [`decodeSubscribe v${version}`, (bytes) => decodeSubscribe(bytes, version)],
    [`decodeSuback v${version}`, (bytes) => decodeSuback(bytes, version)],
    ...Array.from({ length: 16 }, (_, flags): [string, (bytes: Uint8Array) => unknown] => [
      `decodePublish flags ${flags} v${version}`,
      (bytes) => decodePublish(flags, bytes, version)
    ])
  ])
]

const mutate = (random: () => number, input: Uint8Array): Uint8Array => {
  const bytes = [...input]
  const edits = 1 + Math.floor(random() * 6)
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(random() * (bytes.length + 1))
    switch (Math.floor(random() * 7)) {
      case 0:
        bytes[at] = Math.floor(random() * 256)
        break
      case 1:
        bytes[at] = (bytes[at] ?? 0) ^ (1 << Math.floor(random() * 8))
        break
      case 2:
        bytes.splice(at, 1)
        break
      case 3:
        bytes.splice(at, 0, Math.floor(random() * 256))
        break
      case 4:
        bytes.length = at
        break
      case 5:
        // interesting bytes: length continuations, maximum lengths, property identifiers (user property 0x26)
        bytes.splice(
          at,
          0,
          [0xff, 0x80, 0x7f, 0x00, 0x01, 0x02, 0x08, 0x09, 0x0b, 0x1f, 0x26, 0x27, 0xc0][Math.floor(random() * 13)] ?? 0
        )
        break
      case 6: {
        const from = Math.floor(random() * bytes.length)
        bytes.splice(at, 0, ...bytes.slice(from, from + 1 + Math.floor(random() * 8)))
        break
      }
    }
  }
  return Uint8Array.from(bytes)
}

const randomBytes = (random: () => number, maxLength: number) =>
  Uint8Array.from({ length: Math.floor(random() * (maxLength + 1)) }, () => Math.floor(random() * 256))

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")

/** Runs every decoder over `input`; records a throw or a value that is not a Result. */
const decodeAll = (input: Uint8Array, problems: Array<string>) => {
  for (const [name, decode] of decoders) {
    try {
      const result = decode(input)
      if (!(Result.isResult(result) && (Result.isSuccess(result) || Result.isFailure(result)))) {
        if (problems.length < 20) problems.push(`${name}(${hex(input)}): not a Result`)
      }
    } catch (error) {
      if (problems.length < 20) problems.push(`${name}(${hex(input)}): threw ${String(error)}`)
    }
  }
}

const splitTags = new Set(["Incomplete", "Packet", "Invalid"])
const frameTags = new Set(["Incomplete", "Packet", "Invalid", "TooLarge"])

/** Takes packets off the front of `buffer` until it stops on something other than a whole packet. */
const takeAll = (buffer: Uint8Array, problems: Array<string>) => {
  let rest = buffer
  try {
    while (true) {
      const split = takePacket(rest)
      if (!splitTags.has(split._tag)) {
        if (problems.length < 20) problems.push(`takePacket(${hex(buffer)}): tag ${split._tag}`)
        return
      }
      if (split._tag !== "Packet") return
      if (split.rest.length === rest.length) return
      rest = split.rest
    }
  } catch (error) {
    if (problems.length < 20) problems.push(`takePacket(${hex(buffer)}): threw ${String(error)}`)
  }
}

/** Feeds `buffer` to a frame reader in random chunk sizes, reading frames as the client does. */
const readFrames = (random: () => number, buffer: Uint8Array, maximumPacketSize: number, problems: Array<string>) => {
  const reader = makeFrameReader(maximumPacketSize)
  let offset = 0
  try {
    while (offset < buffer.length) {
      const size = Math.floor(random() * 12)
      reader.push(buffer.subarray(offset, offset + size))
      offset += size
      while (true) {
        const frame = reader.next()
        if (!frameTags.has(frame._tag)) {
          if (problems.length < 20) problems.push(`next(${hex(buffer)}): tag ${frame._tag}`)
          return
        }
        // The client ends the connection on Invalid and TooLarge: nothing after them is read.
        if (frame._tag === "Invalid" || frame._tag === "TooLarge") return
        if (frame._tag === "Incomplete") break
      }
    }
  } catch (error) {
    if (problems.length < 20) problems.push(`next(${hex(buffer)}, max ${maximumPacketSize}): threw ${String(error)}`)
  }
}

describe("chaos: MQTT codec fuzzing", () => {
  it("covers every decoder of broker bytes", () => {
    // 3 version-free decoders, and per version CONNACK, SUBSCRIBE, SUBACK and PUBLISH with 16 flag values.
    expect(decoders).toHaveLength(3 + 2 * (3 + 16))
    for (const body of bodies) {
      expect(
        decoders.some(([, decode]) => {
          const result = decode(body)
          return Result.isResult(result) && Result.isSuccess(result)
        })
      ).toBe(true)
    }
  })

  it("never throws on random bytes", () => {
    const random = rng(1234)
    const problems: Array<string> = []
    for (let i = 0; i < 500; i++) decodeAll(randomBytes(random, 300), problems)
    expect(problems).toEqual([])
  })

  it("never throws on any truncation of a valid body", () => {
    const problems: Array<string> = []
    for (const body of bodies) {
      for (let length = 0; length <= body.length; length++) decodeAll(body.subarray(0, length), problems)
    }
    expect(problems).toEqual([])
  })

  it("never throws on mutated valid bodies", () => {
    const random = rng(42)
    const problems: Array<string> = []
    for (const body of bodies) {
      for (let i = 0; i < 200; i++) decodeAll(mutate(random, body), problems)
    }
    expect(problems).toEqual([])
  })

  it("frames random, mutated and concatenated streams without throwing", () => {
    const random = rng(7)
    const problems: Array<string> = []
    const stream = Uint8Array.from(packets.flatMap((packet) => [...packet]))
    const inputs: Array<Uint8Array> = [stream]
    for (let i = 0; i < 300; i++) inputs.push(randomBytes(random, 300))
    for (const packet of packets) {
      for (let i = 0; i < 100; i++) inputs.push(mutate(random, packet))
    }
    for (let i = 0; i < 100; i++) inputs.push(mutate(random, stream))
    for (const input of inputs) {
      takeAll(input, problems)
      readFrames(random, input, Number.POSITIVE_INFINITY, problems)
      readFrames(random, input, 1 + Math.floor(random() * 64), problems)
    }
    expect(problems).toEqual([])
  })

  it("reports a remaining length of five continuation bytes as invalid", () => {
    // §1.5.5: a Variable Byte Integer is at most four bytes.
    const bytes = Uint8Array.of(0x30, 0x80, 0x80, 0x80, 0x80, 0x01, 0x00)
    expect(takePacket(bytes)._tag).toBe("Invalid")
    const reader = makeFrameReader()
    reader.push(bytes)
    expect(reader.next()._tag).toBe("Invalid")
  })

  it("reports a huge declared length above the maximum packet size before its body arrives", () => {
    // 268 435 455 bytes, the largest remaining length (§1.5.5), with a 1 KiB limit.
    const header = Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0x7f)
    expect(takePacket(header)._tag).toBe("Incomplete")
    const reader = makeFrameReader(1024)
    reader.push(header)
    expect(reader.next()).toEqual({ _tag: "TooLarge", size: 5 + 268_435_455 })
  })
})
