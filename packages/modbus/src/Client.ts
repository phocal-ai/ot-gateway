/**
 * Modbus TCP client: one connection to one device, one request at a time.
 *
 * Requests are serialized because many devices and serial gateways handle a
 * single outstanding transaction only (Messaging on TCP/IP Implementation
 * Guide §4.2.1). The connection is opened on first use and dropped after a
 * timeout, a socket error or an unreadable frame, so the next request starts
 * on a clean stream; a stale response that still arrives is skipped by its
 * transaction id. Backoff between failing requests comes from the caller
 * (the pipeline's retry policy and poll interval).
 */
import { describeSocketError, driverConnects, driverRequests } from "@plenum/core"
import { Duration, Effect, Exit, Metric, Schema, Scope, Semaphore } from "effect"
import type * as Socket from "effect/socket/Socket"
import {
  appendChunks,
  decodeBitResponse,
  decodeReadResponse,
  encodeReadRequest,
  ModbusFrameError,
  takeFrame
} from "./Frame.ts"
import type { BitReadCode, ModbusException, RegisterReadCode } from "./Frame.ts"

/** No complete response arrived within the request timeout. */
export class ModbusTimeout extends Schema.TaggedError<ModbusTimeout>()("ModbusTimeout", {
  message: Schema.String
}) {}

/** The TCP connection could not be opened, or broke during a request. */
export class ModbusConnectionError extends Schema.TaggedError<ModbusConnectionError>()("ModbusConnectionError", {
  message: Schema.String
}) {}

export type ModbusClientError = ModbusTimeout | ModbusConnectionError | ModbusException | ModbusFrameError

export interface ModbusClientOptions {
  readonly unitId: number
  /** Time allowed for one request, from sending it to a complete response (default 2 s). */
  readonly requestTimeout?: Duration.Input
}

export interface ModbusClient {
  /** Read holding (FC 03) or input (FC 04) registers. */
  readonly readRegisters: (
    functionCode: RegisterReadCode,
    address: number,
    quantity: number
  ) => Effect.Effect<ReadonlyArray<number>, ModbusClientError>
  /** Read coils (FC 01) or discrete inputs (FC 02). */
  readonly readBits: (
    functionCode: BitReadCode,
    address: number,
    quantity: number
  ) => Effect.Effect<ReadonlyArray<boolean>, ModbusClientError>
}

interface Connection {
  readonly scope: Scope.Closeable
  readonly reader: Socket.Reader
  readonly writer: Socket.Writer
  /** Bytes received but not yet consumed as a frame. */
  buffer: Uint8Array
}

const countRequest = (outcome: "ok" | "timeout" | "exception" | "invalid_response" | "connection") =>
  Metric.update(Metric.withAttributes(driverRequests, { outcome }), 1)

const countConnect = (outcome: "ok" | "failed") => Metric.update(Metric.withAttributes(driverConnects, { outcome }), 1)

/**
 * Build a client on `socket`, which describes how to dial the device (for
 * production, `NodeSocket.makeNet`). The open connection is closed with the
 * surrounding scope.
 */
export const makeModbusClient = Effect.fn("makeModbusClient")(function* (
  socket: Socket.Socket,
  options: ModbusClientOptions
) {
  const requestTimeout = options.requestTimeout ?? "2 seconds"
  const lock = yield* Semaphore.make(1)
  let connection: Connection | undefined
  let transactionId = 0

  const disconnect = Effect.suspend(() => {
    const current = connection
    connection = undefined
    return current === undefined ? Effect.void : Scope.close(current.scope, Exit.void)
  })
  yield* Effect.addFinalizer(() => disconnect)
  // Each connection's scope is a child of the client's, so a socket opened by an
  // interrupted connect is still closed when the client goes away.
  const clientScope = yield* Effect.scope

  const connect = Effect.gen(function* () {
    if (connection !== undefined) return connection
    const scope = yield* Scope.fork(clientScope)
    const [reader, writer] = yield* Effect.all([socket.reader, socket.writer]).pipe(
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
      Effect.catchTag("SocketError", (error) =>
        countConnect("failed").pipe(
          Effect.andThen(Effect.fail(new ModbusConnectionError({ message: describeSocketError(error) })))
        )
      )
    )
    yield* countConnect("ok")
    connection = { scope, reader, writer, buffer: new Uint8Array(0) }
    return connection
  })

  /** Send one request and return the response frame carrying the same transaction id. */
  const exchange = Effect.fnUntraced(function* (conn: Connection, request: Uint8Array, expectedId: number) {
    yield* conn.writer.write(request)
    while (true) {
      const split = takeFrame(conn.buffer)
      switch (split._tag) {
        case "Invalid":
          return yield* new ModbusFrameError({ message: split.message })
        case "Incomplete":
          conn.buffer = appendChunks(conn.buffer, yield* conn.reader.pull)
          break
        case "Frame": {
          conn.buffer = split.rest
          const frameId = ((split.frame[0] ?? 0) << 8) | (split.frame[1] ?? 0)
          if (frameId === expectedId) return split.frame
        }
      }
    }
  })

  /** Drop the connection after a failure that leaves the stream in an unknown state. */
  const reset = (outcome: "timeout" | "connection" | "invalid_response") =>
    Effect.all([disconnect, countRequest(outcome)], { discard: true })

  const request = <A>(
    quantity: number,
    encode: (transactionId: number) => Uint8Array,
    decode: (frame: Uint8Array) => Effect.Effect<A, ModbusFrameError | ModbusException>
  ): Effect.Effect<A, ModbusClientError> =>
    Effect.gen(function* () {
      // Dialing has its own timeout (the socket's openTimeout); the request timeout starts once connected.
      const conn = yield* connect
      transactionId = (transactionId + 1) & 0xffff
      const id = transactionId
      const frame = yield* exchange(conn, encode(id), id).pipe(
        Effect.catchTag("SocketError", (error) =>
          Effect.fail(new ModbusConnectionError({ message: describeSocketError(error) }))
        ),
        Effect.timeoutOrElse({
          duration: requestTimeout,
          orElse: () =>
            Effect.fail(
              new ModbusTimeout({
                message: `no response to ${quantity} item(s) within ${Duration.format(Duration.fromInputUnsafe(requestTimeout))}`
              })
            )
        })
      )
      return yield* decode(frame)
    }).pipe(
      Effect.tap(() => countRequest("ok")),
      Effect.catchTags({
        ModbusException: (error) => countRequest("exception").pipe(Effect.andThen(Effect.fail(error))),
        ModbusTimeout: (error) => reset("timeout").pipe(Effect.andThen(Effect.fail(error))),
        ModbusConnectionError: (error) => reset("connection").pipe(Effect.andThen(Effect.fail(error))),
        ModbusFrameError: (error) => reset("invalid_response").pipe(Effect.andThen(Effect.fail(error)))
      }),
      Semaphore.withPermit(lock)
    )

  const client: ModbusClient = {
    readRegisters: (functionCode, address, quantity) =>
      request(
        quantity,
        (id) => encodeReadRequest({ transactionId: id, unitId: options.unitId, functionCode, address, quantity }),
        (frame) => Effect.map(decodeReadResponse(frame, { functionCode, quantity }), (response) => response.registers)
      ),
    readBits: (functionCode, address, quantity) =>
      request(
        quantity,
        (id) => encodeReadRequest({ transactionId: id, unitId: options.unitId, functionCode, address, quantity }),
        (frame) => Effect.map(decodeBitResponse(frame, { functionCode, quantity }), (response) => response.bits)
      )
  }
  return client
})
