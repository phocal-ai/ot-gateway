import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { decodeReadResponse, decodeValue, encodeReadRequest, FunctionCode } from "../src/index.ts"

describe("encodeReadRequest", () => {
  it("builds MBAP header and PDU", () => {
    const frame = encodeReadRequest({
      transactionId: 0x0001,
      unitId: 0x11,
      functionCode: FunctionCode.ReadHoldingRegisters,
      address: 0x006b,
      quantity: 3
    })
    expect(Array.from(frame)).toEqual([0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x11, 0x03, 0x00, 0x6b, 0x00, 0x03])
  })
})

describe("decodeReadResponse", () => {
  it.effect("reads registers", () =>
    Effect.gen(function*() {
      const frame = Uint8Array.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x07, 0x11, 0x03, 0x04, 0x02, 0x2b, 0x00, 0x64])
      const res = yield* decodeReadResponse(frame)
      expect(res.registers).toEqual([0x022b, 0x0064])
      expect(res.unitId).toBe(0x11)
    }))

  it.effect("surfaces exceptions as typed errors", () =>
    Effect.gen(function*() {
      const frame = Uint8Array.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x11, 0x83, 0x02])
      const exit = yield* Effect.exit(decodeReadResponse(frame))
      expect(Exit.isFailure(exit)).toBe(true)
      const error = yield* Effect.flip(decodeReadResponse(frame))
      expect(error._tag).toBe("ModbusException")
    }))

  it.effect("rejects truncated frames", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(decodeReadResponse(Uint8Array.from([0, 1, 0, 0])))
      expect(error._tag).toBe("ModbusFrameError")
    }))
})

describe("decodeValue", () => {
  it("decodes signed and unsigned 16-bit values", () => {
    expect(decodeValue([0xffff], "int16")).toBe(-1)
    expect(decodeValue([0xffff], "uint16")).toBe(65535)
  })
  it("decodes float32 from two registers, high word first", () => {
    // 21.5 = 0x41AC0000
    expect(decodeValue([0x41ac, 0x0000], "float32")).toBeCloseTo(21.5)
  })
})
