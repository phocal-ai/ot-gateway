/**
 * Modbus TCP framing: MBAP header + PDU.
 *
 * Pure encode/decode functions, no I/O. The client wires these to an Effect
 * socket. Reference: Modbus Application Protocol v1.1b3 and
 * Modbus Messaging on TCP/IP Implementation Guide v1.0b.
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
  readonly functionCode: RegisterReadCode
  readonly address: number
  /** Number of 16-bit registers, 1 to 125. */
  readonly quantity: number
}

/** Encode a Read Holding / Input Registers request (12 bytes). */
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

export interface ReadResponse {
  readonly transactionId: number
  readonly unitId: number
  readonly functionCode: number
  readonly registers: ReadonlyArray<number>
}

/** Decode a register read response, failing on malformed frames and exceptions. */
export const decodeReadResponse = (
  frame: Uint8Array
): Effect.Effect<ReadResponse, ModbusFrameError | ModbusException> =>
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
    if ((functionCode & 0x80) !== 0) {
      return yield* new ModbusException({ functionCode: functionCode & 0x7f, exceptionCode: view.getUint8(8) })
    }
    const byteCount = view.getUint8(8)
    if (byteCount % 2 !== 0 || frame.length !== 9 + byteCount) {
      return yield* new ModbusFrameError({ message: `invalid byte count ${byteCount}` })
    }
    const registers: Array<number> = []
    for (let i = 0; i < byteCount; i += 2) registers.push(view.getUint16(9 + i))
    return { transactionId, unitId, functionCode, registers }
  })

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
