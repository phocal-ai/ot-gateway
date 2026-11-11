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
  exceptionName,
  FunctionCode,
  isTransientException,
  takeFrame,
  encodeWriteRequest,
  encodeWriteResponse,
  decodeWriteResponse,
  ExceptionCode
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
      const res = yield* decodeReadResponse(frame, { unitId: 0x11, functionCode: 3, quantity: 2 })
      expect(res.registers).toEqual([0x022b, 0x0064])
      expect(res.unitId).toBe(0x11)
    })
  )

  it.effect("surfaces exceptions as typed errors", () =>
    Effect.gen(function* () {
      const frame = Uint8Array.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x11, 0x83, 0x02])
      const exit = yield* Effect.exit(decodeReadResponse(frame, { unitId: 0x11, functionCode: 3, quantity: 1 }))
      expect(Exit.isFailure(exit)).toBe(true)
      const error = yield* Effect.flip(decodeReadResponse(frame, { unitId: 0x11, functionCode: 3, quantity: 1 }))
      expect(error._tag).toBe("ModbusException")
    })
  )

  it.effect("rejects truncated frames", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeReadResponse(Uint8Array.from([0, 1, 0, 0]), { unitId: 1, functionCode: 3, quantity: 1 })
      )
      expect(error._tag).toBe("ModbusFrameError")
    })
  )

  it.effect("rejects fewer registers than requested instead of filling in zeros", () =>
    Effect.gen(function* () {
      const request = { transactionId: 1, unitId: 1, functionCode: FunctionCode.ReadHoldingRegisters, address: 100 }
      const short = encodeRegisterResponse({ ...request, quantity: 1 }, [1234])
      const error = yield* Effect.flip(decodeReadResponse(short, { unitId: 1, functionCode: 3, quantity: 4 }))
      expect(error).toMatchObject({ _tag: "ModbusFrameError", message: "byte count 2 does not fit 4 registers" })
    })
  )

  it.effect("rejects a response to a different function code", () =>
    Effect.gen(function* () {
      const request = { transactionId: 1, unitId: 1, functionCode: FunctionCode.ReadInputRegisters, address: 0 }
      const input = encodeRegisterResponse({ ...request, quantity: 2 }, [1, 2])
      const error = yield* Effect.flip(decodeReadResponse(input, { unitId: 1, functionCode: 3, quantity: 2 }))
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
  // The registers as each byte order sends a value (ByteOrder in @ot-gateway/core).
  it.each([
    ["ABCD", [0x1234, 0x5678]],
    ["CDAB", [0x5678, 0x1234]],
    ["BADC", [0x3412, 0x7856]],
    ["DCBA", [0x7856, 0x3412]]
  ] as const)("reads uint32 0x12345678 sent as %s", (order, registers) => {
    expect(decodeValue(registers, "uint32", order)).toBe(0x12345678)
    expect(encodeValue(0x12345678, "uint32", order)).toEqual(registers)
  })
  it.each([
    ["ABCD", [0x41ac, 0x0000]],
    ["CDAB", [0x0000, 0x41ac]],
    ["BADC", [0xac41, 0x0000]],
    ["DCBA", [0x0000, 0xac41]]
  ] as const)("reads float32 21.5 sent as %s", (order, registers) => {
    expect(decodeValue(registers, "float32", order)).toBe(21.5)
  })
  it.each([
    [6.73, [0x40d7, 0x5c29]],
    [50.13, [0x4248, 0x851f]]
  ] as const)("reads float32 %s as that decimal, not the float64 its bits are", (value, registers) => {
    // As a float64 these bits are 6.730000019073486 and 50.130001068115234.
    expect(decodeValue(registers, "float32")).toBe(value)
    expect(encodeValue(value, "float32")).toEqual(registers)
  })
  it("only byte-swaps a single register (a word order means nothing in one word)", () => {
    expect(decodeValue([0x1234], "uint16", "CDAB")).toBe(0x1234)
    expect(decodeValue([0x3412], "uint16", "BADC")).toBe(0x1234)
    expect(decodeValue([0x3412], "uint16", "DCBA")).toBe(0x1234)
  })
  it.each([
    ["ABCD", [0x0001, 0x0203, 0x0405, 0x0607]],
    ["CDAB", [0x0607, 0x0405, 0x0203, 0x0001]],
    ["BADC", [0x0100, 0x0302, 0x0504, 0x0706]],
    ["DCBA", [0x0706, 0x0504, 0x0302, 0x0100]]
  ] as const)("reads uint64 0x0001020304050607 from four registers sent as %s", (order, registers) => {
    expect(decodeValue(registers, "uint64", order)).toBe(0x0001_0203_0405_0607)
    expect(encodeValue(0x0001_0203_0405_0607, "uint64", order)).toEqual(registers)
  })
  it("reads float64 and int64", () => {
    // 1.0 = 0x3FF0000000000000; -2 = 0xFFFFFFFFFFFFFFFE
    expect(decodeValue([0x3ff0, 0, 0, 0], "float64")).toBe(1)
    expect(decodeValue([0xffff, 0xffff, 0xffff, 0xfffe], "int64")).toBe(-2)
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
      const { bits } = yield* decodeBitResponse(frame, { unitId: 1, functionCode: 1, quantity: 19 })
      const asBits = bits.map((b) => (b ? 1 : 0))
      // 0xCD → coils 27..20 = 1100 1101, 0x6B → 35..28 = 0110 1011, 0x05 → 38..36 = 101
      expect(asBits).toEqual([1, 0, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1])
    })
  )

  it.effect("rejects a byte count that does not fit the quantity", () =>
    Effect.gen(function* () {
      const frame = Uint8Array.from([0x00, 0x02, 0x00, 0x00, 0x00, 0x04, 0x01, 0x01, 0x01, 0xff])
      const error = yield* Effect.flip(decodeBitResponse(frame, { unitId: 1, functionCode: 1, quantity: 19 }))
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
        decodeReadResponse(encodeExceptionResponse(3, 1, 0x03, 0x02), { unitId: 1, functionCode: 3, quantity: 1 })
      )
      expect(error).toMatchObject({ _tag: "ModbusException", functionCode: 3, exceptionCode: 2 })
    })
  )
})

