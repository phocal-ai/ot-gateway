/**
 * The BACnet/IP driver: finds its device with Who-Is, then reads every point
 * with ReadPropertyMultiple, falling back to ReadProperty for devices that do
 * not support it.
 *
 * - **Batches** are sized from the largest APDU the device accepts (from its
 *   I-Am). A device that still aborts an answer as too large gets half the
 *   batch, and keeps that size. One that rejects ReadPropertyMultiple is read
 *   point by point, and asked again after an hour.
 * - **One point** the device cannot read (unknown object or property, a value
 *   that is not a number or boolean) costs only that point. It is logged when
 *   it starts failing and when it recovers, not every cycle. The read fails
 *   when no point could be read.
 * - **A busy device** (an abort that is not about the request) is left alone
 *   for the rest of the cycle and a while after, instead of being asked again
 *   point by point.
 * - **A timeout** is logged once for the device, not for each point, and
 *   after several the device is looked up again, in case it moved.
 * - **Change of value** (`cov`, on by default): every object with a
 *   present-value point gets an unconfirmed COV subscription (clause 13.14),
 *   renewed before it runs out. While its notifications arrive, the polling
 *   cycle skips the object's present-value points; an object the device
 *   refuses, or that goes quiet, is polled again. When every point is pushed,
 *   the cycle reads one only to see that the device still answers, and does
 *   not publish that read: each value goes out once per notification.
 *
 * Binary objects' present values (`inactive`/`active`) are published as
 * booleans; every other numeric value as a number.
 */
import * as NodeDatagramSocket from "@effect/platform-node/NodeDatagramSocket"
import {
  type BacnetDevice,
  type BacnetSettings,
  DriverError,
  monotonicMillis,
  pointReadFailures,
  pushedPoints
} from "@ot-gateway/core"
import type { BacnetPoint, Driver, Network, PointValue, Reading, WriteValue } from "@ot-gateway/core"
import { Clock, Duration, Effect, Equal, Metric, Option, Queue, Result, Schedule, Schema, Stream } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import { AbortReason, MAX_APDU_IP, RejectReason } from "./Apdu.ts"
import {
  type BacnetClient,
  type BacnetDeviceError,
  BacnetSocketError,
  BacnetTimeout,
  type DeviceAddress,
  makeBacnetClient
} from "./Client.ts"
import type { BacnetValue, ObjectId } from "./Encoding.ts"
import { ErrorClass, ErrorCode, nameOf, ObjectType, objectTypeNumber, PropertyId, propertyNumber } from "./Enums.ts"
import type { CovNotification, PropertyResult, ReadAccessResult, ReadAccessSpecification } from "./Services.ts"

/** The BACnet/IP port, `0xBAC0` (Annex J.1). */
export const BACNET_PORT = 47_808

/** A configured point with its object and property resolved to numbers. */
interface ResolvedPoint {
  readonly point: BacnetPoint
  readonly object: ObjectId
  readonly property: number
  /** Publish the value as a boolean (a binary object's present value). */
  readonly binary: boolean
  /** A multi-state object's present value: an Unsigned state index from 1 (clause 12.18-12.20). */
  readonly multiState: boolean
}

const binaryTypes = new Set<number>([
  ObjectType["binary-input"],
  ObjectType["binary-output"],
  ObjectType["binary-value"]
])

const multiStateTypes = new Set<number>([
  ObjectType["multi-state-input"],
  ObjectType["multi-state-output"],
  ObjectType["multi-state-value"]
])

/**
 * The BACnet value that writes `value` to a point, or why it cannot: a
 * binary object takes the enumerations inactive (0) and active (1), a
 * multi-state one an Unsigned state from 1, anything else a REAL, and Null
 * relinquishes the gateway's priority slot.
 */
