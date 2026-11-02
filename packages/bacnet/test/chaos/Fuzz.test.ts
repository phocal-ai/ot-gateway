/**
 * Chaos: codec fuzzing. Every decoder must return a Result, never throw,
 * and stay fast on hostile input.
 */
import { describe, expect, it } from "@effect/vitest"
import {
  decodeApdu,
  decodeCovNotification,
  decodeErrorBody,
  decodeFrame,
  decodeIAm,
  decodeNpdu,
  decodeReadProperty,
  decodeReadPropertyAck,
  decodeReadPropertyMultiple,
  decodeReadPropertyMultipleAck,
  decodeSubscribeCov,
  decodeValues,
  decodeWhoIs,
  encodeCovNotification,
  encodeFrame,
  encodeIAm,
  encodeReadPropertyAck,
  encodeReadPropertyMultipleAck,
  encodeSubscribeCov,
  encodeValues,
  encodeWhoIs,
  encodeReadProperty,
  encodeReadPropertyMultiple,
  encodeErrorBody,
  tryEncode
} from "../../src/index.ts"

// Small deterministic PRNG (mulberry32).
const rng = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const covBody = encodeCovNotification({
  processId: 7,
  initiatingDevice: { objectType: 8, instance: 2001 },
  object: { objectType: 0, instance: 1 },
  timeRemaining: 300,
  values: [
    { property: 85, values: [{ type: "real", value: 21.5 }] },
    { property: 111, values: [{ type: "bit-string", value: [false, false, false, false] }] }
  ]
})
const rpmAck = encodeReadPropertyMultipleAck([
  {
    object: { objectType: 0, instance: 1 },
    results: [
      { property: 85, _tag: "Value", values: [{ type: "real", value: 1 }] },
      { property: 77, _tag: "Value", values: [{ type: "character-string", value: "héllo" }] },
      { property: 99, _tag: "Error", errorClass: 2, errorCode: 32 }
    ]
  }
])
const iAm = encodeIAm({ device: { objectType: 8, instance: 4194302 }, maxApdu: 1476, segmentation: 3, vendorId: 260 })
const rpAck = encodeReadPropertyAck({
  object: { objectType: 8, instance: 1 },
  property: 76,
  values: [
    { type: "object-identifier", value: { objectType: 0, instance: 1 } },
    { type: "constructed", tagNumber: 0, values: [{ type: "context", tagNumber: 1, data: Uint8Array.of(1, 2) }] }
  ]
})
const bodies: Array<Uint8Array> = [
  covBody,
  rpmAck,
  iAm,
  rpAck,
  encodeWhoIs({ range: { low: 0, high: 4194303 } }),
  encodeSubscribeCov({
    processId: 0xffffffff,
    object: { objectType: 0, instance: 1 },
    confirmed: false,
    lifetime: 300
  }),
  encodeReadProperty({ object: { objectType: 0, instance: 1 }, property: 85, arrayIndex: 3 }),
  encodeReadPropertyMultiple([{ object: { objectType: 0, instance: 1 }, properties: [{ property: 85 }] }]),
  encodeErrorBody({ errorClass: 2, errorCode: 31 })
]
const frames: Array<Uint8Array> = [
  encodeFrame({ _tag: "UnconfirmedRequest", service: 2, body: covBody }),
  encodeFrame(
    { _tag: "UnconfirmedRequest", service: 0, body: iAm },
    { source: { network: 5, address: Uint8Array.of(1, 2, 3) } }
  ),
  encodeFrame({ _tag: "ComplexAck", invokeId: 1, service: 14, body: rpmAck }),
  encodeFrame({
    _tag: "ComplexAck",
    invokeId: 1,
    service: 12,
    body: rpAck,
    segment: { sequenceNumber: 0, moreFollows: true, windowSize: 1 }
  }),
  encodeFrame({ _tag: "Abort", invokeId: 1, reason: 4, fromServer: true }),
  encodeFrame({ _tag: "Error", invokeId: 1, service: 12, body: encodeErrorBody({ errorClass: 1, errorCode: 2 }) })
]

