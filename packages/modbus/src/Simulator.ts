/**
 * A Modbus TCP server over an in-memory register bank, so the client and
 * driver are tested over real TCP without hardware (CLAUDE.md rule 8), and
 * `pnpm gateway` can poll a simulated device.
 *
 * Serves FC 01–04. Unmapped addresses answer "illegal data address" and other
 * function codes "illegal function", as a strict device would.
 */
import type { ModbusPoint } from "@plenum/core"
import { Effect } from "effect"
import type * as Socket from "effect/socket/Socket"
import type * as SocketServer from "effect/socket/SocketServer"
import {
  appendChunks,
  decodeRequest,
  encodeBitResponse,
  encodeExceptionResponse,
  encodeRegisterResponse,
  encodeValue,
  encodeWriteResponse,
  ExceptionCode,
  FunctionCode,
  maxReadQuantity,
  takeFrame
} from "./Frame.ts"
import type { ReadRequest, WriteRequest } from "./Frame.ts"

/** Simulated device memory, one map per Modbus table. */
export interface RegisterBank {
  readonly holding: Map<number, number>
  readonly input: Map<number, number>
  readonly coil: Map<number, boolean>
  readonly discrete: Map<number, boolean>
}

export const makeRegisterBank = (): RegisterBank => ({
  holding: new Map(),
  input: new Map(),
  coil: new Map(),
  discrete: new Map()
})

/** Store `value` where `point` reads it, encoded as the point's data type. */
export const setPointValue = (bank: RegisterBank, point: ModbusPoint, value: number | boolean): void => {
  const bit = typeof value === "boolean" ? value : value !== 0
  switch (point.table) {
    case "coil":
    case "discrete":
      bank[point.table].set(point.address, bit)
      return
    case "holding":
    case "input": {
      const table = bank[point.table]
      if (point.bit !== undefined) {
        // One bit of a register: the others keep what other points set.
        const current = table.get(point.address) ?? 0
        table.set(point.address, bit ? current | (1 << point.bit) : current & ~(1 << point.bit))
        return
      }
      encodeValue(value, point.dataType, point.byteOrder).forEach((register, i) =>
        table.set(point.address + i, register)
      )
    }
  }
}

/** Knobs for fault injection in tests. Mutable on purpose: flip them while the server runs. */
export interface SimulatorControl {
  /** Read requests but never answer, to exercise client timeouts. */
  silent: boolean
  /** Requests received so far. */
  requests: number
  /** Writes applied, in order. */
  readonly writes: Array<WriteRequest>
  /** Refuse every write with this exception code (a device in local override, say). */
  refuseWrites?: number
}

export const makeSimulatorControl = (): SimulatorControl => ({ silent: false, requests: 0, writes: [] })

const readTable = <A>(table: Map<number, A>, address: number, quantity: number): ReadonlyArray<A> | undefined => {
  const values: Array<A> = []
  for (let i = 0; i < quantity; i++) {
    const value = table.get(address + i)
    if (value === undefined) return undefined
    values.push(value)
  }
  return values
}

/** The response frame for one read request. Pure. */
export const answerRead = (bank: RegisterBank, request: ReadRequest): Uint8Array => {
  const refuse = (code: number) =>
    encodeExceptionResponse(request.transactionId, request.unitId, request.functionCode, code)
  if (request.quantity < 1 || request.quantity > maxReadQuantity(request.functionCode)) {
    return refuse(ExceptionCode.IllegalDataValue)
  }
  switch (request.functionCode) {
    case FunctionCode.ReadCoils:
    case FunctionCode.ReadDiscreteInputs: {
      const table = request.functionCode === FunctionCode.ReadCoils ? bank.coil : bank.discrete
      const bits = readTable(table, request.address, request.quantity)
      return bits === undefined ? refuse(ExceptionCode.IllegalDataAddress) : encodeBitResponse(request, bits)
    }
    case FunctionCode.ReadHoldingRegisters:
    case FunctionCode.ReadInputRegisters: {
      const table = request.functionCode === FunctionCode.ReadHoldingRegisters ? bank.holding : bank.input
      const registers = readTable(table, request.address, request.quantity)
      return registers === undefined
        ? refuse(ExceptionCode.IllegalDataAddress)
        : encodeRegisterResponse(request, registers)
    }
  }
}

/**
 * Apply one write to `bank` and return the response frame. Like a device, it
 * refuses an address it does not have; only coils and holding registers
 * can be written.
 */
export const answerWrite = (
  bank: RegisterBank,
  control: SimulatorControl,
  transactionId: number,
  unitId: number,
  request: WriteRequest
): Uint8Array => {
  const refuse = (code: number) => encodeExceptionResponse(transactionId, unitId, request.functionCode, code)
  if (control.refuseWrites !== undefined) return refuse(control.refuseWrites)
  switch (request.functionCode) {
    case FunctionCode.WriteSingleCoil:
      if (!bank.coil.has(request.address)) return refuse(ExceptionCode.IllegalDataAddress)
      bank.coil.set(request.address, request.value)
      break
    case FunctionCode.WriteSingleRegister:
      if (!bank.holding.has(request.address)) return refuse(ExceptionCode.IllegalDataAddress)
      bank.holding.set(request.address, request.value)
      break
    case FunctionCode.WriteMultipleRegisters:
      if (request.values.some((_, index) => !bank.holding.has(request.address + index))) {
        return refuse(ExceptionCode.IllegalDataAddress)
      }
      request.values.forEach((value, index) => bank.holding.set(request.address + index, value))
  }
  control.writes.push(request)
  return encodeWriteResponse(transactionId, unitId, request)
}

const serveConnection = (bank: RegisterBank, control: SimulatorControl) =>
  Effect.fnUntraced(
    function* (socket: Socket.Socket) {
      const writer = yield* socket.writer
      const { pull } = yield* socket.reader
      let buffer: Uint8Array = new Uint8Array(0)
      while (true) {
        buffer = appendChunks(buffer, yield* pull)
        let split = takeFrame(buffer)
        while (split._tag === "Frame") {
          buffer = split.rest
          control.requests++
          const decoded = yield* decodeRequest(split.frame)
          if (!control.silent) {
            yield* writer.write(
              decoded._tag === "Read"
                ? answerRead(bank, decoded.request)
                : decoded._tag === "Write"
                  ? answerWrite(bank, control, decoded.transactionId, decoded.unitId, decoded.request)
                  : encodeExceptionResponse(
                      decoded.transactionId,
                      decoded.unitId,
                      decoded.functionCode,
                      ExceptionCode.IllegalFunction
                    )
            )
          }
          split = takeFrame(buffer)
        }
        // A real device drops a connection it cannot parse; so does the simulator.
        if (split._tag === "Invalid") return
      }
    },
    Effect.scoped,
    // The peer closing the connection, or a request too garbled to answer, ends this connection only.
    Effect.catchTags({ SocketError: () => Effect.void, ModbusFrameError: () => Effect.void })
  )

/** Serve `bank` on `server` until the surrounding scope closes. */
export const serveModbus = (
  server: SocketServer.SocketServer["Service"],
  bank: RegisterBank,
  control: SimulatorControl = makeSimulatorControl()
): Effect.Effect<never, SocketServer.SocketServerError> => server.run(serveConnection(bank, control))
