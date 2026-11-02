/**
 * Modbus TCP framing: MBAP header + PDU.
 *
 * Pure encode/decode functions, no I/O. The client and the simulator wire
 * these to an Effect socket. References:
 * - Modbus Application Protocol Specification v1.1b3 (MBAP-free PDUs, §6, §7)
 * - Modbus Messaging on TCP/IP Implementation Guide v1.0b (MBAP header, §3.1.3)
 */
import { Effect, Schema } from "effect"
import type { DataType } from "@plenum/core"

export const FunctionCode = {
  ReadCoils: 0x01,
  ReadDiscreteInputs: 0x02,
  ReadHoldingRegisters: 0x03,
  ReadInputRegisters: 0x04,
  WriteSingleRegister: 0x06,
  WriteMultipleRegisters: 0x10
} as const
export type RegisterReadCode = typeof FunctionCode.ReadHoldingRegisters | typeof FunctionCode.ReadInputRegisters
export type BitReadCode = typeof FunctionCode.ReadCoils | typeof FunctionCode.ReadDiscreteInputs
export type ReadCode = RegisterReadCode | BitReadCode

/** Exception codes a server answers with (spec §7). */
export const ExceptionCode = {
  IllegalFunction: 0x01,
  IllegalDataAddress: 0x02,
  IllegalDataValue: 0x03,
  ServerDeviceFailure: 0x04,
  Acknowledge: 0x05,
  ServerDeviceBusy: 0x06,
  GatewayPathUnavailable: 0x0a,
  GatewayTargetFailedToRespond: 0x0b
} as const

const exceptionNames: Record<number, string> = {
  [ExceptionCode.IllegalFunction]: "illegal_function",
  [ExceptionCode.IllegalDataAddress]: "illegal_data_address",
  [ExceptionCode.IllegalDataValue]: "illegal_data_value",
  [ExceptionCode.ServerDeviceFailure]: "server_device_failure",
  [ExceptionCode.Acknowledge]: "acknowledge",
  [ExceptionCode.ServerDeviceBusy]: "server_device_busy",
  [ExceptionCode.GatewayPathUnavailable]: "gateway_path_unavailable",
  [ExceptionCode.GatewayTargetFailedToRespond]: "gateway_target_failed_to_respond"
}

/** A stable, label-safe name for an exception code (spec §7), e.g. `illegal_data_address`. */
export const exceptionName = (code: number): string => exceptionNames[code] ?? `exception_${code}`

/**
 * Whether asking again soon can succeed (spec §7): the device is still busy
 * with a long command (05, 06) or a gateway could not reach its target (0A,
 * 0B). Every other code describes the request itself or the device's state,
 * so repeating the same request gets the same answer.
 */
export const isTransientException = (code: number): boolean =>
  code === ExceptionCode.Acknowledge ||
  code === ExceptionCode.ServerDeviceBusy ||
  code === ExceptionCode.GatewayPathUnavailable ||
  code === ExceptionCode.GatewayTargetFailedToRespond

/** Largest quantity one read may ask for (spec §6.1–6.4). */
export const maxReadQuantity = (functionCode: ReadCode): number =>
  functionCode === FunctionCode.ReadCoils || functionCode === FunctionCode.ReadDiscreteInputs ? 2000 : 125

/** MBAP header (7 bytes) plus the largest PDU (253 bytes). */
const maxFrameLength = 260

/** The response could not be parsed. */
export class ModbusFrameError extends Schema.TaggedError<ModbusFrameError>()("ModbusFrameError", {
  message: Schema.String
}) {}

/** The device answered with a Modbus exception (function code | 0x80). */
export class ModbusException extends Schema.TaggedError<ModbusException>()("ModbusException", {
  functionCode: Schema.Int,
  exceptionCode: Schema.Int
}) {}

export interface ReadRequest {
  readonly transactionId: number
  readonly unitId: number
  readonly functionCode: ReadCode
  readonly address: number
  /** Registers (1 to 125) or bits (1 to 2000). */
  readonly quantity: number
}