const decoders: Array<[string, (bytes: Uint8Array) => unknown]> = [
  ["decodeFrame", decodeFrame],
  ["decodeNpdu", decodeNpdu],
  ["decodeApdu", decodeApdu],
  ["decodeCovNotification", decodeCovNotification],
  ["decodeReadPropertyMultipleAck", decodeReadPropertyMultipleAck],
  ["decodeReadPropertyMultiple", decodeReadPropertyMultiple],
  ["decodeReadPropertyAck", decodeReadPropertyAck],
  ["decodeReadProperty", decodeReadProperty],
  ["decodeIAm", decodeIAm],
  ["decodeWhoIs", decodeWhoIs],
  ["decodeSubscribeCov", decodeSubscribeCov],
  ["decodeErrorBody", decodeErrorBody],
  ["decodeValues", decodeValues]
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
        // interesting bytes: extended lengths, opening/closing tags
        bytes.splice(
          at,
          0,
          [0xff, 0xfe, 0x0e, 0x0f, 0x3e, 0x3f, 0x4e, 0x4f, 0xf8, 0x75, 0x7d][Math.floor(random() * 11)] ?? 0
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

/** The tag of the error an encoder refuses with, or "encoded". */
const refused = (encode: () => unknown) => {
  const result = tryEncode(encode)
  return result._tag === "Failure" ? result.failure._tag : "encoded"
}

const objectId = (instance: number) => () => encodeReadProperty({ object: { objectType: 8, instance }, property: 85 })

describe("chaos: codec fuzzing", () => {
  it("never throws on mutated or random input, and stays fast", () => {
    const random = rng(1234)
    const thrown: Array<string> = []
    let slowest = 0
    let slowestWhat = ""
    const iterations = 20_000
    for (let i = 0; i < iterations; i++) {
      const pickRandom = random() < 0.1
      const seeds = random() < 0.5 ? frames : bodies
      const base = seeds[Math.floor(random() * seeds.length)] ?? new Uint8Array()
      const input = pickRandom
        ? Uint8Array.from({ length: Math.floor(random() * 64) }, () => Math.floor(random() * 256))
        : mutate(random, base)
      for (const [name, decode] of decoders) {
        const started = performance.now()
        try {
          decode(input)
        } catch (error) {
          if (thrown.length < 20) thrown.push(`${name}(${Buffer.from(input).toString("hex")}): ${String(error)}`)
        }
        const took = performance.now() - started
        if (took > slowest) {
          slowest = took
          slowestWhat = `${name} ${input.length} bytes`
        }
      }
    }
    expect(thrown).toEqual([])
    // One decode is microseconds; the bound catches runaway work, with room for a GC pause on a loaded runner.
    expect({ slowest: slowest < 1000, slowestWhat }).toMatchObject({ slowest: true })
  }, 60_000)

  it("handles worst-case datagrams quickly: 64 KB of nesting, bits, strings", () => {
    const timings: Record<string, number> = {}
    const time = (label: string, f: () => unknown) => {
      const started = performance.now()
      const result = f()
      timings[label] = performance.now() - started
      return result
    }
    // 65 000 opening/closing tag pairs of depth 1 inside a property value
    const pairs = new Uint8Array(65_000)
    for (let i = 0; i < pairs.length; i += 2) {
      pairs[i] = 0x0e
      pairs[i + 1] = 0x0f
    }
    time("flat constructed pairs", () => decodeValues(pairs))
    // deep nesting at 33 levels
    const deep = Uint8Array.from([...Array(33).fill(0x0e), ...Array(33).fill(0x0f)])
    expect((decodeValues(deep) as { _tag: string })._tag).toBe("Failure")
    // A bit string of 65 000 bytes => 520 000 booleans
    const bits = Uint8Array.from([0x85, 0xfe, 0xfd, 0xe9, 0, ...new Uint8Array(65_000 - 1)])
    time("bit-string 520k bits", () => decodeValues(bits))
    // A UCS-2 string of 65 000 bytes
    const ucs2 = Uint8Array.from([0x75, 0xfe, 0xfd, 0xe9, 4, ...new Uint8Array(65_000 - 1).fill(0x41)])
    time("ucs-2 string", () => decodeValues(ucs2))
    const latin = Uint8Array.from([0x75, 0xfe, 0xfd, 0xe9, 5, ...new Uint8Array(65_000 - 1).fill(0x41)])
    time("latin-1 string", () => decodeValues(latin))
    // Many tiny values: 32 000 nulls
    time("32k nulls", () => decodeValues(new Uint8Array(32_000)))
    // A COV notification with 10 000 property values in one datagram
    const many = encodeCovNotification({
      processId: 1,
      initiatingDevice: { objectType: 8, instance: 1 },
      object: { objectType: 0, instance: 1 },
      timeRemaining: 0,
      values: Array.from({ length: 6000 }, () => ({ property: 85, values: [{ type: "null" as const }] }))
    })
    time(`cov with 6000 values (${many.length} bytes)`, () => decodeCovNotification(many))
    // RPM ack with thousands of results
    const rpm = encodeReadPropertyMultipleAck(
      Array.from({ length: 3000 }, (_, i) => ({
        object: { objectType: 0, instance: i },
        results: [{ property: 85, _tag: "Value" as const, values: [{ type: "null" as const }] }]
      }))
    )
    time(`rpm ack 3000 objects (${rpm.length} bytes)`, () => decodeReadPropertyMultipleAck(rpm))
    for (const ms of Object.values(timings)) expect(ms).toBeLessThan(250)
  })

  it("encoders refuse values out of their range with a typed error instead of writing other bytes", () => {
    expect(refused(objectId(4_194_303))).toBe("encoded")
    expect(refused(objectId(4_194_304))).toBe("BacnetEncodeError")
    expect(refused(objectId(Number.NaN))).toBe("BacnetEncodeError")
    expect(refused(objectId(1.5))).toBe("BacnetEncodeError")
    expect(refused(() => encodeValues([{ type: "unsigned", value: -1 }]))).toBe("BacnetEncodeError")
    expect(refused(() => encodeValues([{ type: "unsigned", value: Number.NaN }]))).toBe("BacnetEncodeError")
    expect(refused(() => encodeValues([{ type: "unsigned", value: 2 ** 53 }]))).toBe("BacnetEncodeError")
    expect(refused(() => encodeValues([{ type: "signed", value: 2 ** 31 }]))).toBe("BacnetEncodeError")
    expect(refused(() => encodeValues([{ type: "real", value: Number.NaN }]))).toBe("encoded")
    expect(refused(() => encodeValues([{ type: "date", year: 3000, month: 1, day: 1, weekday: 1 }]))).toBe(
      "BacnetEncodeError"
    )
    expect(refused(() => encodeValues([{ type: "date", year: 2154, month: 14, day: 34, weekday: 0xff }]))).toBe(
      "encoded"
    )
    expect(refused(() => encodeValues([{ type: "date", year: undefined, month: 0, day: 1, weekday: 1 }]))).toBe(
      "BacnetEncodeError"
    )
    expect(refused(() => encodeValues([{ type: "time", hour: 24, minute: 0, second: 0, hundredths: 0 }]))).toBe(
      "BacnetEncodeError"
    )
    expect(
      refused(() => encodeSubscribeCov({ processId: 0xff_ff_ff_ff, object: { objectType: 0, instance: 1 } }))
    ).toBe("encoded")
    expect(refused(() => encodeSubscribeCov({ processId: 2 ** 32, object: { objectType: 0, instance: 1 } }))).toBe(
      "BacnetEncodeError"
    )
    expect(
      refused(() => encodeSubscribeCov({ processId: 1, object: { objectType: 0, instance: 1 }, lifetime: Number.NaN }))
    ).toBe("BacnetEncodeError")
    expect(refused(() => encodeWhoIs({ range: { low: 0, high: 4_194_304 } }))).toBe("BacnetEncodeError")
    expect(refused(() => encodeValues([{ type: "context", tagNumber: 255, data: new Uint8Array(1) }]))).toBe(
      "BacnetEncodeError"
    )
  })
})
