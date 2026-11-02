import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import {
  decodeBitResponse,
  decodeReadResponse,
  decodeRequest,
  decodeValue,
  encodeBitResponse,
  encodeExceptionResponse,
  encodeReadRequest,
  encodeRegisterResponse,
  encodeValue,
  FunctionCode,
  takeFrame
} from "../src/index.ts"

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
    Effect.gen(function* () {
      const frame = Uint8Array.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x07, 0x11, 0x03, 0x04, 0x02, 0x2b, 0x00, 0x64])
      const res = yield* decodeReadResponse(frame, { functionCode: 3, quantity: 2 })
      expect(res.registers).toEqual([0x022b, 0x0064])
      expect(res.unitId).toBe(0x11)
    })
  )

  it.effect("surfaces exceptions as typed errors", () =>
    Effect.gen(function* () {
      const frame = Uint8Array.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x11, 0x83, 0x02])
      const exit = yield* Effect.exit(decodeReadResponse(frame, { functionCode: 3, quantity: 1 }))
      expect(Exit.isFailure(exit)).toBe(true)
      const error = yield* Effect.flip(decodeReadResponse(frame, { functionCode: 3, quantity: 1 }))
      expect(error._tag).toBe("ModbusException")
    })
  )

  it.effect("rejects truncated frames", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeReadResponse(Uint8Array.from([0, 1, 0, 0]), { functionCode: 3, quantity: 1 })
      )
      expect(error._tag).toBe("ModbusFrameError")
    })
  )

  it.effect("rejects fewer registers than requested instead of filling in zeros", () =>
    Effect.gen(function* () {
      const request = { transactionId: 1, unitId: 1, functionCode: FunctionCode.ReadHoldingRegisters, address: 100 }
      const short = encodeRegisterResponse({ ...request, quantity: 1 }, [1234])
      const error = yield* Effect.flip(decodeReadResponse(short, { functionCode: 3, quantity: 4 }))
      expect(error).toMatchObject({ _tag: "ModbusFrameError", message: "byte count 2 does not fit 4 registers" })
    })
  )

  it.effect("rejects a response to a different function code", () =>
    Effect.gen(function* () {
      const request = { transactionId: 1, unitId: 1, functionCode: FunctionCode.ReadInputRegisters, address: 0 }
      const input = encodeRegisterResponse({ ...request, quantity: 2 }, [1, 2])
      const error = yield* Effect.flip(decodeReadResponse(input, { functionCode: 3, quantity: 2 }))
      expect(error).toMatchObject({
        _tag: "ModbusFrameError",
        message: "response function code 4 does not answer request 3"
      })
    })
  )
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

describe("takeFrame", () => {
  const frame = [0x00, 0x01, 0x00, 0x00, 0x00, 0x05, 0x11, 0x03, 0x02, 0x00, 0x2a]

  it("waits for the rest of a split frame", () => {
    expect(takeFrame(Uint8Array.from(frame.slice(0, 4)))._tag).toBe("Incomplete")
    expect(takeFrame(Uint8Array.from(frame.slice(0, 10)))._tag).toBe("Incomplete")
  })

  it("takes one frame and keeps the bytes after it", () => {
    const split = takeFrame(Uint8Array.from([...frame, ...frame.slice(0, 3)]))
    expect(split._tag).toBe("Frame")
    if (split._tag !== "Frame") return
    expect(Array.from(split.frame)).toEqual(frame)
    expect(Array.from(split.rest)).toEqual(frame.slice(0, 3))
  })

  it("rejects a stream that is not Modbus", () => {
    expect(takeFrame(Uint8Array.from([0, 1, 0, 7, 0, 5, 1, 3]))._tag).toBe("Invalid")
    expect(takeFrame(Uint8Array.from([0, 1, 0, 0, 0xff, 0xff, 1]))._tag).toBe("Invalid")
  })
})

describe("decodeBitResponse", () => {
  it.effect("unpacks coils LSB first (spec §6.1 example: coils 20–38)", () =>
    Effect.gen(function* () {
      const frame = Uint8Array.from([0x00, 0x02, 0x00, 0x00, 0x00, 0x06, 0x01, 0x01, 0x03, 0xcd, 0x6b, 0x05])
      const { bits } = yield* decodeBitResponse(frame, { functionCode: 1, quantity: 19 })
      const asBits = bits.map((b) => (b ? 1 : 0))
      // 0xCD → coils 27..20 = 1100 1101, 0x6B → 35..28 = 0110 1011, 0x05 → 38..36 = 101
      expect(asBits).toEqual([1, 0, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1])
    })
  )

  it.effect("rejects a byte count that does not fit the quantity", () =>
    Effect.gen(function* () {
      const frame = Uint8Array.from([0x00, 0x02, 0x00, 0x00, 0x00, 0x04, 0x01, 0x01, 0x01, 0xff])
      const error = yield* Effect.flip(decodeBitResponse(frame, { functionCode: 1, quantity: 19 }))
      expect(error._tag).toBe("ModbusFrameError")
    })
  )
})

describe("server side", () => {
  it.effect("decodes a read request and answers it", () =>
    Effect.gen(function* () {
      const request = {
        transactionId: 7,
        unitId: 1,
        functionCode: FunctionCode.ReadInputRegisters,
        address: 8,
        quantity: 2
      }
      const decoded = yield* decodeRequest(encodeReadRequest(request))
      expect(decoded).toEqual({ _tag: "Read", request })
      const response = yield* decodeReadResponse(encodeRegisterResponse(request, [1, 0xffff]), request)
      expect(response).toEqual({ transactionId: 7, unitId: 1, functionCode: 4, registers: [1, 0xffff] })
    })
  )

  it.effect("round-trips bits", () =>
    Effect.gen(function* () {
      const request = { transactionId: 1, unitId: 1, functionCode: FunctionCode.ReadCoils, address: 0, quantity: 10 }
      const bits = [true, false, false, true, true, false, true, false, true, true]
      const response = yield* decodeBitResponse(encodeBitResponse(request, bits), request)
      expect(response.bits).toEqual(bits)
    })
  )

  it.effect("reports unsupported function codes and encodes exceptions", () =>
    Effect.gen(function* () {
      const frame = Uint8Array.from([0, 3, 0, 0, 0, 6, 1, 0x2b, 0x0e, 0x01, 0x00, 0x00])
      expect(yield* decodeRequest(frame)).toEqual({
        _tag: "Unsupported",
        transactionId: 3,
        unitId: 1,
        functionCode: 0x2b
      })
      const error = yield* Effect.flip(
        decodeReadResponse(encodeExceptionResponse(3, 1, 0x03, 0x02), { functionCode: 3, quantity: 1 })
      )
      expect(error).toMatchObject({ _tag: "ModbusException", functionCode: 3, exceptionCode: 2 })
    })
  )
})

describe("encodeValue", () => {
  it.each([
    ["int16", -1234],
    ["uint16", 65535],
    ["int32", -70000],
    ["uint32", 4_000_000_000],
    ["float32", 21.5],
    ["bool", true]
  ] as const)("round-trips %s", (dataType, value) => {
    expect(decodeValue(encodeValue(value, dataType), dataType)).toBe(value)
  })
})
