/**
 * A Modbus TCP server over an in-memory register bank, so the client and
 * driver are tested over real TCP without hardware (CLAUDE.md rule 8), and
 * `pnpm gateway` can poll a simulated device.
 *
 * Serves FC 01–04. Unmapped addresses answer "illegal data address" and other
 * function codes "illegal function", as a strict device would.
 *
 * With one bank per unit id it plays a Modbus TCP gateway in front of an
 * RS-485 bus: a unit it does not have answers "gateway target failed to
 * respond", a unit in `silentUnits` never answers (a gateway that stays
 * quiet), and `maxConnections` refuses connections beyond the first few, as
 * many small gateways do.
 */
import type { ModbusPoint } from "@ot-gateway/core"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Effect, Option } from "effect"
import * as Socket from "effect/socket/Socket"
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
  /** Units whose requests are never answered: a serial device that is dead, behind a gateway that stays quiet. */
  readonly silentUnits: Set<number>
  /** Connections open at once beyond this are closed as soon as they are accepted. */
  maxConnections?: number
  /** Connections open now, and accepted so far (refused ones not counted). */
  open: number
  accepted: number
}

export const makeSimulatorControl = (): SimulatorControl => ({
  silent: false,
  requests: 0,
  writes: [],
  silentUnits: new Set(),
  open: 0,
  accepted: 0
})

/** One device's memory, or a gateway's: one bank per unit id. */
export type SimulatedUnits = RegisterBank | ReadonlyMap<number, RegisterBank>

const bankFor = (units: SimulatedUnits, unitId: number): RegisterBank | undefined =>
  "holding" in units ? units : units.get(unitId)

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

const serveConnection = (units: SimulatedUnits, control: SimulatorControl) =>
  Effect.fnUntraced(
    function* (socket: Socket.Socket) {
      // A gateway out of connection slots: accept, then reset the connection at once.
      if (control.maxConnections !== undefined && control.open >= control.maxConnections) {
        const net = yield* Effect.serviceOption(NodeSocket.NetSocket)
        if (Option.isSome(net)) net.value.destroy()
        // Elsewhere (an in-memory network), close it the portable way: end the socket's writer.
        else {
          const closing = yield* socket.writer
          yield* closing.write(new Socket.CloseEvent())
        }
        return
      }
      const writer = yield* socket.writer
      control.open++
      control.accepted++
      yield* Effect.addFinalizer(() => Effect.sync(() => control.open--))
      const { pull } = yield* socket.reader
      let buffer: Uint8Array = new Uint8Array(0)
      while (true) {
        buffer = appendChunks(buffer, yield* pull)
        let split = takeFrame(buffer)
        while (split._tag === "Frame") {
          buffer = split.rest
          control.requests++
          const decoded = yield* decodeRequest(split.frame)
          const unitId = decoded._tag === "Read" ? decoded.request.unitId : decoded.unitId
          const bank = bankFor(units, unitId)
          if (!control.silent && !control.silentUnits.has(unitId)) {
            yield* writer.write(
              decoded._tag === "Unsupported"
                ? encodeExceptionResponse(
                    decoded.transactionId,
                    decoded.unitId,
                    decoded.functionCode,
                    ExceptionCode.IllegalFunction
                  )
                : bank === undefined
                  ? encodeExceptionResponse(
                      decoded._tag === "Read" ? decoded.request.transactionId : decoded.transactionId,
                      unitId,
                      decoded.request.functionCode,
                      ExceptionCode.GatewayTargetFailedToRespond
                    )
                  : decoded._tag === "Read"
                    ? answerRead(bank, decoded.request)
                    : answerWrite(bank, control, decoded.transactionId, decoded.unitId, decoded.request)
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

/** Serve one bank, or one per unit id, on `server` until the surrounding scope closes. */
export const serveModbus = (
  server: SocketServer.SocketServer["Service"],
  units: SimulatedUnits,
  control: SimulatorControl = makeSimulatorControl()
): Effect.Effect<never, SocketServer.SocketServerError> => server.run(serveConnection(units, control))