/** Encode a read request for any of FC 01–04; they share one layout (12 bytes). */
export const encodeReadRequest = (req: ReadRequest): Uint8Array => {
  const buf = new Uint8Array(12)
  const view = new DataView(buf.buffer)
  view.setUint16(0, req.transactionId & 0xffff)
  view.setUint16(2, 0) // protocol id: always 0 for Modbus
  view.setUint16(4, 6) // length: unit id + 5 PDU bytes
  view.setUint8(6, req.unitId)
  view.setUint8(7, req.functionCode)
  view.setUint16(8, req.address)
  view.setUint16(10, req.quantity)
  return buf
}

const encoder = new TextEncoder()

/** Append socket chunks to a receive buffer (a socket may deliver strings; Modbus is bytes). */
export const appendChunks = (buffer: Uint8Array, chunks: ReadonlyArray<Uint8Array | string>): Uint8Array => {
  const bytes = chunks.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk))
  const out = new Uint8Array(buffer.length + bytes.reduce((n, b) => n + b.length, 0))
  out.set(buffer, 0)
  let offset = buffer.length
  for (const b of bytes) {
    out.set(b, offset)
    offset += b.length
  }
  return out
}

/** The result of looking for one complete frame at the start of a byte stream. */
export type FrameSplit =
  | { readonly _tag: "Incomplete" }
  | { readonly _tag: "Frame"; readonly frame: Uint8Array; readonly rest: Uint8Array }
  | { readonly _tag: "Invalid"; readonly message: string }

/**
 * Take one MBAP frame off the front of `buffer`. TCP delivers a byte stream,
 * so a frame can arrive split or several can arrive together; the MBAP length
 * field (bytes after itself) says where each frame ends.
 */
export const takeFrame = (buffer: Uint8Array): FrameSplit => {
  if (buffer.length < 7) return { _tag: "Incomplete" }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const protocolId = view.getUint16(2)
  const length = view.getUint16(4)
  if (protocolId !== 0) return { _tag: "Invalid", message: `unexpected protocol id ${protocolId}` }
  if (length < 2 || 6 + length > maxFrameLength) return { _tag: "Invalid", message: `invalid length field ${length}` }
  const total = 6 + length
  if (buffer.length < total) return { _tag: "Incomplete" }
  return { _tag: "Frame", frame: buffer.subarray(0, total), rest: buffer.subarray(total) }
}

/**
 * The transaction identifier of a frame from `takeFrame`: the first MBAP
 * field, which a server copies from the request so the client can pair them
 * (Implementation Guide §3.1.3).
 */
export const frameTransactionId = (frame: Uint8Array): number => ((frame[0] ?? 0) << 8) | (frame[1] ?? 0)

interface ResponseHeader {
  readonly transactionId: number
  readonly unitId: number
  readonly functionCode: number
  /** The data bytes after the byte count. */
  readonly data: Uint8Array
}

/** What a response must answer: the request's unit, function code and quantity. */
export interface ExpectedResponse {
  readonly unitId: number
  readonly functionCode: number
  readonly quantity: number
}

/**
 * Parse the MBAP header and the byte-counted body shared by FC 01–04
 * responses. The server echoes the request's unit identifier (Implementation
 * Guide §3.1.3, MBAP header). A normal response repeats the request's function
 * code (spec §4.1); an exception response carries it with the high bit set
 * (spec §7). Anything else answers some other request.
 */