describe("response matching (Implementation Guide §3.1.3, spec §7)", () => {
  const request = {
    transactionId: 9,
    unitId: 1,
    functionCode: FunctionCode.ReadHoldingRegisters,
    address: 0,
    quantity: 1
  }

  it.effect("rejects a response from another unit", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeReadResponse(encodeRegisterResponse({ ...request, unitId: 99 }, [42]), request)
      )
      expect(error).toMatchObject({ _tag: "ModbusFrameError" })
      expect(error.message).toContain("unit 99")
    })
  )

  it.effect("rejects an exception that answers another function", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeReadResponse(encodeExceptionResponse(9, 1, 0x2b, 0x02), request))
      expect(error._tag).toBe("ModbusFrameError")
    })
  )

  it.effect("rejects an exception response with extra bytes", () =>
    Effect.gen(function* () {
      const frame = Uint8Array.from([0, 9, 0, 0, 0, 4, 1, 0x83, 0x02, 0x00])
      const error = yield* Effect.flip(decodeReadResponse(frame, request))
      expect(error._tag).toBe("ModbusFrameError")
    })
  )

  it("tells transient exceptions from permanent ones", () => {
    expect([1, 2, 3, 4].map(isTransientException)).toEqual([false, false, false, false])
    expect([5, 6, 0x0a, 0x0b].map(isTransientException)).toEqual([true, true, true, true])
    expect(exceptionName(2)).toBe("illegal_data_address")
    expect(exceptionName(0x42)).toBe("exception_66")
  })
})

describe("encodeValue", () => {
  it.each([
    ["int16", -1234],
    ["uint16", 65535],
    ["int32", -70000],
    ["uint32", 4_000_000_000],
    ["float32", 21.5],
    ["int64", -9_000_000_000_000],
    ["uint64", 9_000_000_000_000_000],
    ["float64", 0.1],
    ["bool", true]
  ] as const)("round-trips %s in every byte order", (dataType, value) => {
    for (const order of ["ABCD", "CDAB", "BADC", "DCBA"] as const) {
      expect(decodeValue(encodeValue(value, dataType, order), dataType, order)).toBe(value)
    }
  })
})

/** The PDU of a frame: everything after the 7-byte MBAP header. */
const pdu = (frame: Uint8Array) => [...frame.subarray(7)]

describe("writes (spec §6.5, §6.6, §6.12)", () => {
  it("encodes the spec's write single coil example: coil 173 ON", () => {
    const frame = encodeWriteRequest(1, 1, { functionCode: FunctionCode.WriteSingleCoil, address: 172, value: true })
    expect(pdu(frame)).toEqual([0x05, 0x00, 0xac, 0xff, 0x00])
  })

  it("encodes the spec's write single register example: register 2 to 3", () => {
    const frame = encodeWriteRequest(1, 1, { functionCode: FunctionCode.WriteSingleRegister, address: 1, value: 3 })
    expect(pdu(frame)).toEqual([0x06, 0x00, 0x01, 0x00, 0x03])
  })

  it("encodes the spec's write multiple registers example, and its response", () => {
    const request = { functionCode: FunctionCode.WriteMultipleRegisters, address: 1, values: [0x000a, 0x0102] } as const
    expect(pdu(encodeWriteRequest(1, 1, request))).toEqual([0x10, 0x00, 0x01, 0x00, 0x02, 0x04, 0x00, 0x0a, 0x01, 0x02])
    expect(pdu(encodeWriteResponse(1, 1, request))).toEqual([0x10, 0x00, 0x01, 0x00, 0x02])
  })

  it.effect("accepts the echo, and refuses an echo of another write or an exception", () =>
    Effect.gen(function* () {
      const request = { functionCode: FunctionCode.WriteSingleRegister, address: 1, value: 3 } as const
      yield* decodeWriteResponse(encodeWriteResponse(7, 1, request), 1, request)
      const other = encodeWriteResponse(7, 1, { ...request, value: 4 })
      expect((yield* Effect.flip(decodeWriteResponse(other, 1, request)))._tag).toBe("ModbusFrameError")
      const refused = encodeExceptionResponse(7, 1, FunctionCode.WriteSingleRegister, ExceptionCode.IllegalDataAddress)
      const error = yield* Effect.flip(decodeWriteResponse(refused, 1, request))
      expect(error._tag === "ModbusException" && error.exceptionCode).toBe(ExceptionCode.IllegalDataAddress)
    })
  )

  it.effect("round-trips every write through the server-side decoder", () =>
    Effect.gen(function* () {
      const requests = [
        { functionCode: FunctionCode.WriteSingleCoil, address: 3, value: false },
        { functionCode: FunctionCode.WriteSingleRegister, address: 9, value: 0xbeef },
        { functionCode: FunctionCode.WriteMultipleRegisters, address: 100, values: [1, 2] }
      ] as const
      for (const request of requests) {
        const decoded = yield* decodeRequest(encodeWriteRequest(5, 2, request))
        expect(decoded).toEqual({ _tag: "Write", transactionId: 5, unitId: 2, request })
      }
    })
  )
})
