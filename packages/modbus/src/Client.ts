/**
 * Modbus TCP client: one connection to one device, one request at a time.
 *
 * Requests are serialized because many devices and serial gateways handle a
 * single outstanding transaction only (Messaging on TCP/IP Implementation
 * Guide §4.2.1). The connection is opened on first use and dropped after a
 * timeout, a socket error or an unreadable frame, so the next request starts
 * on a clean stream. Backoff between failing requests comes from the caller
 * (the pipeline's retry policy and poll interval).
 *
 * A reader fiber per connection consumes everything the device sends, so:
 * - a response is paired with its request by the MBAP transaction id
 *   (Implementation Guide §3.1.3); stale and unsolicited frames are dropped,
 *   and stray bytes left over are discarded before the next request goes out;
 * - a connection the peer closed while idle is noticed when it happens, and
 *   the next request dials again instead of writing into a dead socket;
 * - a request on a reused connection that the peer closed before any byte of
 *   the response arrived is sent once more on a new connection. Devices that
 *   close the connection after every response depend on this.
 */
import { describeSocketError, driverConnects, driverRequests } from "@plenum/core"
import { Deferred, Duration, Effect, Exit, Metric, Schema, Scope, Semaphore } from "effect"
import type * as Socket from "effect/socket/Socket"
import {
  appendChunks,
  decodeBitResponse,
  decodeReadResponse,
  decodeWriteResponse,
  encodeReadRequest,
  encodeWriteRequest,
  frameTransactionId,
  FunctionCode,
  ModbusFrameError,
  takeFrame
} from "./Frame.ts"
import type { BitReadCode, ModbusException, RegisterReadCode, WriteRequest } from "./Frame.ts"

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
  /**
   * Write a coil (FC 05) or holding registers (FC 06, FC 16). Sent at most
   * once: never repeated on a fresh connection, since a device that took it
   * and then dropped the connection would apply it twice.
   */
  readonly write: (request: WriteRequest) => Effect.Effect<void, ModbusClientError>
}

/** A request waiting for its response. */
interface Pending {
  readonly transactionId: number
  readonly response: Deferred.Deferred<Uint8Array, ModbusConnectionError | ModbusFrameError>
  /** Bytes received since the request was written. */
  received: number
}

interface Connection {
  readonly scope: Scope.Closeable
  readonly writer: Socket.Writer
  /** Bytes received but not yet a complete frame. */
  buffer: Uint8Array
  pending: Pending | undefined
  /** Set once the reader stopped: the peer closed the connection or it broke. */
  closed: ModbusConnectionError | undefined
  /** Responses received on this connection. */
  answered: number
}

const countRequest = (outcome: "ok" | "timeout" | "exception" | "invalid_response" | "connection") =>
  Metric.update(Metric.withAttributes(driverRequests, { outcome }), 1)

const countConnect = (outcome: "ok" | "failed") => Metric.update(Metric.withAttributes(driverConnects, { outcome }), 1)

const emptyBuffer = new Uint8Array(0)

/** Mark `conn` dead and fail the request waiting on it, if any. */
const markClosed = (conn: Connection, error: ModbusConnectionError) =>
  Effect.suspend(() => {
    conn.closed ??= error
    const pending = conn.pending
    conn.pending = undefined
    return pending === undefined ? Effect.void : Deferred.fail(pending.response, error)
  })

/** Hand every complete frame in the buffer to the waiting request, dropping the ones it did not ask for. */
const takeFrames = (conn: Connection) =>
  Effect.gen(function* () {
    while (true) {
      const split = takeFrame(conn.buffer)
      switch (split._tag) {
        case "Incomplete":
          return
        case "Invalid": {
          // The stream is out of step. With no request waiting the bytes are
          // junk to drop; otherwise the request fails and the caller reconnects.
          conn.buffer = emptyBuffer
          const pending = conn.pending
          conn.pending = undefined
          if (pending !== undefined)
            yield* Deferred.fail(pending.response, new ModbusFrameError({ message: split.message }))
          return
        }
        case "Frame": {
          conn.buffer = split.rest
          const pending = conn.pending
          if (pending !== undefined && frameTransactionId(split.frame) === pending.transactionId) {
            conn.pending = undefined
            yield* Deferred.succeed(pending.response, split.frame)
          }
        }
      }
    }
  })