const decodeReadBody = (
  frame: Uint8Array,
  expected: ExpectedResponse
): Effect.Effect<ResponseHeader, ModbusFrameError | ModbusException> =>
  Effect.gen(function* () {
    if (frame.length < 9) {
      return yield* new ModbusFrameError({ message: `frame too short: ${frame.length} bytes` })
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const transactionId = view.getUint16(0)
    const protocolId = view.getUint16(2)
    const length = view.getUint16(4)
    const unitId = view.getUint8(6)
    const functionCode = view.getUint8(7)
    if (protocolId !== 0) {
      return yield* new ModbusFrameError({ message: `unexpected protocol id ${protocolId}` })
    }
    if (frame.length !== 6 + length) {
      return yield* new ModbusFrameError({ message: `length field ${length} does not match frame` })
    }
    if (unitId !== expected.unitId) {
      return yield* new ModbusFrameError({
        message: `response from unit ${unitId} does not answer a request to unit ${expected.unitId}`
      })
    }
    if (functionCode === (expected.functionCode | 0x80)) {
      if (frame.length !== 9) {
        return yield* new ModbusFrameError({ message: `exception response must be 9 bytes, got ${frame.length}` })
      }
      return yield* new ModbusException({ functionCode: expected.functionCode, exceptionCode: view.getUint8(8) })
    }
    if (functionCode !== expected.functionCode) {
      return yield* new ModbusFrameError({
        message: `response function code ${functionCode} does not answer request ${expected.functionCode}`
      })
    }
    const byteCount = view.getUint8(8)
    if (frame.length !== 9 + byteCount) {
      return yield* new ModbusFrameError({ message: `invalid byte count ${byteCount}` })
    }
    return { transactionId, unitId, functionCode, data: frame.subarray(9) }
  })

export interface ReadResponse {
  readonly transactionId: number
  readonly unitId: number
  readonly functionCode: number
  readonly registers: ReadonlyArray<number>
}

/**
 * Decode a register read response (FC 03/04, spec §6.3–6.4), failing on
 * malformed frames, exceptions, and a register count other than requested
 * (a short answer must never turn into made-up zeros).
 */
export const decodeReadResponse = (
  frame: Uint8Array,
  expected: ExpectedResponse
): Effect.Effect<ReadResponse, ModbusFrameError | ModbusException> =>
  Effect.gen(function* () {
    const { data, ...header } = yield* decodeReadBody(frame, expected)
    if (data.length !== 2 * expected.quantity) {
      return yield* new ModbusFrameError({
        message: `byte count ${data.length} does not fit ${expected.quantity} registers`
      })
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const registers: Array<number> = []
    for (let i = 0; i < data.length; i += 2) registers.push(view.getUint16(i))
    return { ...header, registers }
  })

export interface BitResponse {
  readonly transactionId: number
  readonly unitId: number
  readonly functionCode: number
  readonly bits: ReadonlyArray<boolean>
}

/**
 * Decode a coil or discrete input response (FC 01/02, spec §6.1–6.2). Bits are
 * packed LSB first; `quantity` says how many of the padded bits are real.
 */
export const decodeBitResponse = (
  frame: Uint8Array,
  expected: ExpectedResponse
): Effect.Effect<BitResponse, ModbusFrameError | ModbusException> =>
  Effect.gen(function* () {
    const { quantity } = expected
    const { data, ...header } = yield* decodeReadBody(frame, expected)
    if (data.length !== Math.ceil(quantity / 8)) {
      return yield* new ModbusFrameError({ message: `byte count ${data.length} does not fit ${quantity} bits` })
    }
    const bits: Array<boolean> = []
    for (let i = 0; i < quantity; i++) bits.push((((data[i >> 3] ?? 0) >> (i & 7)) & 1) === 1)
    return { ...header, bits }
  })

/** A request as a server sees it: a read it can answer, or a function it does not support. */
export type DecodedRequest =
  | { readonly _tag: "Read"; readonly request: ReadRequest }
  | {
      readonly _tag: "Unsupported"
      readonly transactionId: number
      readonly unitId: number
      readonly functionCode: number
    }

/** Decode a request frame on the server side (used by the simulator). */
export const decodeRequest = (frame: Uint8Array): Effect.Effect<DecodedRequest, ModbusFrameError> =>
  Effect.gen(function* () {
    if (frame.length < 8) {
      return yield* new ModbusFrameError({ message: `request too short: ${frame.length} bytes` })
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const transactionId = view.getUint16(0)
    const unitId = view.getUint8(6)
    const functionCode = view.getUint8(7)
    switch (functionCode) {
      case FunctionCode.ReadCoils:
      case FunctionCode.ReadDiscreteInputs:
      case FunctionCode.ReadHoldingRegisters:
      case FunctionCode.ReadInputRegisters: {
        if (frame.length !== 12) {
          return yield* new ModbusFrameError({ message: `read request must be 12 bytes, got ${frame.length}` })
        }
        const request = {
          transactionId,
          unitId,
          functionCode,
          address: view.getUint16(8),
          quantity: view.getUint16(10)
        }
        return { _tag: "Read", request } as const
      }
      default:
        return { _tag: "Unsupported", transactionId, unitId, functionCode } as const
    }
  })

/** MBAP header plus function code and byte-counted data. */
const encodeResponse = (transactionId: number, unitId: number, functionCode: number, data: Uint8Array) => {
  const buf = new Uint8Array(9 + data.length)
  const view = new DataView(buf.buffer)
  view.setUint16(0, transactionId & 0xffff)
  view.setUint16(2, 0)
  view.setUint16(4, 3 + data.length)
  view.setUint8(6, unitId)
  view.setUint8(7, functionCode)
  view.setUint8(8, data.length)
  buf.set(data, 9)
  return buf
}

/** Encode a register read response (FC 03/04). */
export const encodeRegisterResponse = (req: ReadRequest, registers: ReadonlyArray<number>): Uint8Array => {
  const data = new Uint8Array(registers.length * 2)
  const view = new DataView(data.buffer)
  registers.forEach((register, i) => view.setUint16(i * 2, register & 0xffff))
  return encodeResponse(req.transactionId, req.unitId, req.functionCode, data)
}

/** Encode a coil or discrete input response (FC 01/02), packing bits LSB first. */
export const encodeBitResponse = (req: ReadRequest, bits: ReadonlyArray<boolean>): Uint8Array => {
  const data = new Uint8Array(Math.ceil(bits.length / 8))
  bits.forEach((bit, i) => {
    if (bit) data[i >> 3] = (data[i >> 3] ?? 0) | (1 << (i & 7))
  })
  return encodeResponse(req.transactionId, req.unitId, req.functionCode, data)
}

/** Encode an exception response (spec §7): function code with the high bit set, then the code. */
export const encodeExceptionResponse = (
  transactionId: number,
  unitId: number,
  functionCode: number,
  exceptionCode: number
): Uint8Array => {
  const buf = new Uint8Array(9)
  const view = new DataView(buf.buffer)
  view.setUint16(0, transactionId & 0xffff)
  view.setUint16(2, 0)
  view.setUint16(4, 3)
  view.setUint8(6, unitId)
  view.setUint8(7, (functionCode | 0x80) & 0xff)
  view.setUint8(8, exceptionCode)
  return buf
}

/** Registers occupied by a data type. */
export const registerCount = (dataType: DataType): number =>
  dataType === "int32" || dataType === "uint32" || dataType === "float32" ? 2 : 1

/**
 * Decode a value from registers, big-endian with the high word first
 * (the most common layout). Word-swapped devices are a later option.
 */
export const decodeValue = (registers: ReadonlyArray<number>, dataType: DataType): number | boolean => {
  const view = new DataView(new ArrayBuffer(4))
  view.setUint16(0, registers[0] ?? 0)
  view.setUint16(2, registers[1] ?? 0)
  switch (dataType) {
    case "bool":
      return (registers[0] ?? 0) !== 0
    case "uint16":
      return view.getUint16(0)
    case "int16":
      return view.getInt16(0)
    case "uint32":
      return view.getUint32(0)
    case "int32":
      return view.getInt32(0)
    case "float32":
      return view.getFloat32(0)
  }
}

/** The inverse of `decodeValue`: the registers holding `value` as `dataType`. Integers are truncated and wrap. */
export const encodeValue = (value: number | boolean, dataType: DataType): ReadonlyArray<number> => {
  const view = new DataView(new ArrayBuffer(4))
  const numeric = typeof value === "boolean" ? Number(value) : value
  switch (dataType) {
    case "bool":
      return [numeric === 0 ? 0 : 1]
    case "uint16":
    case "int16":
      view.setUint16(0, Math.trunc(numeric) & 0xffff)
      return [view.getUint16(0)]
    case "uint32":
    case "int32":
      view.setUint32(0, Math.trunc(numeric) >>> 0)
      return [view.getUint16(0), view.getUint16(2)]
    case "float32":
      view.setFloat32(0, numeric)
      return [view.getUint16(0), view.getUint16(2)]
  }
}
