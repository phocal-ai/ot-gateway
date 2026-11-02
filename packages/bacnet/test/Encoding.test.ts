/**
 * Tag and value encoding (ASHRAE 135, clause 20.2): fixed bytes where the
 * clause pins them, round trips for the rest.
 */
import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import {
  type BacnetValue,
  decodeValues,
  decodeWith,
  encodeValues,
  writeClosing,
  writeOpening,
  Writer
} from "../src/index.ts"

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ")
const bytesOf = (text: string) => Uint8Array.from(text.split(" "), (b) => Number.parseInt(b, 16))

/** Decode what `value` encodes to, for a round trip. */
const reencode = (value: BacnetValue) => decodeValues(encodeValues([value]))

describe("application values", () => {
  it.each<[string, BacnetValue, string]>([
    ["null", { type: "null" }, "00"],
    ["false", { type: "boolean", value: false }, "10"],
    ["true (value in the tag, 20.2.3)", { type: "boolean", value: true }, "11"],
    ["unsigned 0", { type: "unsigned", value: 0 }, "21 00"],
    ["unsigned 256", { type: "unsigned", value: 256 }, "22 01 00"],
    ["signed -1", { type: "signed", value: -1 }, "31 ff"],
    ["signed 128 needs two bytes", { type: "signed", value: 128 }, "32 00 80"],
    ["signed -129", { type: "signed", value: -129 }, "32 ff 7f"],
    ["character string, UTF-8", { type: "character-string", value: "Hi" }, "73 00 48 69"],
    ["status flags, all clear", { type: "bit-string", value: [false, false, false, false] }, "82 04 00"],
    ["bit string 101", { type: "bit-string", value: [true, false, true] }, "82 05 a0"],
    ["enumerated 3", { type: "enumerated", value: 3 }, "91 03"],
    ["date", { type: "date", year: 2026, month: 11, day: 2, weekday: 1 }, "a4 7e 0b 02 01"],
    ["time", { type: "time", hour: 17, minute: 3, second: 0, hundredths: 0 }, "b4 11 03 00 00"],
    [
      "object identifier analog-input 5",
      { type: "object-identifier", value: { objectType: 0, instance: 5 } },
      "c4 00 00 00 05"
    ]
  ])("encodes %s", (_name, value, bytes) => {
    expect(hex(encodeValues([value]))).toBe(bytes)
    expect(reencode(value)).toEqual(Result.succeed([value]))
  })

  it("encodes a real as IEEE 754 single precision (Annex F: 72.4)", () => {
    expect(hex(encodeValues([{ type: "real", value: 72.4 }]))).toBe("44 42 90 cc cd")
    expect(reencode({ type: "real", value: 72.4 })).toEqual(
      Result.succeed([{ type: "real", value: Math.fround(72.4) }])
    )
  })

  it("uses an extended length above 4 bytes (20.2.1.3.1)", () => {
    const value: BacnetValue = { type: "octet-string", value: new Uint8Array(300).fill(7) }
    expect(hex(encodeValues([value]).subarray(0, 4))).toBe("65 fe 01 2c")
    expect(reencode(value)).toEqual(Result.succeed([value]))
  })

  it.each<BacnetValue>([
    { type: "double", value: 1.5e300 },
    { type: "date", year: undefined, month: 0xff, day: 0xff, weekday: 0xff },
    { type: "unsigned", value: 4_294_967_295 }
  ])("round-trips $type", (value) => {
    expect(reencode(value)).toEqual(Result.succeed([value]))
  })

  it("keeps context-tagged content of constructed values", () => {
    const value: BacnetValue = {
      type: "constructed",
      tagNumber: 0,
      values: [
        { type: "unsigned", value: 1 },
        { type: "context", tagNumber: 1, data: Uint8Array.of(9) }
      ]
    }
    expect(hex(encodeValues([value]))).toBe("0e 21 01 19 09 0f")
    expect(reencode(value)).toEqual(Result.succeed([value]))
  })
})

describe("tags", () => {
  it("extends tag numbers above 14 into a second octet (20.2.1.2)", () => {
    const writer = new Writer()
    writeOpening(writer, 20)
    writeClosing(writer, 20)
    expect(hex(writer.toBytes())).toBe("fe 14 ff 14")
    const decoded = decodeWith(writer.toBytes(), (reader) => [reader.tag(), reader.tag()])
    expect(decoded).toEqual(
      Result.succeed([
        { tagNumber: 20, context: true, kind: "opening", lengthValueType: 0 },
        { tagNumber: 20, context: true, kind: "closing", lengthValueType: 0 }
      ])
    )
  })
})

describe("decoding errors", () => {
  it.each([
    ["a truncated real", "44 42 90"],
    ["an unclosed constructed value", "0e 21 01"],
    ["a stray closing tag", "0f"],
    ["a non-UTF-8 character set", "73 04 48 69"],
    ["a reserved application tag", "d1 00"],
    ["a bit string with 9 unused bits", "82 09 00"]
  ])("rejects %s", (_name, bytes) => {
    const decoded = decodeValues(bytesOf(bytes))
    expect(Result.isFailure(decoded)).toBe(true)
  })

  it("rejects a value of the wrong type", () => {
    const decoded = decodeWith(bytesOf("91 03"), (reader) => reader.applicationUnsigned())
    expect(decoded).toMatchObject(
      Result.fail({ _tag: "BacnetCodecError", message: "expected unsigned, got enumerated" })
    )
  })

  it("rejects trailing bytes", () => {
    const decoded = decodeWith(bytesOf("21 01 00"), (reader) => reader.applicationUnsigned())
    expect(Result.isFailure(decoded)).toBe(true)
  })
})
