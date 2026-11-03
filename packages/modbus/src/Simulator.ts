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
  ExceptionCode,
  FunctionCode,
  maxReadQuantity,
  takeFrame
} from "./Frame.ts"
import type { ReadRequest } from "./Frame.ts"

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
      encodeValue(value, point.dataType).forEach((register, i) => table.set(point.address + i, register))
    }
  }
}

/** Knobs for fault injection in tests. Mutable on purpose: flip them while the server runs. */
export interface SimulatorControl {
  /** Read requests but never answer, to exercise client timeouts. */
  silent: boolean
  /** Requests received so far. */
  requests: number
}

export const makeSimulatorControl = (): SimulatorControl => ({ silent: false, requests: 0 })

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