export const writeValueFor = (resolved: ResolvedPoint, value: WriteValue): BacnetValue | string => {
  if (value === null) return { type: "null" }
  if (resolved.binary) {
    return typeof value === "boolean"
      ? { type: "enumerated", value: value ? 1 : 0 }
      : "a binary point takes true or false"
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return "an analog point takes a finite number"
  if (resolved.multiState) {
    return Number.isInteger(value) && value >= 1 && value <= 0xffff_ffff
      ? { type: "unsigned", value }
      : "a multi-state point takes a whole number from 1 (its state)"
  }
  return { type: "real", value }
}

/** Resolve the point's names to numbers, or say what is wrong with it. */
export const resolvePoint = (point: BacnetPoint): Result.Result<ResolvedPoint, string> => {
  const objectType = objectTypeNumber(point.objectType)
  if (objectType === undefined) return Result.fail(`unknown object type "${point.objectType}"`)
  const property = propertyNumber(point.property)
  if (property === undefined) return Result.fail(`unknown property "${point.property}"`)
  if (property === PropertyId.all || property === PropertyId.required || property === 80) {
    return Result.fail(`"${point.property}" reads several properties; name one`)
  }
  return Result.succeed({
    point,
    object: { objectType, instance: point.instance },
    property,
    binary: binaryTypes.has(objectType) && property === PropertyId["present-value"],
    multiState: multiStateTypes.has(objectType) && property === PropertyId["present-value"]
  })
}

/** A device address from config: `host` or `host:port`, port 47808 by default. */
export const parseDeviceAddress = (text: string): Result.Result<NetAddress.InetAddress, string> => {
  const [host = "", port] = text.split(":")
  const address = NetAddress.inetAddressFromIpString(host, port === undefined ? BACNET_PORT : Number(port))
  return Result.mapError(address, () => `invalid address "${text}"`)
}

/** The point's value from the property's values, or why it has none OT Gateway can publish. */
export const toPointValue = (
  resolved: Pick<ResolvedPoint, "binary">,
  values: ReadonlyArray<BacnetValue>
): Result.Result<PointValue, string> => {
  const [value] = values
  if (value === undefined || values.length > 1) return Result.fail(`expected one value, got ${values.length}`)
  switch (value.type) {
    case "real":
    case "double":
      // An open sensor circuit reads as NaN on some devices; a non-finite number is not a measurement.
      return Number.isFinite(value.value)
        ? Result.succeed(value.value)
        : Result.fail(`not a finite number (${value.value})`)
    case "unsigned":
    case "signed":
      return Result.succeed(value.value)
    case "enumerated":
      return Result.succeed(resolved.binary ? value.value !== 0 : value.value)
    case "boolean":
      return Result.succeed(value.value)
    case "null":
      return Result.fail("the property has no value (null)")
    case "octet-string":
    case "character-string":
    case "bit-string":
    case "date":
    case "time":
    case "object-identifier":
    case "context":
    case "constructed":
      return Result.fail(`a ${value.type} is not a number or boolean`)
  }
}

/**
 * Properties per ReadPropertyMultiple so the answer fits in `maxApdu` bytes
 * (at most what BACnet/IP carries): the worst case per point is its object
 * identifier (5), the list tags (2), the property identifier (3), the value
 * tags (2) and a double or 8-byte integer with its extended length (10).
 */
export const batchSizeFor = (maxApdu: number) => Math.max(1, Math.floor((Math.min(maxApdu, MAX_APDU_IP) - 3) / 22))

/** Assumed for a device at a fixed address that does not answer Who-Is: the size most IP devices accept. */
const ASSUMED_MAX_APDU = 480

/** Cycles in a row that time out before a device found by broadcast is looked for again. */
const LOST_AFTER_CYCLES = 3

/** Clean cycles after which a batch size that was halved is doubled again, up to the size the device allows. */
const REGROW_AFTER_CYCLES = 10

/** Broadcast Who-Is reaches every network of the site, so it is repeated at most this often, then less often. */
const LOCATE_BACKOFF = { firstMs: 30_000, maxMs: 600_000 }

/**
 * How often a device that rejected ReadPropertyMultiple is asked again, a
 * fixed address is asked its APDU size, and points read alone are tried in
 * batches again.
 */
const RECHECK_MS = 3_600_000

/** A busy device is left alone this long, then twice as long for each cycle in a row it is still busy. */
const BUSY_BACKOFF = { firstMs: 5_000, maxMs: 60_000 }

/**
 * Requests a cycle may spend beyond one per batch: finding out which point
 * of a batch the device refused as a whole is the cause, and reading the
 * points found that way one by one. What is left over waits for the next
 * cycle, so a device that refuses everything costs a bounded number of
 * requests per cycle.
 */
const ISOLATION_BUDGET = 32

/** What a ReadPropertyMultiple the device refused as a whole means. */
type Refusal =
  /** The device does not implement the service: read point by point. */
  | "unsupported"
  /** The answer did not fit in one unsegmented APDU: ask for less. */
  | "too-large"
  /** Not the request's fault (preempted, out of resources): leave the device alone for a while. */
  | "busy"
  /** Something in the request: find out which point, one at a time. */
  | "refused"

/** By reject and abort reason (clause 21, BACnetRejectReason and BACnetAbortReason; clause 5.4.4 for their use). */
const refusalOf = (error: BacnetDeviceError): Refusal => {
  switch (error.kind) {
    case "reject":
      if (error.code === RejectReason.UnrecognizedService) return "unsupported"
      return error.code === RejectReason.BufferOverflow ? "too-large" : "refused"
    case "abort":
      return error.code === AbortReason.SegmentationNotSupported || error.code === AbortReason.ApduTooLong
        ? "too-large"
        : "busy"
    case "error":
      return "refused"
  }
}

/** An abort that may mean the batch was too much for the device's buffers, not only that it is busy. */
const outOfRoom = (error: BacnetDeviceError) =>
  error.kind === "abort" && (error.code === AbortReason.BufferOverflow || error.code === AbortReason.OutOfResources)

/** The device aborted for a reason that is not the request's fault; the cycle stops asking it. */
class DeviceBusy extends Schema.TaggedError<DeviceBusy>()("DeviceBusy", {
  message: Schema.String
}) {}

const keyOf = (object: ObjectId, property: number, arrayIndex?: number) =>
  `${object.objectType}:${object.instance}:${property}:${arrayIndex ?? ""}`

/** One request per run of points on the same object, in order. */
const specificationsOf = (points: ReadonlyArray<ResolvedPoint>): ReadonlyArray<ReadAccessSpecification> => {
  const specifications: Array<{ object: ObjectId; properties: Array<{ property: number }> }> = []
  for (const { object, property } of points) {
    const last = specifications.at(-1)
    if (last?.object.objectType === object.objectType && last.object.instance === object.instance) {
      last.properties.push({ property })
    } else specifications.push({ object, properties: [{ property }] })
  }
  return specifications
}

type PointOutcome =
  | { readonly _tag: "Value"; readonly point: ResolvedPoint; readonly value: PointValue; readonly timestamp: number }
  /** The device answered, but with no value OT Gateway can publish. */
  | { readonly _tag: "Failed"; readonly point: ResolvedPoint; readonly reason: string }
  /** Not asked this cycle: the device stopped answering or was busy before it got there, or the budget ran out. */
  | { readonly _tag: "NotRead"; readonly point: ResolvedPoint }

const notRead = (points: ReadonlyArray<ResolvedPoint>): ReadonlyArray<PointOutcome> =>
  points.map((point) => ({ _tag: "NotRead", point }))

/** Points a device did not give a value for, by `reason`: `refused` (it answered without one) or `not_read`. */
const countPointFailures = (reason: "refused" | "not_read", count: number) =>
  count === 0 ? Effect.void : Metric.update(Metric.withAttributes(pointReadFailures, { reason }), count)

/** Where the device is, and the largest APDU it takes. */
interface Location extends DeviceAddress {
  readonly maxApdu: number
}

/** Timing of COV subscriptions; the defaults suit production, tests shorten them. */
export interface CovTiming {
  /** Requested lifetime of a subscription. Default 300 s. */
  readonly lifetimeSeconds: number
  /** Renew this long after subscribing: half the lifetime, so one lost renewal does not end it. */
  readonly renewMs: number
  /** How often subscriptions are checked, made or retried. Default 5 s. */
  readonly checkMs: number
  /** A subscription that timed out is tried again after this, then twice as long each time. Default 30 s. */
  readonly retryMs: number
  /** The longest wait between attempts for an object whose subscriptions keep timing out. Default 10 minutes. */
  readonly retryMaxMs: number
  /** An object the device refused a subscription for is tried again after this. Default 1 hour. */
  readonly refusedRetryMs: number
}

const defaultCovTiming: CovTiming = {
  lifetimeSeconds: 300,
  renewMs: 150_000,
  checkMs: 5_000,
  retryMs: 30_000,
  retryMaxMs: 600_000,
  refusedRetryMs: 3_600_000
}

/**
 * COV timing for a configured lifetime (`bacnet.covLifetimeSeconds`): renew
 * at half of it, and check at least ten times per lifetime (every 5 s at most),
 * so a renewal is never late by more than a tenth of the lifetime.
 */
export const covTimingFor = (lifetimeSeconds: number): Partial<CovTiming> => ({
  lifetimeSeconds,
  renewMs: lifetimeSeconds * 500,
  checkMs: Math.min(defaultCovTiming.checkMs, lifetimeSeconds * 100)
})

const logDefect = (message: string) => (defect: unknown) =>
  Effect.logError(message).pipe(Effect.annotateLogs({ error: String(defect) }))

/** Notifications and readings waiting at most; the oldest are dropped beyond this. */
const BACKLOG = 1024

/** SubscribeCOV requests in flight per device. The client also caps them across devices. */
const COV_CONCURRENCY = 4

/** A round of subscribing stops after this many attempts in a row got no answer: the device is down or swamped. */
const COV_SILENT_IN_A_ROW = 2 * COV_CONCURRENCY

/**
 * Runs for every notification, so it compares without formatting or allocating. `Equal.equals` would hash both
 * sides first; the IP's own equality compares the numbers.
 */
const sameInet = (left: NetAddress.InetAddress, right: NetAddress.InetAddress) =>
  left.port === right.port &&
  (left._tag === "InetAddressV4"
    ? right._tag === "InetAddressV4"
    : right._tag === "InetAddressV6" && left.scopeId === right.scopeId) &&
  left.address[Equal.symbol](right.address)

const sameAddress = (left: DeviceAddress, right: DeviceAddress) => {
  if (!sameInet(left.address, right.address)) return false
  if (left.network?.network !== right.network?.network) return false
  const leftHops = left.network?.address ?? []
  const rightHops = right.network?.address ?? []
  return leftHops.length === rightHops.length && leftHops.every((byte, index) => byte === rightHops[index])
}

const describeObject = (object: ObjectId) => `${nameOf(ObjectType, object.objectType)}:${object.instance}`

const OTHER_DEVICE = "for another device"

/** One subscribed object and the present-value points it feeds. */
interface CovObject {
  readonly object: ObjectId
  readonly points: ReadonlyArray<ResolvedPoint>
  /** The address the live subscription was made at; `undefined` when there is none. */
  subscribedAt: DeviceAddress | undefined
  /** When to subscribe again (renew, or retry). */
  nextAttemptAt: number
  /** When the last usable notification arrived; none since subscribing at a new address or a restart. */
  heardAt: number | undefined
  /** Why the device refused, while it does; logged when it starts and when it ends. */
  refused: string | undefined
  /** Attempts in a row that got no answer (or a busy abort); each one waits twice as long as the last. */
  silent: number
}

/**
 * The COV side of one device: subscriptions for every object with a
 * present-value point, the notifications they bring as readings, and which
 * points they currently keep up to date.
 *
 * It only reads `location`, which the polling cycle owns: nothing is
 * subscribed before the device has been found, and a device that moved is
 * subscribed again at its new address.
 */
const makeCovSubscriptions = (deps: {
  readonly client: BacnetClient
  readonly deviceInstance: number
  readonly points: ReadonlyArray<ResolvedPoint>
  readonly location: () => DeviceAddress | undefined
  /** Whether the polling cycle last found the device answering and not busy; otherwise nothing is subscribed. */
  readonly reachable: (now: number) => boolean
  readonly timing: CovTiming
}) => {
  const { client, timing } = deps
  const byObject = new Map<string, CovObject>()
  for (const point of deps.points) {
    if (point.property !== PropertyId["present-value"]) continue
    const key = keyOf(point.object, point.property)
    const known = byObject.get(key)
    if (known === undefined) {
      byObject.set(key, {
        object: point.object,
        points: [point],
        subscribedAt: undefined,
        nextAttemptAt: 0,
        heardAt: undefined,
        refused: undefined,
        silent: 0
      })
    } else byObject.set(key, { ...known, points: [...known.points, point] })
  }
  const objects = [...byObject.values()]
  const lifetimeMs = timing.lifetimeSeconds * 1000

  /** The object is pushing: subscribed where the device is now, and heard from within the lifetime. */
  const live = (entry: CovObject, now: number) => {
    const location = deps.location()
    return (
      location !== undefined &&
      entry.subscribedAt !== undefined &&
      sameAddress(entry.subscribedAt, location) &&
      entry.heardAt !== undefined &&
      now - entry.heardAt < lifetimeMs
    )
  }

  /** Ids of the points the polling cycle can skip. */
  const pushedPointIds = (now: number) =>
    new Set(objects.flatMap((entry) => (live(entry, now) ? entry.points.map((point) => point.point.id) : [])))

  /** Subscribe (or renew) one object at `location`, and schedule its next attempt by how that went. */
  const attempt = Effect.fnUntraced(function* (
    entry: CovObject,
    location: DeviceAddress,
    processId: number,
    round: { silentInARow: number }
  ) {
    const moved = entry.subscribedAt !== undefined && !sameAddress(entry.subscribedAt, location)
    const outcome = yield* client
      .subscribeCov(location, { processId, object: entry.object, confirmed: false, lifetime: timing.lifetimeSeconds })
      .pipe(
        Effect.as({ _tag: "Accepted" } as const),
        Effect.catchTags({
          BacnetDeviceError: (error) =>
            Effect.succeed(
              refusalOf(error) === "busy"
                ? ({ _tag: "Silent" } as const)
                : ({ _tag: "Refused", reason: error.message } as const)
            ),
          BacnetCodecError: (error) => Effect.succeed({ _tag: "Refused", reason: error.message } as const),
          BacnetEncodeError: (error) => Effect.succeed({ _tag: "Refused", reason: error.message } as const),
          BacnetTimeout: () => Effect.succeed({ _tag: "Silent" } as const),
          BacnetSocketError: () => Effect.succeed({ _tag: "Silent" } as const)
        })
      )
    const now = yield* monotonicMillis
    switch (outcome._tag) {
      case "Accepted": {
        round.silentInARow = 0
        entry.silent = 0
        if (moved || entry.subscribedAt === undefined) entry.heardAt = undefined
        entry.subscribedAt = location
        entry.nextAttemptAt = now + timing.renewMs
        if (entry.refused === undefined) return
        entry.refused = undefined
        return yield* Effect.log("COV subscription accepted").pipe(
          Effect.annotateLogs({ object: describeObject(entry.object) })
        )
      }
      case "Refused": {
        round.silentInARow = 0
        entry.silent = 0
        entry.subscribedAt = undefined
        entry.nextAttemptAt = now + timing.refusedRetryMs
        if (entry.refused === outcome.reason) return
        entry.refused = outcome.reason
        return yield* Effect.logWarning("device refused a COV subscription, polling the object instead").pipe(
          Effect.annotateLogs({ object: describeObject(entry.object), reason: outcome.reason })
        )
      }
      case "Silent":
        // No answer: the subscription may still be live; it lapses on its own if the device stays silent.
        // One made at an address the device has left is gone, so it is not retried at every check.
        round.silentInARow++
        entry.silent++
        if (moved) entry.subscribedAt = undefined
        entry.nextAttemptAt = now + Math.min(timing.retryMaxMs, timing.retryMs * 2 ** (entry.silent - 1))
    }
  })

  /**
   * Subscribe (or renew) every object that is due, a few at a time. Objects
   * that answer go first, most overdue first; those that went silent go last
   * and back off, and the round ends early once several in a row got no
   * answer, so silent objects cannot hold up the renewals of the others.
   */
  const maintain = (processId: number) =>
    Effect.gen(function* () {
      const location = deps.location()
      const now = yield* monotonicMillis
      // A device that timed out or is busy is left alone; the cycle that finds it again subscribes everything anew.
      if (location === undefined || !deps.reachable(now)) return
      const due = objects
        .filter(
          (entry) =>
            now >= entry.nextAttemptAt ||
            (entry.subscribedAt !== undefined && !sameAddress(entry.subscribedAt, location))
        )
        .toSorted(
          (left, right) =>
            Number(left.silent > 0) - Number(right.silent > 0) || left.nextAttemptAt - right.nextAttemptAt
        )
      const round = { silentInARow: 0 }
      yield* Effect.forEach(
        due,
        (entry) =>
          Effect.suspend(() =>
            round.silentInARow >= COV_SILENT_IN_A_ROW ? Effect.void : attempt(entry, location, processId, round)
          ),
        { concurrency: COV_CONCURRENCY, discard: true }
      )
    })

  /** The readings a notification carries, or why it does not count. */
  /** `now` is monotonic, for the subscription's bookkeeping; `timestamp` is wall time, for the readings. */
  const readingsOf = (notification: CovNotification, from: DeviceAddress, now: number, timestamp: number) => {
    const location = deps.location()
    if (location === undefined || !sameAddress(from, location)) return "from another address"
    const initiating = notification.initiatingDevice
    if (initiating.objectType !== ObjectType.device || initiating.instance !== deps.deviceInstance) {
      return OTHER_DEVICE
    }
    const entry = byObject.get(keyOf(notification.object, PropertyId["present-value"]))
    if (entry === undefined) return "for an object without points"
    const presentValue = notification.values.find(
      (value) => value.property === PropertyId["present-value"] && value.arrayIndex === undefined
    )
    if (presentValue === undefined) return "without a present value"
    const readings: Array<Reading> = []
    for (const point of entry.points) {
      const value = toPointValue(point, presentValue.values)
      // A value the gateway cannot publish: let the polling cycle read the object, and report it.
      if (Result.isFailure(value)) {
        entry.heardAt = undefined
        return `unusable value (${value.failure})`
      }
      readings.push({ pointId: point.point.id, value: value.success, timestamp })
    }
    entry.heardAt = now
    return readings
  }

  // Bounded, dropping the oldest: while the broker is slow, renewals bring the current values again.
  const changes: Stream.Stream<Reading> = Stream.callback<Reading>(
    (output) =>
      Effect.gen(function* () {
        const processId = yield* client.newProcessId
        const arrived = yield* Queue.sliding<{ notification: CovNotification; from: DeviceAddress }>(BACKLOG)
        yield* client.onCovNotification(processId, (notification, from) => {
          Queue.offerUnsafe(arrived, { notification, from })
        })
        yield* Effect.addFinalizer(() => stop(processId))
        // A notification about another device is most likely a wrong `deviceInstance` in the config: said once.
        let warnedAboutDevice = false
        yield* maintain(processId).pipe(
          Effect.catchDefect(logDefect("COV subscription check failed")),
          Effect.repeat(Schedule.spaced(timing.checkMs)),
          Effect.forkScoped
        )
        return yield* Effect.forever(
          Effect.gen(function* () {
            const { notification, from } = yield* Queue.take(arrived)
            const outcome = readingsOf(notification, from, yield* monotonicMillis, yield* Clock.currentTimeMillis)
            if (outcome === OTHER_DEVICE && !warnedAboutDevice) {
              warnedAboutDevice = true
              return yield* Effect.logWarning(
                "COV notification from the device's address names another device; is deviceInstance right?"
              ).pipe(
                Effect.annotateLogs({
                  configured: deps.deviceInstance,
                  named: notification.initiatingDevice.instance,
                  object: describeObject(notification.object)
                })
              )
            }
            if (typeof outcome === "string") {
              return yield* Effect.logDebug("ignored a COV notification").pipe(
                Effect.annotateLogs({ object: describeObject(notification.object), reason: outcome })
              )
            }
            yield* Queue.offerAll(output, outcome)
          }).pipe(Effect.catchDefect(logDefect("COV notification could not be handled")))
        )
      }),
    { bufferSize: BACKLOG, strategy: "sliding" }
  )

  /**
   * Nothing is pushed any more: poll every point again, and cancel the live
   * subscriptions where they were made, without holding up shutdown for a
   * silent device. A few at a time, so a small device behind a router is not
   * flooded.
   */
  const stop = (processId: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      const active = objects.flatMap((entry) =>
        entry.subscribedAt === undefined ? [] : [{ object: entry.object, at: entry.subscribedAt }]
      )
      for (const entry of objects) {
        entry.subscribedAt = undefined
        entry.heardAt = undefined
        entry.nextAttemptAt = 0
        entry.silent = 0
      }
      if (active.length === 0) return Effect.void
      return Effect.forEach(active, ({ object, at }) => client.subscribeCov(at, { processId, object }), {
        concurrency: 4,
        discard: true
      }).pipe(
        Effect.timeout("2 seconds"),
        Effect.catchCause((cause) =>
          Effect.logDebug("could not cancel COV subscriptions; they run out on their own").pipe(
            Effect.annotateLogs({ cause: String(cause) })
          )
        )
      )
    })

  /**
   * The device was unreachable and answers again; it may have restarted and
   * lost its subscriptions. Subscribe again now, and poll until the first
   * notifications arrive.
   */
  const resync = () => {
    for (const entry of objects) {
      entry.heardAt = undefined
      entry.nextAttemptAt = 0
      entry.silent = 0
    }
  }

  return { objects: objects.length, changes, pushedPointIds, resync }
}

