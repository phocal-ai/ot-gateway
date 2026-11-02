/**
 * The BACnet/IP driver: finds its device with Who-Is, then reads every point
 * with ReadPropertyMultiple, falling back to ReadProperty for devices that do
 * not support it.
 *
 * - **Batches** are sized from the largest APDU the device accepts (from its
 *   I-Am). A device that still aborts an answer as too large gets half the
 *   batch, and keeps that size.
 * - **One point** the device cannot read (unknown object or property, a value
 *   that is not a number or boolean) costs only that point. It is logged when
 *   it starts failing and when it recovers, not every cycle. The read fails
 *   when no point could be read.
 * - **A timeout** forgets where the device is, so the next read looks it up
 *   again, in case it moved to another address.
 *
 * Binary objects' present values (`inactive`/`active`) are published as
 * booleans; every other numeric value as a number.
 */
import { NodeDatagramSocket } from "@effect/platform-node"
import { type BacnetDevice, type BacnetSettings, DriverError, pointReadFailures } from "@plenum/core"
import type { BacnetPoint, Driver, PointValue, Reading } from "@plenum/core"
import { Clock, Duration, Effect, Metric, Result } from "effect"
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
import type { PropertyResult, ReadAccessSpecification } from "./Services.ts"

/** The BACnet/IP port, `0xBAC0` (Annex J.1). */
export const BACNET_PORT = 47_808

/** A configured point with its object and property resolved to numbers. */
interface ResolvedPoint {
  readonly point: BacnetPoint
  readonly object: ObjectId
  readonly property: number
  /** Publish the value as a boolean (a binary object's present value). */
  readonly binary: boolean
}

const binaryTypes = new Set<number>([
  ObjectType["binary-input"],
  ObjectType["binary-output"],
  ObjectType["binary-value"]
])

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
    binary: binaryTypes.has(objectType) && property === PropertyId["present-value"]
  })
}

/** A device address from config: `host` or `host:port`, port 47808 by default. */
export const parseDeviceAddress = (text: string): Result.Result<NetAddress.InetAddress, string> => {
  const [host = "", port] = text.split(":")
  const address = NetAddress.inetAddressFromIpString(host, port === undefined ? BACNET_PORT : Number(port))
  return Result.mapError(address, () => `invalid address "${text}"`)
}

/** The point's value from the property's values, or why it has none Plenum can publish. */
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

/** The answer did not fit: the device would have had to segment it, or ran out of room. */
const tooLarge = (error: BacnetDeviceError) =>
  (error.kind === "abort" &&
    (error.code === AbortReason.SegmentationNotSupported ||
      error.code === AbortReason.BufferOverflow ||
      error.code === AbortReason.OutOfResources ||
      error.code === AbortReason.ApduTooLong)) ||
  (error.kind === "reject" && error.code === RejectReason.BufferOverflow)

/** The device does not implement ReadPropertyMultiple. */
const unsupported = (error: BacnetDeviceError) =>
  error.kind === "reject" && error.code === RejectReason.UnrecognizedService

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
  | { readonly _tag: "Failed"; readonly point: ResolvedPoint; readonly reason: string }

const failed = (points: ReadonlyArray<ResolvedPoint>, reason: string): ReadonlyArray<PointOutcome> =>
  points.map((point) => ({ _tag: "Failed", point, reason }))

/** Where the device is, and the largest APDU it takes. */
interface Location extends DeviceAddress {
  readonly maxApdu: number
}

export interface BacnetDriverOptions {
  /** Start with this many properties per ReadPropertyMultiple instead of sizing them from the device's I-Am. */
  readonly batchSize?: number
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
  let cleanCycles = 0
  let lostCycles = 0
  let nextBroadcastAt = 0
  let broadcastBackoffMs = LOCATE_BACKOFF.firstMs
  /** Points that failed last time, with the reason, so each change is logged once. */
  const failing = new Map<string, string>()

