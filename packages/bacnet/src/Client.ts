/**
 * BACnet/IP client: one UDP socket shared by every BACnet device the gateway
 * reads, because devices answer on the port the request came from and
 * broadcast I-Am to the BACnet port (47808), which only one socket can own.
 *
 * - Confirmed requests (clause 5.4.4) get an invoke ID, are resent with the
 *   same ID after each timeout up to the retry limit, and are matched to
 *   their answer by invoke ID, the address they were sent to and, for a
 *   device behind a router, its network address. A reply from anywhere else
 *   is ignored, and so is an answer about another object or property. The
 *   invoke ID of a request given up on rests for a while before reuse.
 * - Who-Is goes to every network through the broadcast address (or to one
 *   device's address), and every I-Am that arrives meanwhile is collected
 *   (clause 16.10).
 * - The client asks for unsegmented answers. A device whose answer does not
 *   fit aborts it, and the caller reads less at a time.
 * - COV subscriptions (clause 13.14) are made with `subscribeCov`. The
 *   UnconfirmedCOVNotifications that follow go to whoever registered for
 *   their process identifier. The client asks for unconfirmed notifications
 *   only, so it never acknowledges any.
 *
 * - A BBMD's Forwarded-NPDU (Annex J.2.5) names the original sender, which
 *   anyone on the LAN can forge. It is believed only when it comes from the
 *   configured BBMD or from the address it names; otherwise it is dropped.
 * - At most 256 requests are in flight (one-byte invoke IDs), and at most 64
 *   of them COV subscriptions, so subscriptions cannot starve the polls. A
 *   request that finds no free invoke ID within its whole timeout (every
 *   attempt) fails as a timeout instead of waiting without bound.
 *
 * If the socket fails while running, it is reopened every 5 s; requests in
 * the meantime time out. A datagram that cannot be handled is logged and
 * dropped, and never stops the receive loop.
 */