export interface BacnetDriverOptions {
  /** Start with this many properties per ReadPropertyMultiple instead of sizing them from the device's I-Am. */
  readonly batchSize?: number
  /** Override COV timing (tests). */
  readonly cov?: Partial<CovTiming>
}

/**
 * A driver over an existing client. Fails with a `configuration` error when
 * a point names an unknown object type or property, or the address is invalid.
 */
export const makeBacnetDriverFromClient = Effect.fn("makeBacnetDriverFromClient")(function* (
  device: BacnetDevice,
  client: BacnetClient,
  options: BacnetDriverOptions = {}
) {
  const configurationError = (message: string) =>
    new DriverError({ device: device.id, reason: "configuration", message })
  const points: Array<ResolvedPoint> = []
  for (const point of device.points) {
    const resolved = resolvePoint(point)
    if (Result.isFailure(resolved)) return yield* configurationError(`point ${point.id}: ${resolved.failure}`)
    points.push(resolved.success)
  }
  const parsedAddress = device.address === undefined ? undefined : parseDeviceAddress(device.address)
  if (parsedAddress !== undefined && Result.isFailure(parsedAddress)) {
    return yield* configurationError(parsedAddress.failure)
  }
  const fixedAddress = parsedAddress?.success

  // State of this device's one polling fiber; nothing else touches it.
  let location: Location | undefined
  let largestBatch = 1
  let batchSize = 1
  let multiple = true
  /** When a device that rejected ReadPropertyMultiple is asked again (monotonic). */
  let multipleRecheckAt = 0
  /** This cycle asks ReadPropertyMultiple again after a rejection; a second one is not logged again. */
  let reprobing = false
  let cleanCycles = 0
  /** The smallest batch the device refused as too large; batches grow back only to below it. */
  let refusedAt: number | undefined
  /** The largest batch the device answered; a probe above it that fails falls back to it, not below. */
  let largestAnswered = 0
  /** Batch sizes the shrink was logged for, so settling on a size is said once. */
  const shrinksLogged = new Set<number>()
  let lostCycles = 0
  let nextBroadcastAt = 0
  let broadcastBackoffMs = LOCATE_BACKOFF.firstMs
  /** When a fixed address is asked its APDU size again (monotonic). */
  let recheckAt = 0
  /** Until when a busy device is left alone (monotonic), and the wait the next busy cycle gets. */
  let busyUntil = 0
  let busyBackoffMs = BUSY_BACKOFF.firstMs
  let busyReason: string | undefined
  /** Points that failed last time, with the reason, so each change is logged once. */
  const failing = new Map<string, string>()
  /**
   * Points the device refused even in a batch of one: read alone with
   * ReadProperty from then on, so the batches they were in are not refused
   * every cycle. Tried in batches again every hour.
   */
  const isolated = new Set<string>()
  let isolatedUntil = 0
  /** Where reading the isolated points starts this cycle, so a budget smaller than them reaches all in turn. */
  let isolatedOffset = 0

  const remember = (found: Location, how: string) =>
    Effect.suspend(() => {
      location = found
      largestBatch = options.batchSize ?? batchSizeFor(found.maxApdu)
      batchSize = largestBatch
      multiple = true
      reprobing = false
      cleanCycles = 0
      // A device found again may have restarted with other limits: what it refused before is asked again.
      refusedAt = undefined
      largestAnswered = 0
      shrinksLogged.clear()
      lostCycles = 0
      broadcastBackoffMs = LOCATE_BACKOFF.firstMs
      isolated.clear()
      isolatedUntil = 0
      return Effect.log(how).pipe(
        Effect.annotateLogs({
          instance: device.deviceInstance,
          address: NetAddress.formatInet(found.address),
          maxApdu: found.maxApdu,
          ...(found.network === undefined ? {} : { network: found.network.network })
        })
      )
    })

  /** Who-Is to every network, at most as often as the backoff allows; `undefined` when not found (or not asked). */
  const broadcastLocate = Effect.gen(function* () {
    const now = yield* monotonicMillis
    if (now < nextBroadcastAt) return undefined
    return yield* client.locate(device.deviceInstance).pipe(
      Effect.catchTag("BacnetTimeout", () =>
        Effect.sync(() => {
          nextBroadcastAt = now + broadcastBackoffMs
          broadcastBackoffMs = Math.min(LOCATE_BACKOFF.maxMs, broadcastBackoffMs * 2)
          return undefined
        })
      )
    )
  })

  /**
   * The device object's Max_APDU_Length_Accepted (clause 12.11.18), for a
   * device whose I-Am does not reach the gateway; `undefined` if it does not say.
   */
  const readMaxApdu = (target: DeviceAddress) =>
    client
      .readProperty(target, {
        object: { objectType: ObjectType.device, instance: device.deviceInstance },
        property: PropertyId["max-apdu-length-accepted"]
      })
      .pipe(
        // 50 bytes is the smallest APDU a device may accept (clause 20.1.2.5).
        Effect.map(([value, ...rest]) =>
          value?.type === "unsigned" && rest.length === 0 && value.value >= 50
            ? Option.some(value.value)
            : Option.none()
        ),
        Effect.catchTags({
          BacnetTimeout: () => Effect.succeedNone,
          BacnetDeviceError: () => Effect.succeedNone,
          BacnetCodecError: () => Effect.succeedNone,
          BacnetEncodeError: () => Effect.succeedNone
        }),
        Effect.map(Option.getOrUndefined)
      )

  /**
   * A fixed address: Who-Is goes there for the device's APDU size, and if no
   * I-Am arrives (one broadcast on another subnet never does) the device
   * object is asked instead; failing both, 480 bytes is assumed. It is asked
   * again every hour while the device answers (every 10 minutes while the
   * size is only assumed), so one missed Who-Is does not cost it forever.
   */
  const locateFixed = Effect.fnUntraced(function* (address: NetAddress.InetAddress) {
    const now = yield* monotonicMillis
    // While the device does not answer, asking costs only more waiting.
    if (location !== undefined && (now < recheckAt || lostCycles > 0)) return location
    const target = { address }
    const found = yield* client.locate(device.deviceInstance, { target }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("BacnetTimeout", () => Effect.succeedNone),
      Effect.map(Option.getOrUndefined)
    )
    const maxApdu = found?.maxApdu ?? (yield* readMaxApdu(target))
    recheckAt = now + (maxApdu === undefined ? LOCATE_BACKOFF.maxMs : RECHECK_MS)
    const located: Location = found ?? { ...target, maxApdu: maxApdu ?? location?.maxApdu ?? ASSUMED_MAX_APDU }
    if (location !== undefined) {
      if (sameAddress(location, located) && location.maxApdu === located.maxApdu) return location
      yield* remember(located, "BACnet device's largest APDU changed")
      return located
    }
    yield* remember(
      located,
      found !== undefined
        ? "found BACnet device"
        : maxApdu === undefined
          ? `BACnet device did not answer Who-Is, reading it at its address assuming ${ASSUMED_MAX_APDU}-byte APDUs`
          : "BACnet device did not answer Who-Is, reading it at its address"
    )
    return located
  })

  /**
   * Where to send requests. A fixed address is used whether or not it answers
   * Who-Is. Otherwise the device is found by broadcast, and looked for again
   * only after several cycles timed out.
   */
  const locate: Effect.Effect<Location, BacnetTimeout | BacnetSocketError> = Effect.gen(function* () {
    if (fixedAddress !== undefined) return yield* locateFixed(fixedAddress)
    if (location === undefined || lostCycles >= LOST_AFTER_CYCLES) {
      const found = yield* broadcastLocate
      if (found !== undefined) {
        const moved =
          location !== undefined && NetAddress.formatInet(location.address) !== NetAddress.formatInet(found.address)
        yield* remember(found, moved ? "BACnet device moved" : "found BACnet device")
      }
    }
    if (location !== undefined) return location
    const waitSeconds = Math.ceil(Math.max(0, nextBroadcastAt - (yield* monotonicMillis)) / 1000)
    return yield* new BacnetTimeout({
      message: `device ${device.deviceInstance} did not answer Who-Is; asking again in ${waitSeconds} s`
    })
  })

  const outcomeOf = (point: ResolvedPoint, result: PropertyResult | undefined, timestamp: number): PointOutcome => {
    if (result === undefined) return { _tag: "Failed", point, reason: "missing from the answer" }
    if (result._tag === "Error") {
      return {
        _tag: "Failed",
        point,
        reason: `${nameOf(ErrorClass, result.errorClass)}: ${nameOf(ErrorCode, result.errorCode)}`
      }
    }
    const value = toPointValue(point, result.values)
    return Result.isSuccess(value)
      ? { _tag: "Value", point, value: value.success, timestamp }
      : { _tag: "Failed", point, reason: value.failure }
  }

  /** The outcome of reading one point with ReadProperty; an unreachable or busy device fails. */
  const readOne = (target: DeviceAddress, point: ResolvedPoint) =>
    client.readProperty(target, { object: point.object, property: point.property }).pipe(
      Effect.flatMap((values) =>
        Effect.map(Clock.currentTimeMillis, (timestamp) =>
          outcomeOf(point, { property: point.property, _tag: "Value", values }, timestamp)
        )
      ),
      Effect.catchTags({
        BacnetDeviceError: (error) =>
          refusalOf(error) === "busy"
            ? Effect.fail(new DeviceBusy({ message: error.message }))
            : Effect.succeed<PointOutcome>({ _tag: "Failed", point, reason: error.message }),
        BacnetCodecError: (error) => Effect.succeed<PointOutcome>({ _tag: "Failed", point, reason: error.message }),
        BacnetEncodeError: (error) => Effect.succeed<PointOutcome>({ _tag: "Failed", point, reason: error.message })
      })
    )

  /** The device rejected ReadPropertyMultiple: read point by point, and ask again in an hour. */
  const downgrade = Effect.fnUntraced(function* (why: string) {
    multiple = false
    multipleRecheckAt = (yield* monotonicMillis) + RECHECK_MS
    const again = reprobing
    reprobing = false
    // Asked again after an hour and still rejected: nothing new to say.
    if (again) return
    yield* Effect.log("device does not support ReadPropertyMultiple, reading points one at a time").pipe(
      Effect.annotateLogs({ reason: why, askingAgainInSeconds: RECHECK_MS / 1000 })
    )
  })

  /**
   * A batch of `refused` points was too much: ask for half as many, but not
   * fewer than a batch the device answered, since a larger probe failing says
   * nothing about that size. Always fewer than `refused`, so retrying ends.
   */
  const shrinkFrom = (refused: number) => {
    const answered = largestAnswered < refused ? largestAnswered : 1
    batchSize = Math.max(1, Math.floor(refused / 2), answered)
  }

  /** One ReadPropertyMultiple, its failures as data so the caller decides per kind. */
  const readBatch = (target: DeviceAddress, batch: ReadonlyArray<ResolvedPoint>) =>
    client.readPropertyMultiple(target, specificationsOf(batch)).pipe(
      Effect.map((results) => ({ _tag: "Results" as const, results })),
      Effect.catchTags({
        BacnetDeviceError: (error) => Effect.succeed({ _tag: "Refused" as const, error }),
        BacnetCodecError: (error) => Effect.succeed({ _tag: "Unreadable" as const, message: error.message }),
        BacnetEncodeError: (error) => Effect.succeed({ _tag: "Unreadable" as const, message: error.message }),
        BacnetTimeout: (error) => Effect.succeed({ _tag: "TimedOut" as const, error })
      })
    )

  /**
   * Read `toRead`, in batches with ReadPropertyMultiple while the device
   * supports it. A timeout or a busy device ends the cycle's requests; the
   * points not asked yet are `NotRead`.
   */
  const readPoints = Effect.fnUntraced(function* (target: DeviceAddress, toRead: ReadonlyArray<ResolvedPoint>) {
    const outcomes: Array<PointOutcome> = []
    let requests = 0
    let shrunk = false
    let budget = ISOLATION_BUDGET
    // A holder, because it is set inside callbacks, which control-flow narrowing does not see.
    const stop: { timedOut?: BacnetTimeout; busy?: DeviceBusy } = {}
    const stopped = () => stop.timedOut !== undefined || stop.busy !== undefined

    /** Read `points` one at a time with ReadProperty, until the device stops answering or is busy. */
    const readEach = Effect.fnUntraced(function* (each: ReadonlyArray<ResolvedPoint>, budgeted: boolean) {
      for (const point of each) {
        if (stopped() || (budgeted && budget <= 0)) {
          outcomes.push({ _tag: "NotRead", point })
          continue
        }
        if (budgeted) budget--
        requests++
        outcomes.push(
          yield* readOne(target, point).pipe(
            Effect.catchTags({
              BacnetTimeout: (error) =>
                Effect.sync((): PointOutcome => {
                  stop.timedOut = error
                  return { _tag: "NotRead", point }
                }),
              DeviceBusy: (error) =>
                Effect.sync((): PointOutcome => {
                  stop.busy = error
                  return { _tag: "NotRead", point }
                })
            })
          )
        )
      }
    })

    /** The values of a batch the device answered. */
    const record = Effect.fnUntraced(function* (
      batch: ReadonlyArray<ResolvedPoint>,
      results: ReadonlyArray<ReadAccessResult>
    ) {
      if (reprobing) {
        reprobing = false
        yield* Effect.log("device answers ReadPropertyMultiple again")
      }
      largestAnswered = Math.max(largestAnswered, batch.length)
      const timestamp = yield* Clock.currentTimeMillis
      const byKey = new Map<string, PropertyResult>()
      for (const result of results) {
        for (const item of result.results) byKey.set(keyOf(result.object, item.property, item.arrayIndex), item)
      }
      outcomes.push(
        ...batch.map((point) => outcomeOf(point, byKey.get(keyOf(point.object, point.property)), timestamp))
      )
    })

    /**
     * A point the device refused even alone in a ReadPropertyMultiple: try
     * ReadProperty. If that reads, the device does not really do
     * ReadPropertyMultiple; otherwise the point is read alone from now on.
     */
    const probeAlone = Effect.fnUntraced(function* (
      point: ResolvedPoint,
      why: Refusal | "unreadable",
      message: string
    ) {
      if (budget <= 0) return outcomes.push({ _tag: "NotRead", point })
      const before = outcomes.length
      yield* readEach([point], true)
      const outcome = outcomes[before]
      if (outcome?._tag === "Value" && why === "refused") return yield* downgrade(message)
      if (outcome?._tag !== "NotRead") isolated.add(point.point.id)
    })

    /**
     * Find which points of a batch the device refused as a whole are the
     * cause, by halves, within the budget; the others are read on the way.
     */
    const bisect = (
      batch: ReadonlyArray<ResolvedPoint>,
      why: Refusal | "unreadable",
      message: string
    ): Effect.Effect<void, BacnetSocketError> =>
      Effect.gen(function* () {
        const [first] = batch
        if (batch.length === 1 && first !== undefined) return yield* probeAlone(first, why, message)
        const middle = Math.ceil(batch.length / 2)
        for (const half of [batch.slice(0, middle), batch.slice(middle)]) {
          if (!multiple) {
            yield* readEach(half, false)
            continue
          }
          if (stopped() || budget <= 0) {
            outcomes.push(...notRead(half))
            continue
          }
          budget--
          requests++
          const answer = yield* readBatch(target, half)
          switch (answer._tag) {
            case "Results":
              yield* record(half, answer.results)
              continue
            case "TimedOut":
              stop.timedOut = answer.error
              outcomes.push(...notRead(half))
              continue
            case "Unreadable":
              yield* bisect(half, "unreadable", answer.message)
              continue
            case "Refused": {
              const refusal = refusalOf(answer.error)
              if (refusal === "busy") {
                stop.busy = new DeviceBusy({ message: answer.error.message })
                outcomes.push(...notRead(half))
              } else if (refusal === "unsupported") {
                yield* downgrade(answer.error.message)
                yield* readEach(half, false)
              } else yield* bisect(half, refusal, answer.error.message)
              continue
            }
          }
        }
      })

    const now = yield* monotonicMillis
    if (!multiple && now >= multipleRecheckAt) {
      multiple = true
      reprobing = true
    }
    if (now >= isolatedUntil) {
      isolated.clear()
      isolatedUntil = now + RECHECK_MS
    }
    if (!multiple) {
      yield* readEach(toRead, false)
      return { outcomes, requests, shrunk, ...stop }
    }
    const batched = toRead.filter((point) => !isolated.has(point.point.id))
    const alone = toRead.filter((point) => isolated.has(point.point.id))
    let index = 0
    while (index < batched.length) {
      if (stopped()) {
        outcomes.push(...notRead(batched.slice(index)))
        break
      }
      if (!multiple) {
        yield* readEach(batched.slice(index), false)
        break
      }
      const batch = batched.slice(index, index + batchSize)
      requests++
      const answer = yield* readBatch(target, batch)
      switch (answer._tag) {
        case "TimedOut":
          stop.timedOut = answer.error
          continue
        case "Unreadable":
          // One value the codec cannot read must not cost the others.
          yield* bisect(batch, "unreadable", answer.message)
          index += batch.length
          continue
        case "Refused": {
          const { error } = answer
          // A short batch counts too: a device with fewer points than the batch size would otherwise be bisected every cycle.
          const several = batch.length > 1
          const refusal = refusalOf(error)
          switch (refusal) {
            case "unsupported":
              yield* downgrade(error.message)
              continue
            case "too-large":
              if (!several) break
              refusedAt = Math.min(refusedAt ?? batch.length, batch.length)
              shrinkFrom(batch.length)
              shrunk = true
              if (shrinksLogged.has(batchSize)) continue
              shrinksLogged.add(batchSize)
              yield* Effect.log("answer too large for the device, reading fewer points per request").pipe(
                Effect.annotateLogs({ batchSize })
              )
              continue
            case "busy":
              // Out of buffer space may also mean the batch was too much: the next cycle asks for less.
              if (several && outOfRoom(error)) {
                shrinkFrom(batch.length)
                shrunk = true
              }
              stop.busy = new DeviceBusy({ message: error.message })
              continue
            case "refused":
              break
          }
          // One point whose answer is too large, or an error for the whole request
          // (some devices answer that way when one object is missing): find the point by halves.
          yield* bisect(batch, refusal, error.message)
          index += batch.length
          continue
        }
        case "Results":
          yield* record(batch, answer.results)
          index += batch.length
          continue
      }
    }
    // Points read alone take turns when there are more than the budget allows.
    const start = alone.length === 0 ? 0 : isolatedOffset % alone.length
    const turn = [...alone.slice(start), ...alone.slice(0, start)]
    const budgetBefore = budget
    yield* readEach(turn, true)
    isolatedOffset = start + (budgetBefore - budget)
    return { outcomes, requests, shrunk, ...stop }
  })

  /**
   * After enough clean cycles, try a larger batch again: twice as large, or,
   * once the device refused a size as too large, at most halfway to it, so
   * each failed probe narrows the gap and the size settles instead of being
   * refused again every few cycles.
   */
  const regrow = (shrunk: boolean) =>
    Effect.suspend(() => {
      const ceiling = refusedAt === undefined ? largestBatch : Math.min(largestBatch, refusedAt - 1)
      if (shrunk || !multiple || batchSize >= ceiling) {
        cleanCycles = 0
        return Effect.void
      }
      cleanCycles++
      if (cleanCycles < REGROW_AFTER_CYCLES) return Effect.void
      cleanCycles = 0
      batchSize =
        refusedAt === undefined
          ? Math.min(ceiling, batchSize * 2)
          : Math.min(batchSize * 2, Math.ceil((batchSize + ceiling) / 2))
      return Effect.log("trying more points per request again").pipe(Effect.annotateLogs({ batchSize }))
    })

  /**
   * Log a point that starts failing, fails differently, or recovers. Only
   * points the device answered for count: one it did not get to says nothing
   * about the point, and a device that stops answering is logged once, as a
   * device.
   */
  const report = (outcomes: ReadonlyArray<PointOutcome>) =>
    Effect.forEach(
      outcomes,
      (outcome) => {
        const id = outcome.point.point.id
        const before = failing.get(id)
        switch (outcome._tag) {
          case "NotRead":
            return Effect.void
          case "Value":
            if (before === undefined) return Effect.void
            failing.delete(id)
            return Effect.log("point readable again").pipe(Effect.annotateLogs({ point: id }))
          case "Failed":
            if (before === outcome.reason) return Effect.void
            failing.set(id, outcome.reason)
            return Effect.logWarning("cannot read point").pipe(
              Effect.annotateLogs({
                point: id,
                object: `${outcome.point.point.objectType}:${outcome.point.object.instance}`,
                property: outcome.point.point.property,
                reason: outcome.reason
              })
            )
        }
      },
      { discard: true }
    )

  /** The device aborted as busy: leave it alone for a while, longer each cycle in a row; logged when it starts. */
  const backOff = Effect.fnUntraced(function* (busy: DeviceBusy) {
    const now = yield* monotonicMillis
    busyUntil = now + busyBackoffMs
    const waitSeconds = busyBackoffMs / 1000
    busyBackoffMs = Math.min(BUSY_BACKOFF.maxMs, busyBackoffMs * 2)
    if (busyReason === undefined) {
      yield* Effect.logWarning("BACnet device is busy, leaving it alone for a while").pipe(
        Effect.annotateLogs({ reason: busy.message, seconds: waitSeconds })
      )
    }
    busyReason = busy.message
    return waitSeconds
  })

  const notBusy = Effect.suspend(() => {
    busyBackoffMs = BUSY_BACKOFF.firstMs
    if (busyReason === undefined) return Effect.void
    busyReason = undefined
    return Effect.log("BACnet device is no longer busy")
  })

  const fail = (reason: DriverError["reason"], message: string) =>
    Effect.fail(new DriverError({ device: device.id, reason, message }))

  /** A timeout as the device's error says it: `no reply from device 2001 at 10.0.0.5:47808 within 3 s`. */
  const timeoutMessage = (error: BacnetTimeout) =>
    error.peer === undefined || error.within === undefined
      ? error.message
      : `no reply from device ${device.deviceInstance} at ${error.peer} within ${error.within}`

  const cov = device.cov
    ? makeCovSubscriptions({
        client,
        deviceInstance: device.deviceInstance,
        points,
        location: () => location,
        reachable: (now) => lostCycles === 0 && now >= busyUntil,
        timing: { ...defaultCovTiming, ...options.cov }
      })
    : undefined

  /**
   * The points to poll: those no COV subscription keeps up to date. When
   * every point is pushed, the first is still read, so a device that stopped
   * answering is noticed within a cycle, not when its subscriptions lapse;
   * that read only `probes`: its value is not a reading, since the point's
   * notifications already deliver it, and publishing it too would send the
   * point once more every cycle (twice per interval in `sample` mode).
   */
  const toPoll = Effect.gen(function* () {
    // After a timeout the device may have restarted, so what was pushed may be stale: read it all once.
    if (cov === undefined || lostCycles > 0) return { polled: points, pushed: 0, probes: false }
    const pushed = cov.pushedPointIds(yield* monotonicMillis)
    const polled = points.filter((point) => !pushed.has(point.point.id))
    return polled.length === 0
      ? { polled: points.slice(0, 1), pushed: pushed.size, probes: true }
      : { polled, pushed: pushed.size, probes: false }
  })

  const readAll = Effect.gen(function* () {
    const { polled, pushed, probes } = yield* toPoll
    // Before the device is looked for, so the gauge falls to 0 as subscriptions lapse while it is unreachable.
    if (cov !== undefined) yield* Metric.update(pushedPoints, pushed)
    // The pipeline retries a failed cycle at once; a busy device is not asked again until its backoff ends.
    const now = yield* monotonicMillis
    if (now < busyUntil) {
      const waitSeconds = Math.ceil((busyUntil - now) / 1000)
      return yield* fail("protocol", `device is busy (${busyReason ?? "aborted"}); asking again in ${waitSeconds} s`)
    }
    // Taken before `locate`: finding the device again by Who-Is resets `lostCycles`, and it still needs a resync.
    const wasLost = lostCycles > 0
    const locatedBefore = location
    const target = yield* locate
    const { outcomes, requests, shrunk, timedOut, busy } = yield* readPoints(target, polled)
    yield* report(outcomes)
    const readings = outcomes.flatMap((outcome): ReadonlyArray<Reading> =>
      outcome._tag === "Value"
        ? [{ pointId: outcome.point.point.id, value: outcome.value, timestamp: outcome.timestamp }]
        : []
    )
    const failedPoints = outcomes.filter((outcome) => outcome._tag === "Failed").length
    const notReadPoints = outcomes.filter((outcome) => outcome._tag === "NotRead").length
    yield* Effect.annotateCurrentSpan({ "ot_gateway.requests": requests, "ot_gateway.failed_points": failedPoints })
    yield* countPointFailures("refused", failedPoints)
    if (busy === undefined) yield* notBusy
    const waitSeconds = busy === undefined ? 0 : yield* backOff(busy)
    if (polled.length > 0 && readings.length === 0) {
      if (timedOut !== undefined) return yield* timedOut
      if (busy !== undefined) {
        return yield* fail("protocol", `device is busy (${busy.message}); asking again in ${waitSeconds} s`)
      }
    }
    // A device that answered, even with errors, is alive; with points pushed, its polled ones failing is not the device failing.
    if (polled.length > 0 && readings.length === 0 && pushed === 0) {
      const reasons = [...new Set(outcomes.flatMap((outcome) => (outcome._tag === "Failed" ? [outcome.reason] : [])))]
      return yield* fail("protocol", `no point could be read (${reasons.join(", ")})`)
    }
    if (wasLost) {
      cov?.resync()
      // A device found again by Who-Is was already logged as found; one line per recovery.
      if (target === locatedBefore) yield* Effect.log("BACnet device answers again")
    }
    lostCycles = 0
    yield* countPointFailures("not_read", notReadPoints)
    yield* regrow(shrunk || busy !== undefined)
    // The probe answered, so the device is alive; its value came, and comes, by COV.
    return probes ? [] : readings
  }).pipe(
    Effect.catchTags({
      BacnetTimeout: (error) =>
        Effect.suspend(() => {
          lostCycles++
          // Once per outage, for the device; its points are not logged one by one.
          return lostCycles === 1
            ? Effect.logWarning("BACnet device stopped answering").pipe(
                Effect.annotateLogs({ error: timeoutMessage(error) })
              )
            : Effect.void
        }).pipe(Effect.andThen(fail("timeout", timeoutMessage(error)))),
      // An unreadable answer is contained per batch in `readPoints`, so it never gets here.
      BacnetSocketError: (error) => fail("connection", error.message)
    })
  )

  const driver: Driver = {
    deviceId: device.id,
    points: device.points,
    readAll,
    retriesTimeouts: true,
    ...(cov === undefined || cov.objects === 0 ? {} : { changes: cov.changes }),
    write: (pointId, value) =>
      Effect.gen(function* () {
        const resolved = points.find((candidate) => candidate.point.id === pointId)
        if (resolved === undefined) return yield* fail("configuration", `no point ${pointId}`)
        const target = location
        if (target === undefined) return yield* fail("connection", "the device has not been found yet")
        const encoded = writeValueFor(resolved, value)
        if (typeof encoded === "string") return yield* fail("configuration", `${pointId}: ${encoded}`)
        yield* client.writeProperty(target, {
          object: resolved.object,
          property: resolved.property,
          value: encoded,
          priority: resolved.point.priority
        })
      }).pipe(
        Effect.catchTags({
          BacnetDeviceError: (error) => fail("protocol", `device refused the write: ${error.message}`),
          BacnetTimeout: (error) => fail("timeout", timeoutMessage(error)),
          BacnetSocketError: (error) => fail("connection", error.message),
          BacnetCodecError: (error) => fail("invalid-response", error.message),
          BacnetEncodeError: (error) => fail("configuration", error.message)
        })
      )
  }
  return driver
})

const parseSetting = (text: string) =>
  Effect.fromResult(parseDeviceAddress(text)).pipe(Effect.mapError((message) => new BacnetSocketError({ message })))

/**
 * The gateway's BACnet/IP endpoint: one UDP socket on `settings.port` with
 * broadcast enabled, shared by every `bacnet-ip` device. Closed with the scope.
 */
export const makeBacnetNetwork = Effect.fn("makeBacnetNetwork")(function* (
  settings: BacnetSettings,
  /** Bind through this network instead of Node's (a simulation). */
  network?: Pick<Network, "udp">
) {
  const broadcastAddress = yield* parseSetting(settings.broadcastAddress)
  const bbmdAddress = settings.bbmdAddress === undefined ? undefined : yield* parseSetting(settings.bbmdAddress)
  const socket = yield* network
    ? network.udp({ address: settings.bindAddress, port: settings.port })
    : NodeDatagramSocket.make({ bind: { address: settings.bindAddress, port: settings.port }, broadcast: true })
  return yield* makeBacnetClient(socket, {
    broadcastAddress,
    requestTimeout: Duration.millis(settings.requestTimeoutMs),
    retries: settings.retries,
    ...(bbmdAddress === undefined ? {} : { bbmdAddress })
  })
})