/** Read until the connection ends, then mark it closed. Runs in the connection's scope. */
const readLoop = (conn: Connection, reader: Socket.Reader) =>
  Effect.gen(function* () {
    while (true) {
      const chunks = yield* reader.pull
      const before = conn.buffer.length
      conn.buffer = appendChunks(conn.buffer, chunks)
      if (conn.pending !== undefined) conn.pending.received += conn.buffer.length - before
      yield* takeFrames(conn)
    }
  }).pipe(
    Effect.catchTag("SocketError", (error) =>
      markClosed(conn, new ModbusConnectionError({ message: describeSocketError(error) }))
    )
  )

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
    if (current === undefined) return Effect.void
    return markClosed(current, new ModbusConnectionError({ message: "connection closed by the client" })).pipe(
      Effect.andThen(Scope.close(current.scope, Exit.void))
    )
  })
  yield* Effect.addFinalizer(() => disconnect)
  // Each connection's scope is a child of the client's, so a socket opened by an
  // interrupted connect is still closed when the client goes away.
  const clientScope = yield* Effect.scope

  const connect = Effect.gen(function* () {
    if (connection !== undefined && connection.closed === undefined) return connection
    // A connection the peer closed while idle is replaced before anything is written to it.
    yield* disconnect
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
    const conn: Connection = { scope, writer, buffer: emptyBuffer, pending: undefined, closed: undefined, answered: 0 }
    yield* Effect.forkIn(readLoop(conn, reader), scope)
    connection = conn
    return conn
  })

  /** Write one request and wait for the response frame the reader pairs with it. */
  const exchange = Effect.fnUntraced(function* (conn: Connection, pending: Pending, request: Uint8Array) {
    // Closed since `connect` handed it out: nothing would ever fail the wait.
    if (conn.closed !== undefined) return yield* conn.closed
    // Leftovers (padding after the last response, half a frame) would shift
    // the framing of this request's response.
    conn.buffer = emptyBuffer
    conn.pending = pending
    // The write runs beside the wait: on a socket the peer has just closed it
    // may never settle, and the reader's close event fails the request instead.
    yield* conn.writer.write(request).pipe(
      Effect.catchTag("SocketError", (error) =>
        Deferred.fail(pending.response, new ModbusConnectionError({ message: describeSocketError(error) }))
      ),
      Effect.forkIn(conn.scope)
    )
    return yield* Deferred.await(pending.response)
  })

  /**
   * Send a request and return its response frame. A reused connection the
   * peer closed before any byte of the response arrived is replaced and the
   * request sent once more (`resend`): the device never saw it, or dropped it
   * unanswered. That is safe for reads only: writes pass `resend: false`.
   */
  const send: (
    quantity: number,
    encode: (transactionId: number) => Uint8Array,
    resend: boolean
  ) => Effect.Effect<Uint8Array, ModbusTimeout | ModbusConnectionError | ModbusFrameError> = Effect.fnUntraced(
    function* (quantity, encode, resend) {
      // Dialing has its own timeout (the socket's openTimeout); the request timeout starts once connected.
      const conn = yield* connect
      transactionId = (transactionId + 1) & 0xffff
      const pending: Pending = {
        transactionId,
        response: yield* Deferred.make<Uint8Array, ModbusConnectionError | ModbusFrameError>(),
        received: 0
      }
      const frame = yield* exchange(conn, pending, encode(pending.transactionId)).pipe(
        Effect.timeoutOrElse({
          duration: requestTimeout,
          orElse: () =>
            Effect.fail(
              new ModbusTimeout({
                message: `no response to ${quantity} item(s) within ${Duration.format(Duration.fromInputUnsafe(requestTimeout))}`
              })
            )
        }),
        Effect.catchTag("ModbusConnectionError", (error) =>
          resend && conn.answered > 0 && pending.received === 0
            ? Effect.andThen(disconnect, send(quantity, encode, false))
            : Effect.fail(error)
        )
      )
      conn.answered++
      return frame
    }
  )

  /** Drop the connection after a failure that leaves the stream in an unknown state. */
  const reset = (outcome: "timeout" | "connection" | "invalid_response") =>
    Effect.all([disconnect, countRequest(outcome)], { discard: true })

  const request = <A>(
    quantity: number,
    encode: (transactionId: number) => Uint8Array,
    decode: (frame: Uint8Array) => Effect.Effect<A, ModbusFrameError | ModbusException>,
    resend = true
  ): Effect.Effect<A, ModbusClientError> =>
    send(quantity, encode, resend).pipe(
      Effect.flatMap(decode),
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
        (frame) =>
          Effect.map(
            decodeReadResponse(frame, { unitId: options.unitId, functionCode, quantity }),
            (response) => response.registers
          )
      ),
    readBits: (functionCode, address, quantity) =>
      request(
        quantity,
        (id) => encodeReadRequest({ transactionId: id, unitId: options.unitId, functionCode, address, quantity }),
        (frame) =>
          Effect.map(
            decodeBitResponse(frame, { unitId: options.unitId, functionCode, quantity }),
            (response) => response.bits
          )
      ),
    write: (writeRequest) =>
      request(
        writeRequest.functionCode === FunctionCode.WriteMultipleRegisters ? writeRequest.values.length : 1,
        (id) => encodeWriteRequest(id, options.unitId, writeRequest),
        (frame) => decodeWriteResponse(frame, options.unitId, writeRequest),
        false
      )
  }
  return client
})
