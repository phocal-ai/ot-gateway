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
import { type BacnetDevice, type BacnetSettings, DriverError } from "@plenum/core"
import type { BacnetPoint, Driver, PointValue, Reading } from "@plenum/core"
import { Clock, Duration, Effect, Result } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import { AbortReason, RejectReason } from "./Apdu.ts"
import {
  type BacnetClient,
  type BacnetDeviceError,
  BacnetSocketError,
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
 * Properties per ReadPropertyMultiple so the answer fits in `maxApdu` bytes:
 * the worst case per point is its object identifier (5), the list tags (2),
 * the property identifier (3), the value tags (2) and a double (9).
 */
export const batchSizeFor = (maxApdu: number) => Math.max(1, Math.floor((maxApdu - 3) / 21))

/** The answer did not fit: the device would have had to segment it. */
const tooLarge = (error: BacnetDeviceError) =>
  (error.kind === "abort" &&
    (error.code === AbortReason.SegmentationNotSupported || error.code === AbortReason.BufferOverflow)) ||
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
  const fixedAddress = device.address === undefined ? undefined : parseDeviceAddress(device.address)
  if (fixedAddress !== undefined && Result.isFailure(fixedAddress))
    return yield* configurationError(fixedAddress.failure)

  let location: (DeviceAddress & { readonly maxApdu: number }) | undefined
  let batchSize = options.batchSize
  let multiple = true
  /** Points that failed last time, with the reason, so each change is logged once. */
  const failing = new Map<string, string>()

  const locate = Effect.suspend(() => {
    if (location !== undefined) return Effect.succeed(location)
    const target = fixedAddress === undefined ? {} : { target: { address: fixedAddress.success } }
    return client.locate(device.deviceInstance, target).pipe(
      Effect.tap((found) => {
        location = found
        batchSize ??= batchSizeFor(found.maxApdu)
        return Effect.log("found BACnet device").pipe(
          Effect.annotateLogs({
            instance: found.instance,
            address: NetAddress.formatInet(found.address),
            maxApdu: found.maxApdu,
            ...(found.network === undefined ? {} : { network: found.network.network })
          })
        )
      })
    )
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

  /** Read points one at a time with ReadProperty. */
  const readEach = (target: DeviceAddress, batch: ReadonlyArray<ResolvedPoint>) =>
    Effect.forEach(batch, (point) =>
      client.readProperty(target, { object: point.object, property: point.property }).pipe(
        Effect.flatMap((values) =>
          Effect.map(Clock.currentTimeMillis, (timestamp) =>
            outcomeOf(point, { property: point.property, _tag: "Value", values }, timestamp)
          )
        ),
        Effect.catchTag("BacnetDeviceError", (error) =>
          Effect.succeed<PointOutcome>({ _tag: "Failed", point, reason: error.message })
        )
      )
    )

  /** Read every point, in batches with ReadPropertyMultiple while the device supports it. */
  const readPoints = Effect.fnUntraced(function* (target: DeviceAddress) {
    const outcomes: Array<PointOutcome> = []
    let requests = 0
    let index = 0
    while (index < points.length) {
      if (!multiple) {
        requests += points.length - index
        outcomes.push(...(yield* readEach(target, points.slice(index))))
        break
      }
      const batch = points.slice(index, index + (batchSize ?? 1))
      requests++
      const answer = yield* client.readPropertyMultiple(target, specificationsOf(batch)).pipe(
        Effect.map((results) => ({ _tag: "Results" as const, results })),
        Effect.catchTag("BacnetDeviceError", (error) => Effect.succeed({ _tag: "Refused" as const, error }))
      )
      if (answer._tag === "Refused") {
        const { error } = answer
        if (tooLarge(error) && batch.length > 1) {
          batchSize = Math.max(1, Math.floor(batch.length / 2))
          yield* Effect.log("answer too large for the device, reading fewer points per request").pipe(
            Effect.annotateLogs({ batchSize })
          )
          continue
        }
        if (unsupported(error)) {
          multiple = false
          yield* Effect.log("device does not support ReadPropertyMultiple, reading points one at a time")
          continue
        }
        outcomes.push(...batch.map((point): PointOutcome => ({ _tag: "Failed", point, reason: error.message })))
        index += batch.length
        continue
      }
      const timestamp = yield* Clock.currentTimeMillis
      const byKey = new Map<string, PropertyResult>()
      for (const result of answer.results) {
        for (const item of result.results) byKey.set(keyOf(result.object, item.property, item.arrayIndex), item)
      }
      outcomes.push(
        ...batch.map((point) => outcomeOf(point, byKey.get(keyOf(point.object, point.property)), timestamp))
      )
      index += batch.length
    }
    return { outcomes, requests }
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
    const { outcomes, requests } = yield* readPoints(target)
    yield* report(outcomes)
    const readings = outcomes.flatMap((outcome): ReadonlyArray<Reading> =>
      outcome._tag === "Value"
        ? [{ pointId: outcome.point.point.id, value: outcome.value, timestamp: outcome.timestamp }]
        : []
    )
    const refused = outcomes.length - readings.length
    yield* Effect.annotateCurrentSpan({ "plenum.requests": requests, "plenum.refused": refused })
    if (points.length > 0 && readings.length === 0) {
      const reasons = [...new Set(outcomes.flatMap((outcome) => (outcome._tag === "Failed" ? [outcome.reason] : [])))]
      return yield* new DriverError({
        device: device.id,
        reason: "protocol",
        message: `no point could be read (${reasons.join(", ")})`
      })
    }
    return readings
  }).pipe(
    Effect.catchTags({
      BacnetTimeout: (error) =>
        Effect.sync(() => {
          location = undefined
        }).pipe(Effect.andThen(fail("timeout", error.message))),
      BacnetSocketError: (error) => fail("connection", error.message),
      BacnetCodecError: (error) => fail("invalid-response", error.message)
    })
  )

  const driver: Driver = {
    deviceId: device.id,
    points: device.points,
    readAll,
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
  const broadcastAddress = yield* Effect.fromResult(
    NetAddress.inetAddressFromIpString(settings.broadcastAddress, settings.port)
  ).pipe(Effect.mapError((error) => new BacnetSocketError({ message: error.message })))
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