  const remember = (found: Location, how: string) =>
    Effect.suspend(() => {
      location = found
      largestBatch = options.batchSize ?? batchSizeFor(found.maxApdu)
      batchSize = largestBatch
      multiple = true
      cleanCycles = 0
      lostCycles = 0
      broadcastBackoffMs = LOCATE_BACKOFF.firstMs
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
    const now = yield* Clock.currentTimeMillis
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
   * Where to send requests. A fixed address is asked once for the device's
   * APDU size and used whether or not it answers Who-Is (an I-Am broadcast on
   * another subnet never arrives). Otherwise the device is found by
   * broadcast, and looked for again only after several cycles timed out.
   */
  const locate: Effect.Effect<Location, BacnetTimeout | BacnetSocketError> = Effect.gen(function* () {
    if (fixedAddress !== undefined) {
      if (location !== undefined) return location
      const target = { address: fixedAddress }
      const found = yield* client
        .locate(device.deviceInstance, { target })
        .pipe(Effect.catchTag("BacnetTimeout", () => Effect.succeed(null)))
      const located: Location = found ?? { ...target, maxApdu: ASSUMED_MAX_APDU }
      yield* remember(
        located,
        found === null ? "BACnet device did not answer Who-Is, reading it at its address" : "found BACnet device"
      )
      return located
    }
    if (location === undefined || lostCycles >= LOST_AFTER_CYCLES) {
      const found = yield* broadcastLocate
      if (found !== undefined) {
        const moved =
          location !== undefined && NetAddress.formatInet(location.address) !== NetAddress.formatInet(found.address)
        yield* remember(found, moved ? "BACnet device moved" : "found BACnet device")
      }
    }
    if (location !== undefined) return location
    const waitSeconds = Math.ceil(Math.max(0, nextBroadcastAt - (yield* Clock.currentTimeMillis)) / 1000)
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

  /** The outcome of reading one point with ReadProperty; only an unreachable device fails. */
  const readOne = (target: DeviceAddress, point: ResolvedPoint) =>
    client.readProperty(target, { object: point.object, property: point.property }).pipe(
      Effect.flatMap((values) =>
        Effect.map(Clock.currentTimeMillis, (timestamp) =>
          outcomeOf(point, { property: point.property, _tag: "Value", values }, timestamp)
        )
      ),
      Effect.catchTags({
        BacnetDeviceError: (error) => Effect.succeed<PointOutcome>({ _tag: "Failed", point, reason: error.message }),
        BacnetCodecError: (error) => Effect.succeed<PointOutcome>({ _tag: "Failed", point, reason: error.message })
      })
    )

  /** Read every point, in batches with ReadPropertyMultiple while the device supports it. */
  const readPoints = Effect.fnUntraced(function* (target: DeviceAddress) {
    const outcomes: Array<PointOutcome> = []
    let requests = 0
    let index = 0
    let shrunk = false
    // A holder, because it is set inside callbacks, which control-flow narrowing does not see.
    const stop: { timedOut?: BacnetTimeout } = {}
    /** Read `batch` one point at a time, stopping at the first timeout. */
    const readEach = Effect.fnUntraced(function* (batch: ReadonlyArray<ResolvedPoint>) {
      for (const [position, point] of batch.entries()) {
        requests++
        const outcome = yield* readOne(target, point).pipe(
          Effect.catchTag("BacnetTimeout", (error) =>
            Effect.sync((): PointOutcome | null => {
              stop.timedOut = error
              return null
            })
          )
        )
        if (outcome === null) {
          outcomes.push(...failed(batch.slice(position), "no answer"))
          return
        }
        outcomes.push(outcome)
      }
    })
    while (index < points.length && stop.timedOut === undefined) {
      if (!multiple) {
        yield* readEach(points.slice(index))
        break
      }
      const batch = points.slice(index, index + batchSize)
      requests++
      const answer = yield* client.readPropertyMultiple(target, specificationsOf(batch)).pipe(
        Effect.map((results) => ({ _tag: "Results" as const, results })),
        Effect.catchTags({
          BacnetDeviceError: (error) => Effect.succeed({ _tag: "Refused" as const, error }),
          BacnetCodecError: (error) => Effect.succeed({ _tag: "Unreadable" as const, error }),
          BacnetTimeout: (error) => Effect.succeed({ _tag: "TimedOut" as const, error })
        })
      )
      switch (answer._tag) {
        case "TimedOut":
          stop.timedOut = answer.error
          outcomes.push(...failed(points.slice(index), "no answer"))
          index = points.length
          continue
        case "Unreadable":
          // One value the codec cannot read must not cost the others: read them one by one.
          if (batch.length > 1) yield* readEach(batch)
          else outcomes.push(...failed(batch, answer.error.message))
          index += batch.length
          continue
        case "Refused": {
          const { error } = answer
          if (unsupported(error)) {
            multiple = false
            yield* Effect.log("device does not support ReadPropertyMultiple, reading points one at a time")
            continue
          }
          if (tooLarge(error) && batch.length === batchSize && batchSize > 1) {
            batchSize = Math.max(1, Math.floor(batchSize / 2))
            shrunk = true
            yield* Effect.log("answer too large for the device, reading fewer points per request").pipe(
              Effect.annotateLogs({ batchSize })
            )
            continue
          }
          // A short last batch that is too large, or an error for the whole request
          // (some devices answer that way when one object is missing): find out point by point.
          if (batch.length > 1) yield* readEach(batch)
          else outcomes.push(...failed(batch, error.message))
          index += batch.length
          continue
        }
        case "Results": {
          const timestamp = yield* Clock.currentTimeMillis
          const byKey = new Map<string, PropertyResult>()
          for (const result of answer.results) {
            for (const item of result.results) byKey.set(keyOf(result.object, item.property, item.arrayIndex), item)
          }
          outcomes.push(
            ...batch.map((point) => outcomeOf(point, byKey.get(keyOf(point.object, point.property)), timestamp))
          )
          index += batch.length
          continue
        }
      }
    }
    return { outcomes, requests, shrunk, timedOut: stop.timedOut }
  })

  /** After enough clean cycles, try a batch twice as large again, up to what the device allows. */
  const regrow = (shrunk: boolean) =>
    Effect.suspend(() => {
      if (shrunk || !multiple || batchSize >= largestBatch) {
        cleanCycles = 0
        return Effect.void
      }
      cleanCycles++
      if (cleanCycles < REGROW_AFTER_CYCLES) return Effect.void
      cleanCycles = 0
      batchSize = Math.min(largestBatch, batchSize * 2)
      return Effect.log("trying more points per request again").pipe(Effect.annotateLogs({ batchSize }))
    })

  /** Log a point that starts failing, fails differently, or recovers. */
  const report = (outcomes: ReadonlyArray<PointOutcome>) =>
    Effect.forEach(
      outcomes,
      (outcome) => {
        const id = outcome.point.point.id
        const before = failing.get(id)
        if (outcome._tag === "Value") {
          if (before === undefined) return Effect.void
          failing.delete(id)
          return Effect.log("point readable again").pipe(Effect.annotateLogs({ point: id }))
        }
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
      },
      { discard: true }
    )

  const fail = (reason: DriverError["reason"], message: string) =>
    Effect.fail(new DriverError({ device: device.id, reason, message }))

  const readAll = Effect.gen(function* () {
    const target = yield* locate
    const { outcomes, requests, shrunk, timedOut } = yield* readPoints(target)
    yield* report(outcomes)
    const readings = outcomes.flatMap((outcome): ReadonlyArray<Reading> =>
      outcome._tag === "Value"
        ? [{ pointId: outcome.point.point.id, value: outcome.value, timestamp: outcome.timestamp }]
        : []
    )
    const failedPoints = outcomes.length - readings.length
    yield* Effect.annotateCurrentSpan({ "plenum.requests": requests, "plenum.failed_points": failedPoints })
    if (points.length > 0 && readings.length === 0) {
      if (timedOut !== undefined) return yield* timedOut
      const reasons = [...new Set(outcomes.flatMap((outcome) => (outcome._tag === "Failed" ? [outcome.reason] : [])))]
      return yield* new DriverError({
        device: device.id,
        reason: "protocol",
        message: `no point could be read (${reasons.join(", ")})`
      })
    }
    lostCycles = 0
    if (failedPoints > 0) yield* Metric.update(pointReadFailures, failedPoints)
    yield* regrow(shrunk)
    return readings
  }).pipe(
    Effect.catchTags({
      BacnetTimeout: (error) =>
        Effect.sync(() => {
          lostCycles++
        }).pipe(Effect.andThen(fail("timeout", error.message))),
      // An unreadable answer is contained per batch in `readPoints`, so it never gets here.
      BacnetSocketError: (error) => fail("connection", error.message)
    })
  )

  const driver: Driver = {
    deviceId: device.id,
    points: device.points,
    readAll,
    retriesTimeouts: true,
    // Write-back is v0.4 (docs/VISION.md): it lands with the command guard, not before.
    write: (pointId) => fail("not-implemented", `writing ${pointId} is not supported yet`)
  }
  return driver
})

/**
 * The gateway's BACnet/IP endpoint: one UDP socket on `settings.port` with
 * broadcast enabled, shared by every `bacnet-ip` device. Closed with the scope.
 */
export const makeBacnetNetwork = Effect.fn("makeBacnetNetwork")(function* (settings: BacnetSettings) {
  const broadcastAddress = yield* Effect.fromResult(parseDeviceAddress(settings.broadcastAddress)).pipe(
    Effect.mapError((message) => new BacnetSocketError({ message }))
  )
  const socket = yield* NodeDatagramSocket.make({
    bind: { address: settings.bindAddress, port: settings.port },
    broadcast: true
  })
  return yield* makeBacnetClient(socket, {
    broadcastAddress,
    requestTimeout: Duration.millis(settings.requestTimeoutMs),
    retries: settings.retries
  })
})
