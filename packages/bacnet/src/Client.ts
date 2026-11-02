/**
 * BACnet/IP client: one UDP socket shared by every BACnet device the gateway
 * reads, because devices answer on the port the request came from and
 * broadcast I-Am to the BACnet port (47808), which only one socket can own.
 *
 * - Confirmed requests (clause 5.4.4) get an invoke ID, are resent with the
 *   same ID after each timeout up to the retry limit, and are matched to
 *   their answer by invoke ID and the address they were sent to. A reply
 *   from anywhere else is ignored.
 * - Who-Is goes to the broadcast address (or a device's own address), and
 *   every I-Am that arrives meanwhile is collected (clause 16.10).
 * - The client asks for unsegmented answers. A device whose answer does not
 *   fit aborts it, and the caller reads less at a time.
 *
 * If the socket fails while running, it is reopened every 5 s; requests in
 * the meantime time out.
 */
import { describeDatagramSocketError, driverRequests } from "@plenum/core"
import { Deferred, Duration, Effect, Exit, Metric, Result, Schema, Scope, Semaphore } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import type * as DatagramSocket from "effect/socket/DatagramSocket"
import { AbortReason, type Apdu, ConfirmedService, MAX_APDU_IP, RejectReason, UnconfirmedService } from "./Apdu.ts"
import { BacnetCodecError, type BacnetValue } from "./Encoding.ts"
import { ErrorClass, ErrorCode, nameOf } from "./Enums.ts"
import { decodeFrame, encodeFrame } from "./Frame.ts"
import type { NetworkAddress } from "./Npdu.ts"
import {
  decodeErrorBody,
  decodeIAm,
  decodeReadPropertyAck,
  decodeReadPropertyMultipleAck,
  encodeReadProperty,
  encodeReadPropertyMultiple,
  encodeWhoIs,
  type IAm,
  type ReadAccessResult,
  type ReadAccessSpecification,
  type ReadPropertyRequest,
  type WhoIs,
  whoIsMatches
} from "./Services.ts"

/** No answer arrived, including after the retries. */
export class BacnetTimeout extends Schema.TaggedError<BacnetTimeout>()("BacnetTimeout", {
  message: Schema.String
}) {}

/** The device answered with an Error, Reject or Abort PDU instead of a result. */
export class BacnetDeviceError extends Schema.TaggedError<BacnetDeviceError>()("BacnetDeviceError", {
  kind: Schema.Literals(["error", "reject", "abort"]),
  /** For `error`: the error class (clause 18). */
  errorClass: Schema.optionalKey(Schema.Int),
  /** For `error`: the error code; for `reject` and `abort`: the reason. */
  code: Schema.Int,
  message: Schema.String
}) {}

/** The UDP socket could not be opened or written. */
export class BacnetSocketError extends Schema.TaggedError<BacnetSocketError>()("BacnetSocketError", {
  message: Schema.String
}) {}

export type BacnetRequestError = BacnetTimeout | BacnetDeviceError | BacnetCodecError | BacnetSocketError

/** Where a device is reached. */
export interface DeviceAddress {
  /** Its IP address and port, or the router's for a device on another BACnet network. */
  readonly address: NetAddress.InetAddress
  /** Set for a device behind a BACnet router: its network number and address there. */
  readonly network?: NetworkAddress
}

/** A device that answered Who-Is. */
export interface DiscoveredDevice extends DeviceAddress, Omit<IAm, "device"> {
  readonly instance: number
}

export interface BacnetClientOptions {
  /** Where Who-Is goes when no device address is given, e.g. the subnet broadcast on port 47808. */
  readonly broadcastAddress: NetAddress.InetAddress
  /** How long to wait for each attempt (the device's APDU_Timeout, clause 12.11.27). Default 3 s. */
  readonly requestTimeout?: Duration.Input
  /** How often to resend after a timeout (Number_Of_APDU_Retries, clause 12.11.28). Default 2. */
  readonly retries?: number
}

export interface DiscoverOptions {
  /** Only devices in this instance range. */
  readonly range?: NonNullable<WhoIs["range"]>
  /** Ask one address instead of broadcasting. */
  readonly target?: DeviceAddress
  /** How long to collect I-Am answers (default: the request timeout). */
  readonly within?: Duration.Input
}