import {
  describeDatagramSocketError,
  driverConnects,
  driverRequests,
  monotonicMillis,
  timeRequest
} from "@ot-gateway/core"
import { Deferred, Duration, Effect, Exit, Metric, Random, Result, Schema, Scope, Semaphore } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import type * as DatagramSocket from "effect/socket/DatagramSocket"
import { AbortReason, type Apdu, ConfirmedService, MAX_APDU_IP, RejectReason, UnconfirmedService } from "./Apdu.ts"
import { BacnetCodecError, type BacnetEncodeError, type BacnetValue, type ObjectId, tryEncode } from "./Encoding.ts"
import { ErrorClass, ErrorCode, nameOf, ObjectType, PropertyId } from "./Enums.ts"
import { decodeFrame, encodeFrame } from "./Frame.ts"
import type { NetworkAddress } from "./Npdu.ts"
import {
  type CovNotification,
  decodeCovNotification,
  decodeErrorBody,
  decodeIAm,
  decodeReadPropertyAck,
  decodeReadPropertyMultipleAck,
  encodeReadProperty,
  encodeReadPropertyMultiple,
  encodeSubscribeCov,
  encodeWriteProperty,
  encodeWhoIs,
  type IAm,
  type PropertyReference,
  type ReadAccessResult,
  type ReadAccessSpecification,
  type ReadPropertyAck,
  type ReadPropertyRequest,
  type SubscribeCovRequest,
  type WritePropertyRequest,
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

/** Every way a request can fail; `BacnetEncodeError` when it carries a value out of range and was never sent. */
export type BacnetRequestError =
  | BacnetTimeout
  | BacnetDeviceError
  | BacnetCodecError
  | BacnetSocketError
  | BacnetEncodeError

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

/** Most other sources `discover` keeps for one instance. */
export const MAX_CONFLICTS = 16

/** Most instances one `discover` keeps; answers for further instances are dropped. */
export const MAX_DEVICES = 4_096

/** What `discover` found for one instance: the first answer, and every other source that answered for it. */
export interface FoundDevice extends DiscoveredDevice {
  /**
   * The other addresses (with their networks) that answered for the same
   * instance, in the order they answered, at most `MAX_CONFLICTS`; empty
   * when only one did. When there are any, the instance alone does not say
   * which host is the device.
   */
  readonly conflicts: ReadonlyArray<DeviceAddress>
}

export interface BacnetClientOptions {
  /** Where Who-Is goes when no device address is given, e.g. the subnet broadcast on port 47808. */
  readonly broadcastAddress: NetAddress.InetAddress
  /** How long to wait for each attempt (the device's APDU_Timeout, clause 12.11.27). Default 3 s. */
  readonly requestTimeout?: Duration.Input
  /** How often to resend after a timeout (Number_Of_APDU_Retries, clause 12.11.28). Default 2. */
  readonly retries?: number
  /**
   * The BBMD on this subnet (Annex J.4), whose Forwarded-NPDUs are believed.
   * Without it, a Forwarded-NPDU counts only when it comes from the address
   * it names, i.e. from a device that is its own BBMD.
   */
  readonly bbmdAddress?: NetAddress.InetAddress
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
  /**
   * Broadcast Who-Is (or ask `target` only) and collect the devices that
   * answer, one entry per instance, with every other source that answered
   * for the same instance in its `conflicts`. At most `MAX_DEVICES`
   * instances, the first to answer.
   */
  readonly discover: (options?: DiscoverOptions) => Effect.Effect<ReadonlyArray<FoundDevice>, BacnetSocketError>
  /**
   * Find one device by instance: Who-Is for exactly that instance, resent
   * like a request. With a `target`, only an I-Am from that address counts,
   * so a device elsewhere with the same instance is not taken for it.
   */
  readonly locate: (
    instance: number,
    options?: Omit<DiscoverOptions, "range" | "within">
  ) => Effect.Effect<DiscoveredDevice, BacnetTimeout | BacnetSocketError>
  /** Subscribe to an object's changes, or cancel that with neither `confirmed` nor `lifetime`. */
  readonly subscribeCov: (
    target: DeviceAddress,
    request: SubscribeCovRequest
  ) => Effect.Effect<void, BacnetRequestError>
  /**
   * Write one property (clause 15.9). Resent with the same invoke ID after a
   * timeout like every confirmed request, which is safe: writing the same
   * value at the same priority again leaves the same state.
   */
  readonly writeProperty: (
    target: DeviceAddress,
    request: WritePropertyRequest
  ) => Effect.Effect<void, BacnetRequestError>
  /** A random subscriber process identifier that no other caller of this client gets. */
  readonly newProcessId: Effect.Effect<number>
  /** Hand every COV notification for `processId` to `listener`, until the scope closes. */
  readonly onCovNotification: (
    processId: number,
    listener: (notification: CovNotification, from: DeviceAddress) => void
  ) => Effect.Effect<void, never, Scope.Scope>
}

const keyOf = (address: NetAddress.InetAddress) => NetAddress.formatInet(address)

/** Of the 256 invoke IDs, how many COV subscriptions may hold at once, across every device. */
const COV_REQUESTS = 64

const countRequest = (outcome: "ok" | "timeout" | "exception" | "invalid_response" | "connection") =>
  Metric.update(Metric.withAttributes(driverRequests, { outcome }), 1)

/** Opening the shared socket, counted like a driver connection under the device name `$bacnet`. */
const countConnect = (outcome: "ok" | "failed") =>
  Metric.update(Metric.withAttributes(driverConnects, { device: "$bacnet", outcome }), 1)

const socketError = (error: DatagramSocket.DatagramSocketError) =>
  new BacnetSocketError({ message: describeDatagramSocketError(error) })

/** Every BACnet network: routers pass a global broadcast on to all of theirs (clause 6.2.2). */
const GLOBAL_BROADCAST: NetworkAddress = { network: 0xffff, address: new Uint8Array(0) }

/** Device instance 4,194,303 in a request stands for whichever device receives it (clause 15.5.1.1.1). */
const WILDCARD_INSTANCE = 4_194_303

/** Property identifiers that a device expands into a list of properties in its answer (clause 15.7.3.1.1). */
const expandingProperties = new Set<number>([PropertyId.all, PropertyId.required, PropertyId.optional])

const routedTo = (target: DeviceAddress) => (target.network === undefined ? {} : { destination: target.network })

const sameNetwork = (left: NetworkAddress | undefined, right: NetworkAddress | undefined): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.network === right.network &&
      left.address.length === right.address.length &&
      left.address.every((byte, index) => byte === right.address[index])

/** Whether `device` answered from `target`: the same IP address and port, and the same network behind a router. */
const sameDevice = (device: DeviceAddress, target: DeviceAddress) =>
  keyOf(device.address) === keyOf(target.address) && sameNetwork(device.network, target.network)

export interface DiscoveryLimits {
  /** Most instances kept (default `MAX_DEVICES`); answers for further instances are dropped. */
  readonly maxDevices?: number
  /** Most other sources kept per instance (default `MAX_CONFLICTS`). */
  readonly maxConflicts?: number
}

/**
 * What `discover` does with each I-Am it accepts: one entry per instance,
 * the first answer, and every other source that answered for the instance
 * in `conflicts`. The same source again (a resent I-Am) is not a conflict.
 */
export const makeDiscoveryCollector = (limits: DiscoveryLimits = {}) => {
  const maxDevices = limits.maxDevices ?? MAX_DEVICES
  const maxConflicts = limits.maxConflicts ?? MAX_CONFLICTS
  const found = new Map<number, { readonly device: DiscoveredDevice; readonly conflicts: Array<DeviceAddress> }>()
  return {
    add: (device: DiscoveredDevice): void => {
      const first = found.get(device.instance)
      if (first === undefined) {
        if (found.size < maxDevices) found.set(device.instance, { device, conflicts: [] })
        return
      }
      const known = sameDevice(device, first.device) || first.conflicts.some((other) => sameDevice(device, other))
      if (known || first.conflicts.length >= maxConflicts) return
      first.conflicts.push({
        address: device.address,
        ...(device.network === undefined ? {} : { network: device.network })
      })
    },
    devices: (): ReadonlyArray<FoundDevice> =>
      Array.from(found.values(), ({ device, conflicts }) => ({ ...device, conflicts }))
  }
}

const sameObject = (asked: ObjectId, answered: ObjectId) =>
  asked.objectType === answered.objectType &&
  (asked.instance === answered.instance ||
    (asked.objectType === ObjectType.device && asked.instance === WILDCARD_INSTANCE))

const sameReference = (asked: PropertyReference, answered: PropertyReference) =>
  asked.property === answered.property && asked.arrayIndex === answered.arrayIndex

const notAsked = (what: string) =>
  Result.fail(new BacnetCodecError({ message: `answer is for ${what} than was asked` }))

/** The values of a ReadProperty answer, if it is about the object and property that were asked for. */
export const checkReadPropertyAck = (
  request: ReadPropertyRequest,
  ack: ReadPropertyAck
): Result.Result<ReadonlyArray<BacnetValue>, BacnetCodecError> =>
  sameObject(request.object, ack.object) && sameReference(request, ack)
    ? Result.succeed(ack.values)
    : notAsked("another object or property")

/**
 * A ReadPropertyMultiple answer, if it lists the objects that were asked for
 * in order, and the same properties for each one that names them one by one.
 */
export const checkReadPropertyMultipleAck = (
  specifications: ReadonlyArray<ReadAccessSpecification>,
  results: ReadonlyArray<ReadAccessResult>
): Result.Result<ReadonlyArray<ReadAccessResult>, BacnetCodecError> => {
  if (results.length !== specifications.length) return notAsked("a different number of objects")
  for (const [index, specification] of specifications.entries()) {
    const result = results[index]
    if (result === undefined || !sameObject(specification.object, result.object)) return notAsked("other objects")
    if (specification.properties.some((reference) => expandingProperties.has(reference.property))) continue
    const sameProperties =
      result.results.length === specification.properties.length &&
      specification.properties.every((reference, position) => {
        const answered = result.results[position]
        return answered !== undefined && sameReference(reference, answered)
      })
    if (!sameProperties) return notAsked("other properties")
  }
  return Result.succeed(results)
}

const wrongService = (answered: number, asked: number) =>
  Result.fail(new BacnetCodecError({ message: `answer is for service ${answered}, not ${asked}` }))

/** What an answer to confirmed request `service` means: its result, or why there is none. */
export const interpretAnswer = (
  service: number,
  answer: Apdu
): Result.Result<Uint8Array, BacnetDeviceError | BacnetCodecError> => {
  switch (answer._tag) {
    case "SimpleAck":
      return answer.service === service ? Result.succeed(new Uint8Array(0)) : wrongService(answer.service, service)
    case "ComplexAck":
      if (answer.service !== service) return wrongService(answer.service, service)
      // Asked for unsegmented answers; a segment alone is not the whole result. The answer did not fit,
      // just as if the device had aborted it, so the caller can ask for less.
      return answer.segment === undefined
        ? Result.succeed(answer.body)
        : Result.fail(
            new BacnetDeviceError({
              kind: "abort",
              code: AbortReason.SegmentationNotSupported,
              message: "device segmented its answer, which was not requested"
            })
          )
    case "Error": {
      if (answer.service !== service) return wrongService(answer.service, service)
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

const reopenAfter = (problem: string) =>
  Effect.logWarning("BACnet socket failed, reopening it in 5 s").pipe(
    Effect.annotateLogs({ error: problem }),
    Effect.andThen(Effect.sleep("5 seconds"))
  )

/** Turn a socket failure, or a defect, into a pause before the socket is reopened. Only interruption stops it. */
const recoverReceiving = <R>(receiving: Effect.Effect<void, DatagramSocket.DatagramSocketError, R>) =>
  receiving.pipe(
    Effect.catch((error) => reopenAfter(describeDatagramSocketError(error))),
    Effect.catchDefect((defect) => reopenAfter(String(defect)))
  )

interface Pending {
  /** The address the request went to; only an answer from there counts. */
  readonly peer: string
  /** For a device behind a router: an answer must come from it, not from the router or another device. */
  readonly network: NetworkAddress | undefined
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
  // An invoke ID whose request was given up on is not reused for a while, so
  // a late answer to it cannot be taken for the answer to a new request.
  const quarantineMillis = Math.max(10_000, 2 * Duration.toMillis(requestTimeout))
  // How long a whole request may take, every attempt included; waiting for an invoke ID counts against it.
  const requestTimeoutMillis = Duration.toMillis(Duration.fromInputUnsafe(requestTimeout))
  const requestDeadline = Duration.millis(requestTimeoutMillis * (retries + 1))
  const bbmd = options.bbmdAddress === undefined ? undefined : keyOf(options.bbmdAddress)
  const pending = new Map<number, Pending>()
  const quarantined = new Map<number, number>()
  const iAmListeners = new Set<(device: DiscoveredDevice) => void>()
  const covListeners = new Map<number, (notification: CovNotification, from: DeviceAddress) => void>()
  const issuedProcessIds = new Set<number>()
  // Senders of refused Forwarded-NPDUs already warned about (bounded, so a spoofing host cannot grow it).
  const untrustedForwarders = new Set<string>()
  // Invoke IDs are one byte (clause 20.1.2.3): at most 256 requests in flight.
  const invokeIds = yield* Semaphore.make(256)
  const covRequests = yield* Semaphore.make(COV_REQUESTS)
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
    if (frame.forwardedFrom !== undefined) {
      // Anyone can claim to forward for anyone (Annex J.2.5 has no authentication): only the BBMD, or the device itself.
      const sender = keyOf(datagram.address)
      if (sender !== bbmd && sender !== keyOf(frame.forwardedFrom)) {
        // Once per sender as a warning: a site with a BBMD but no `bacnet.bbmdAddress` loses its remote devices here.
        const firstTime = !untrustedForwarders.has(sender) && untrustedForwarders.size < 64
        if (firstTime) untrustedForwarders.add(sender)
        const log = firstTime
          ? Effect.logWarning("ignored a Forwarded-NPDU from an address that is not the configured BBMD")
          : Effect.logDebug("ignored a Forwarded-NPDU that did not come from the BBMD")
        return log.pipe(
          Effect.annotateLogs({ from: sender, claimed: keyOf(frame.forwardedFrom), bbmdAddress: bbmd ?? "not set" })
        )
      }
    }
    const from = frame.forwardedFrom ?? datagram.address
    const apdu = frame.apdu
    switch (apdu._tag) {
      case "UnconfirmedRequest": {
        if (apdu.service === UnconfirmedService.UnconfirmedCovNotification) {
          const notification = decodeCovNotification(apdu.body)
          if (Result.isFailure(notification)) {
            return Effect.logDebug("ignored an unreadable COV notification").pipe(
              Effect.annotateLogs({ from: keyOf(from), error: notification.failure.message })
            )
          }
          const listener = covListeners.get(notification.success.processId)
          listener?.(notification.success, {
            address: from,
            ...(frame.source === undefined ? {} : { network: frame.source })
          })
          return Effect.void
        }
        if (apdu.service !== UnconfirmedService.IAm) return Effect.void
        const iAm = decodeIAm(apdu.body)
        if (Result.isFailure(iAm) || iAm.success.device.objectType !== ObjectType.device) {
          return Effect.logDebug("ignored an unreadable I-Am").pipe(
            Effect.annotateLogs({
              from: keyOf(from),
              error: Result.isFailure(iAm) ? iAm.failure.message : "its object is not a device"
            })
          )
        }
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
        // The gateway serves no objects of its own, never sends segments and
        // asks for unconfirmed notifications only, so it answers no requests.
        return Effect.void
      case "SimpleAck":
      case "ComplexAck":
      case "Error":
      case "Reject":
      case "Abort": {
        // An Abort from a client ends a transaction in its own invoke ID space, not one of ours.
        if (apdu._tag === "Abort" && !apdu.fromServer) return Effect.void
        const waiting = pending.get(apdu.invokeId)
        if (waiting === undefined || waiting.peer !== keyOf(from) || !sameNetwork(frame.source, waiting.network)) {
          return Effect.void
        }
        return Deferred.succeed(waiting.answer, apdu)
      }
    }
  }

  // One bad datagram must not stop the receive loop for every device.
  const handle = (datagram: DatagramSocket.Datagram) =>
    Effect.suspend(() => onDatagram(datagram)).pipe(
      Effect.catchDefect((defect) =>
        Effect.logWarning("dropped a BACnet datagram that could not be handled").pipe(
          Effect.annotateLogs({ from: keyOf(datagram.address), defect: String(defect) })
        )
      )
    )
  const receive = (reader: DatagramSocket.Reader) =>
    Effect.forever(Effect.flatMap(reader.pull, (datagrams) => Effect.forEach(datagrams, handle, { discard: true })))
  const openReader = socket.reader.pipe(
    Effect.tap(() => countConnect("ok")),
    Effect.tapError(() => countConnect("failed"))
  )
  // Open the first reader here so that a port in use fails the client. It
  // gets its own scope, because a failed reader holds the socket until closed.
  const firstScope = yield* Scope.fork(clientScope)
  const firstReader = yield* openReader.pipe(Scope.provide(firstScope), Effect.mapError(socketError))
  yield* receive(firstReader).pipe(
    Effect.ensuring(Scope.close(firstScope, Exit.void)),
    recoverReceiving,
    Effect.andThen(Effect.forever(recoverReceiving(Effect.scoped(Effect.flatMap(openReader, receive))))),
    Effect.forkIn(clientScope)
  )

  /** A free invoke ID, preferring one that is not quarantined, else the one whose quarantine ends first. */
  const allocateInvokeId = (now: number): number => {
    let earliest: number | undefined
    let chosen: number | undefined
    for (let offset = 0; offset < 256 && chosen === undefined; offset++) {
      const id = (nextInvokeId + offset) & 0xff
      if (pending.has(id)) continue
      const until = quarantined.get(id)
      if (until === undefined || until <= now) chosen = id
      else if (earliest === undefined || until < (quarantined.get(earliest) ?? until)) earliest = id
    }
    // The semaphore keeps at most 256 requests in flight, so one of the two is set.
    const id = chosen ?? earliest ?? nextInvokeId
    quarantined.delete(id)
    nextInvokeId = (id + 1) & 0xff
    return id
  }

  /** Write one datagram. Writes wait while the socket is being reopened, so this gives up after the request timeout. */
  const send = (payload: Uint8Array, address: NetAddress.InetAddress) =>
    writer.write({ payload, address }).pipe(
      Effect.mapError(socketError),
      Effect.timeoutOrElse({
        duration: requestTimeout,
        orElse: () =>
          Effect.fail(new BacnetSocketError({ message: `could not send within ${timeoutText}, socket not open` }))
      })
    )

  /** A device that sent a segment waits for a SegmentAck; tell it the transaction is over instead (clause 5.4.5). */
  const abortSegmented = (target: DeviceAddress, invokeId: number) =>
    send(
      encodeFrame(
        { _tag: "Abort", invokeId, reason: AbortReason.SegmentationNotSupported, fromServer: false },
        routedTo(target)
      ),
      target.address
    ).pipe(
      Effect.catch((error) =>
        Effect.logDebug("could not abort a segmented answer").pipe(Effect.annotateLogs({ error: error.message }))
      )
    )

  /**
   * Run `use` holding a permit of each of `semaphores`. Waiting for them
   * counts against the request's deadline, so a gateway with too many
   * requests in flight fails requests as timeouts instead of stalling them.
   * `use` is handed the request's deadline (monotonic milliseconds), so its
   * attempts end by it however late the permits came.
   */
  const noFreeInvokeId = () =>
    Effect.fail(
      new BacnetTimeout({
        message: `no free invoke ID within ${Duration.format(requestDeadline)}, too many requests in flight`
      })
    )

  const withPermits = <A, E>(
    semaphores: ReadonlyArray<Semaphore.Semaphore>,
    use: (deadlineAt: number) => Effect.Effect<A, E>
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* monotonicMillis
        const deadlineAt = started + Duration.toMillis(requestDeadline)
        yield* Effect.forEach(semaphores, (semaphore) => Semaphore.takeScoped(semaphore, 1), { discard: true }).pipe(
          Effect.timeoutOrElse({
            duration: requestDeadline,
            orElse: () => noFreeInvokeId()
          })
        )
        // A permit that came only as the deadline passed is no better than none: nothing is sent.
        if ((yield* monotonicMillis) >= deadlineAt) return yield* noFreeInvokeId()
        return yield* use(deadlineAt)
      })
    )

  /**
   * Send one confirmed request, resending it after each timeout, and return
   * the answer. Each attempt waits the request timeout or what is left until
   * `deadlineAt`, whichever is shorter, and none starts after it: one timer
   * per attempt, so the request ends by its deadline with the message of the
   * attempt that ran out.
   */
  const exchange = (target: DeviceAddress, service: number, body: Uint8Array, deadlineAt: number) =>
    Effect.acquireUseRelease(
      // Registered uninterruptibly, so an interrupted request never leaves its invoke ID behind.
      Effect.flatMap(monotonicMillis, (now) =>
        Effect.sync(() => {
          const invokeId = allocateInvokeId(now)
          const answer = Deferred.makeUnsafe<Apdu>()
          pending.set(invokeId, { peer: keyOf(target.address), network: target.network, answer })
          return { invokeId, answer }
        })
      ),
      ({ invokeId, answer }) => {
        const payload = encodeFrame(
          {
            _tag: "ConfirmedRequest",
            invokeId,
            service,
            maxApdu: MAX_APDU_IP,
            segmentedResponseAccepted: false,
            body
          },
          routedTo(target)
        )
        const attempt = Effect.gen(function* () {
          const left = deadlineAt - (yield* monotonicMillis)
          const budget = Math.min(requestTimeoutMillis, left)
          const within =
            budget === requestTimeoutMillis
              ? timeoutText
              : `${Math.max(0, budget)}ms, what was left of its ${Duration.format(requestDeadline)} (waiting for an invoke ID counts)`
          const timedOut = new BacnetTimeout({ message: `no answer from ${keyOf(target.address)} within ${within}` })
          if (budget <= 0) return yield* timedOut
          return yield* writer
            .write({ payload, address: target.address })
            .pipe(
              Effect.mapError(socketError),
              Effect.andThen(Deferred.await(answer)),
              Effect.timeoutOrElse({ duration: Duration.millis(budget), orElse: () => Effect.fail(timedOut) })
            )
        })
        // Resent with the same invoke ID, so a late answer to an earlier attempt still counts (clause 5.4.4.1).
        return attempt.pipe(
          Effect.retry({ times: retries, while: (error) => error._tag === "BacnetTimeout" }),
          Effect.tap((apdu) =>
            apdu._tag === "ComplexAck" && apdu.segment !== undefined ? abortSegmented(target, invokeId) : Effect.void
          )
        )
      },
      ({ invokeId, answer }) =>
        Effect.flatMap(monotonicMillis, (now) =>
          Effect.sync(() => {
            pending.delete(invokeId)
            if (!Deferred.isDoneUnsafe(answer)) quarantined.set(invokeId, now + quarantineMillis)
          })
        )
    )

  /**
   * Encode, send and decode one confirmed request. A body the encoder refuses
   * fails before anything is sent, and is not counted as a request.
   */
  const request = <A>(
    target: DeviceAddress,
    service: number,
    encode: () => Uint8Array,
    decode: (body: Uint8Array) => Result.Result<A, BacnetCodecError>,
    pools: ReadonlyArray<Semaphore.Semaphore> = [invokeIds]
  ): Effect.Effect<A, BacnetRequestError> =>
    Effect.flatMap(
      Effect.suspend(() => Effect.fromResult(tryEncode(encode))),
      (body) =>
        withPermits(pools, (deadlineAt) => timeRequest(exchange(target, service, body, deadlineAt))).pipe(
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
                return countRequest("timeout")
            }
          })
        )
    )

  const sendWhoIs = (whoIs: WhoIs, target: DeviceAddress | undefined) =>
    send(
      encodeFrame(
        { _tag: "UnconfirmedRequest", service: UnconfirmedService.WhoIs, body: encodeWhoIs(whoIs) },
        target === undefined ? { broadcast: true, destination: GLOBAL_BROADCAST } : routedTo(target)
      ),
      target?.address ?? options.broadcastAddress
    )

  /** Run `use` while `listener` sees every I-Am that arrives. */
  const listening = <A, E>(listener: (device: DiscoveredDevice) => void, use: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => iAmListeners.add(listener)),
      () => use,
      () => Effect.sync(() => iAmListeners.delete(listener))
    )

  const client: BacnetClient = {
    confirmed: (target, service, body) => request(target, service, () => body, Result.succeed),
    readProperty: (target, readRequest) =>
      request(
        target,
        ConfirmedService.ReadProperty,
        () => encodeReadProperty(readRequest),
        (body) => Result.flatMap(decodeReadPropertyAck(body), (ack) => checkReadPropertyAck(readRequest, ack))
      ),
    readPropertyMultiple: (target, specifications) =>
      request(
        target,
        ConfirmedService.ReadPropertyMultiple,
        () => encodeReadPropertyMultiple(specifications),
        (body) =>
          Result.flatMap(decodeReadPropertyMultipleAck(body), (results) =>
            checkReadPropertyMultipleAck(specifications, results)
          )
      ),
    discover: (discoverOptions = {}) =>
      Effect.suspend(() => {
        const found = makeDiscoveryCollector()
        const whoIs: WhoIs = discoverOptions.range === undefined ? {} : { range: discoverOptions.range }
        const target = discoverOptions.target
        return listening(
          (device) => {
            // Asked one address: an I-Am from anywhere else answers someone else's Who-Is.
            if (target !== undefined && !sameDevice(device, target)) return
            if (whoIsMatches(whoIs, device.instance)) found.add(device)
          },
          sendWhoIs(whoIs, discoverOptions.target).pipe(
            Effect.andThen(Effect.sleep(discoverOptions.within ?? requestTimeout))
          )
        ).pipe(Effect.map(found.devices))
      }),
    writeProperty: (target, writeRequest) =>
      request(
        target,
        ConfirmedService.WriteProperty,
        () => encodeWriteProperty(writeRequest),
        (body) =>
          body.length === 0
            ? Result.succeed(undefined)
            : Result.fail(new BacnetCodecError({ message: "WriteProperty was answered with data, not a simple ack" }))
      ),
    subscribeCov: (target, subscription) =>
      request(
        target,
        ConfirmedService.SubscribeCov,
        () => encodeSubscribeCov(subscription),
        (body) =>
          body.length === 0
            ? Result.succeed(undefined)
            : Result.fail(new BacnetCodecError({ message: "SubscribeCOV was answered with data, not a simple ack" })),
        [covRequests, invokeIds]
      ),
    // Unsigned32 (clause 13.14.1.1), 0 left out so that a missing value never matches. Random, so that a
    // host that cannot see the subscription cannot guess the identifier its notifications must carry.
    newProcessId: Effect.gen(function* () {
      let processId = yield* Random.nextIntBetween(1, 0xff_ff_ff_ff)
      while (issuedProcessIds.has(processId)) processId = yield* Random.nextIntBetween(1, 0xff_ff_ff_ff)
      issuedProcessIds.add(processId)
      return processId
    }),
    onCovNotification: (processId, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => covListeners.set(processId, listener)),
        () => Effect.sync(() => covListeners.delete(processId))
      ).pipe(Effect.asVoid),
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
            const target = locateOptions.target
            const fromTarget = target === undefined || sameDevice(device, target)
            if (device.instance === instance && fromTarget) Deferred.doneUnsafe(found, Effect.succeed(device))
          },
          attempt.pipe(Effect.retry({ times: retries, while: (error) => error._tag === "BacnetTimeout" }))
        )
      })
  }
  return client
})
