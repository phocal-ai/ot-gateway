import { describe, expect, it } from "@effect/vitest"
import { decodeVariableByteInteger, encodeUtf8String, encodeVariableByteInteger } from "../src/index.ts"

describe("variable byte integer", () => {
  it.each([
    [0, [0x00]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [16_383, [0xff, 0x7f]],
    [16_384, [0x80, 0x80, 0x01]],
    [268_435_455, [0xff, 0xff, 0xff, 0x7f]]
  ])("encodes %i", (value, bytes) => {
    expect(Array.from(encodeVariableByteInteger(value))).toEqual(bytes)
    expect(decodeVariableByteInteger(Uint8Array.from(bytes))).toEqual({ value, length: bytes.length })
  })

  it("asks for more bytes when the input is incomplete", () => {
    expect(decodeVariableByteInteger(Uint8Array.from([0x80]))).toBeUndefined()
  })

  it("rejects a fifth continuation byte", () => {
    const result = decodeVariableByteInteger(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x01]))
    expect(result).toMatchObject({ _tag: "MqttCodecError" })
  })
})

describe("encodeUtf8String", () => {
  it("prefixes the byte length", () => {
    expect(Array.from(encodeUtf8String("MQTT"))).toEqual([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54])
  })
})