export interface BacnetClient {
  /** Send a confirmed request and return the body of its ComplexAck (empty for a SimpleAck). */
  readonly confirmed: (
    target: DeviceAddress,
    service: number,
    body: Uint8Array
  ) => Effect.Effect<Uint8Array, BacnetRequestError>
  readonly readProperty: (
    target: DeviceAddress,
    request: ReadPropertyRequest
  ) => Effect.Effect<ReadonlyArray<BacnetValue>, BacnetRequestError>
  readonly readPropertyMultiple: (
    target: DeviceAddress,
    specifications: ReadonlyArray<ReadAccessSpecification>
  ) => Effect.Effect<ReadonlyArray<ReadAccessResult>, BacnetRequestError>
  /** Broadcast Who-Is and collect the devices that answer, one entry per instance. */
  readonly discover: (options?: DiscoverOptions) => Effect.Effect<ReadonlyArray<DiscoveredDevice>, BacnetSocketError>
  /** Find one device by instance: Who-Is for exactly that instance, resent like a request. */
  readonly locate: (
    instance: number,
    options?: Omit<DiscoverOptions, "range" | "within">
  ) => Effect.Effect<DiscoveredDevice, BacnetTimeout | BacnetSocketError>
}

const keyOf = (address: NetAddress.InetAddress) => NetAddress.formatInet(address)

const countRequest = (outcome: "ok" | "timeout" | "exception" | "invalid_response" | "connection") =>
  Metric.update(Metric.withAttributes(driverRequests, { outcome }), 1)

const socketError = (error: DatagramSocket.DatagramSocketError) =>
  new BacnetSocketError({ message: describeDatagramSocketError(error) })

/** What an answer to confirmed request `service` means: its result, or why there is none. */
export const interpretAnswer = (
  service: number,
  answer: Apdu
): Result.Result<Uint8Array, BacnetDeviceError | BacnetCodecError> => {
  switch (answer._tag) {
    case "SimpleAck":
      return Result.succeed(new Uint8Array(0))
    case "ComplexAck":
      if (answer.service !== service) {
        return Result.fail(new BacnetCodecError({ message: `answer is for service ${answer.service}, not ${service}` }))
      }
      // Asked for unsegmented answers; a segment alone is not the whole result.
      return answer.segment === undefined
        ? Result.succeed(answer.body)
        : Result.fail(new BacnetCodecError({ message: "device sent a segmented answer, which was not requested" }))
    case "Error": {
      const body = decodeErrorBody(answer.body)
      if (Result.isFailure(body)) return Result.fail(body.failure)
      const { errorClass, errorCode } = body.success
      return Result.fail(
        new BacnetDeviceError({
          kind: "error",
          errorClass,
          code: errorCode,
          message: `${nameOf(ErrorClass, errorClass)}: ${nameOf(ErrorCode, errorCode)}`
        })
      )
    }
    case "Reject":
      return Result.fail(
        new BacnetDeviceError({
          kind: "reject",
          code: answer.reason,
          message: `rejected: ${nameOf(RejectReason, answer.reason)}`
        })
      )
    case "Abort":
      return Result.fail(
        new BacnetDeviceError({
          kind: "abort",
          code: answer.reason,
          message: `aborted: ${nameOf(AbortReason, answer.reason)}`
        })
      )
    case "ConfirmedRequest":
    case "UnconfirmedRequest":
    case "SegmentAck":
      return Result.fail(new BacnetCodecError({ message: `unexpected ${answer._tag} as an answer` }))
  }
}

const reopenAfter = (error: DatagramSocket.DatagramSocketError) =>
  Effect.logWarning("BACnet socket failed, reopening it in 5 s").pipe(
    Effect.annotateLogs({ error: describeDatagramSocketError(error) }),
    Effect.andThen(Effect.sleep("5 seconds"))
  )

interface Pending {
  /** The address the request went to; only an answer from there counts. */
  readonly peer: string
  readonly answer: Deferred.Deferred<Apdu>
}

/**
 * Build a client on `socket`, which must be bound to the BACnet port (47808)
 * with broadcast enabled to receive broadcast I-Am answers. The socket is
 * opened now, so a port that is in use fails here, and closed with the
 * surrounding scope.
 */
export const makeBacnetClient = Effect.fn("makeBacnetClient")(function* (
  socket: DatagramSocket.DatagramSocket,
  options: BacnetClientOptions
) {
  const requestTimeout = options.requestTimeout ?? "3 seconds"
  const retries = options.retries ?? 2
  const timeoutText = Duration.format(Duration.fromInputUnsafe(requestTimeout))
  const pending = new Map<number, Pending>()
  const iAmListeners = new Set<(device: DiscoveredDevice) => void>()
  // Invoke IDs are one byte (clause 20.1.2.3): at most 256 requests in flight.
  const invokeIds = yield* Semaphore.make(256)
  let nextInvokeId = 0

  const clientScope = yield* Effect.scope
  const writer = yield* socket.writer

  const onDatagram = (datagram: DatagramSocket.Datagram): Effect.Effect<void> => {
    const decoded = decodeFrame(datagram.payload)
    if (Result.isFailure(decoded)) {
      return Effect.logDebug("ignored an unreadable BACnet datagram").pipe(
        Effect.annotateLogs({ from: keyOf(datagram.address), error: decoded.failure.message })
      )
    }
    const frame = decoded.success
    if (frame === undefined) return Effect.void
    const from = frame.forwardedFrom ?? datagram.address
    const apdu = frame.apdu
    switch (apdu._tag) {
      case "UnconfirmedRequest": {
        if (apdu.service !== UnconfirmedService.IAm) return Effect.void
        const iAm = decodeIAm(apdu.body)
        if (Result.isFailure(iAm)) return Effect.void
        const { device, ...rest } = iAm.success
        const found: DiscoveredDevice = {
          ...rest,
          instance: device.instance,
          address: from,
          ...(frame.source === undefined ? {} : { network: frame.source })
        }
        for (const listener of iAmListeners) listener(found)
        return Effect.void
      }
      case "ConfirmedRequest":
      case "SegmentAck":
        // The gateway serves no objects of its own, and never sends segments.
        return Effect.void
      case "SimpleAck":
      case "ComplexAck":
      case "Error":
      case "Reject":
      case "Abort": {
        const waiting = pending.get(apdu.invokeId)
        if (waiting === undefined || waiting.peer !== keyOf(from)) return Effect.void
        return Deferred.succeed(waiting.answer, apdu)
      }
    }
  }

  const receive = (reader: DatagramSocket.Reader) =>
    Effect.forever(Effect.flatMap(reader.pull, (datagrams) => Effect.forEach(datagrams, onDatagram, { discard: true })))
  // Open the first reader here so that a port in use fails the client. It
  // gets its own scope, because a failed reader holds the socket until closed.
  const firstScope = yield* Scope.fork(clientScope)
  const firstReader = yield* socket.reader.pipe(Scope.provide(firstScope), Effect.mapError(socketError))
  yield* receive(firstReader).pipe(
    Effect.ensuring(Scope.close(firstScope, Exit.void)),
    Effect.catch(reopenAfter),
    Effect.andThen(
      Effect.forever(Effect.scoped(Effect.flatMap(socket.reader, receive)).pipe(Effect.catch(reopenAfter)))
    ),
    Effect.forkIn(clientScope)
  )

  const allocateInvokeId = (): number => {
    for (let offset = 0; offset < 256; offset++) {
      const id = (nextInvokeId + offset) & 0xff
      if (!pending.has(id)) {
        nextInvokeId = (id + 1) & 0xff
        return id
      }
    }
    // Unreachable: the semaphore keeps at most 256 requests in flight.
    return nextInvokeId
  }

  /** Send one confirmed request, resending it after each timeout, and return the answer. */
  const exchange = (target: DeviceAddress, service: number, body: Uint8Array) =>
    Effect.suspend(() => {
      const invokeId = allocateInvokeId()
      const answer = Deferred.makeUnsafe<Apdu>()
      pending.set(invokeId, { peer: keyOf(target.address), answer })
      const payload = encodeFrame(
        {
          _tag: "ConfirmedRequest",
          invokeId,
          service,
          maxApdu: MAX_APDU_IP,
          segmentedResponseAccepted: false,
          body
        },
        target.network === undefined ? {} : { destination: target.network }
      )
      const attempt = writer.write({ payload, address: target.address }).pipe(
        Effect.mapError(socketError),
        Effect.andThen(Deferred.await(answer)),
        Effect.timeoutOrElse({
          duration: requestTimeout,
          orElse: () =>
            countRequest("timeout").pipe(
              Effect.andThen(
                Effect.fail(
                  new BacnetTimeout({ message: `no answer from ${keyOf(target.address)} within ${timeoutText}` })
                )
              )
            )
        })
      )
      // Resent with the same invoke ID, so a late answer to an earlier attempt still counts (clause 5.4.4.1).
      return attempt.pipe(
        Effect.retry({ times: retries, while: (error) => error._tag === "BacnetTimeout" }),
        Effect.ensuring(Effect.sync(() => pending.delete(invokeId)))
      )
    }).pipe(Semaphore.withPermit(invokeIds))

  const request = <A>(
    target: DeviceAddress,
    service: number,
    body: Uint8Array,
    decode: (body: Uint8Array) => Result.Result<A, BacnetCodecError>
  ): Effect.Effect<A, BacnetRequestError> =>
    exchange(target, service, body).pipe(
      Effect.flatMap((answer) => Effect.fromResult(Result.flatMap(interpretAnswer(service, answer), decode))),
      Effect.tap(() => countRequest("ok")),
      Effect.tapError((error) => {
        switch (error._tag) {
          case "BacnetDeviceError":
            return countRequest("exception")
          case "BacnetCodecError":
            return countRequest("invalid_response")
          case "BacnetSocketError":
            return countRequest("connection")
          case "BacnetTimeout":
            // Counted per attempt in `exchange`.
            return Effect.void
        }
      })
    )

  const sendWhoIs = (whoIs: WhoIs, target: DeviceAddress | undefined) =>
    writer
      .write({
        payload: encodeFrame(
          { _tag: "UnconfirmedRequest", service: UnconfirmedService.WhoIs, body: encodeWhoIs(whoIs) },
          target === undefined
            ? { broadcast: true }
            : target.network === undefined
              ? {}
              : { destination: target.network }
        ),
        address: target?.address ?? options.broadcastAddress
      })
      .pipe(Effect.mapError(socketError))

  /** Run `use` while `listener` sees every I-Am that arrives. */
  const listening = <A, E>(listener: (device: DiscoveredDevice) => void, use: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => iAmListeners.add(listener)),
      () => use,
      () => Effect.sync(() => iAmListeners.delete(listener))
    )

  const client: BacnetClient = {
    confirmed: (target, service, body) => request(target, service, body, Result.succeed),
    readProperty: (target, readRequest) =>
      request(target, ConfirmedService.ReadProperty, encodeReadProperty(readRequest), (body) =>
        Result.map(decodeReadPropertyAck(body), (ack) => ack.values)
      ),
    readPropertyMultiple: (target, specifications) =>
      request(
        target,
        ConfirmedService.ReadPropertyMultiple,
        encodeReadPropertyMultiple(specifications),
        decodeReadPropertyMultipleAck
      ),
    discover: (discoverOptions = {}) =>
      Effect.suspend(() => {
        const found = new Map<number, DiscoveredDevice>()
        const whoIs: WhoIs = discoverOptions.range === undefined ? {} : { range: discoverOptions.range }
        return listening(
          (device) => {
            if (whoIsMatches(whoIs, device.instance)) found.set(device.instance, device)
          },
          sendWhoIs(whoIs, discoverOptions.target).pipe(
            Effect.andThen(Effect.sleep(discoverOptions.within ?? requestTimeout))
          )
        ).pipe(Effect.map(() => [...found.values()]))
      }),
    locate: (instance, locateOptions = {}) =>
      Effect.suspend(() => {
        const found = Deferred.makeUnsafe<DiscoveredDevice>()
        const attempt = sendWhoIs({ range: { low: instance, high: instance } }, locateOptions.target).pipe(
          Effect.andThen(Deferred.await(found)),
          Effect.timeoutOrElse({
            duration: requestTimeout,
            orElse: () =>
              Effect.fail(
                new BacnetTimeout({ message: `device ${instance} did not answer Who-Is within ${timeoutText}` })
              )
          })
        )
        return listening(
          (device) => {
            if (device.instance === instance) Deferred.doneUnsafe(found, Effect.succeed(device))
          },
          attempt.pipe(Effect.retry({ times: retries, while: (error) => error._tag === "BacnetTimeout" }))
        )
      })
  }
  return client
})
