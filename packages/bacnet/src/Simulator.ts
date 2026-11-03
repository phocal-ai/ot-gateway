/**
 * A simulated BACnet device, as pure request → response logic. It answers
 * Who-Is, ReadProperty and ReadPropertyMultiple the way a strict device
 * does: unknown objects and properties are errors, malformed requests are
 * rejected, other services are rejected as unrecognized, and an answer
 * larger than the requester accepts is aborted (it never segments).
 *
 * SubscribeCOV is supported for objects with a present value, with
 * unconfirmed notifications only. The device keeps the subscriptions;
 * `covNotifications` says who to notify when an object changed, and
 * `onChange` listeners hear about every change.
 *
 * The UDP server that puts it on the network lives with the transport.
 */
import type { BacnetDevice } from "@plenum/core"
import { Result } from "effect"
import { AbortReason, type Apdu, ConfirmedService, encodeApdu, RejectReason, UnconfirmedService } from "./Apdu.ts"
import type { BacnetValue, ObjectId } from "./Encoding.ts"
import { ErrorClass, ErrorCode, ObjectType, type ObjectTypeName, PropertyId, Segmentation } from "./Enums.ts"
import {
  type CovNotification,
  decodeReadProperty,
  decodeReadPropertyMultiple,
  decodeSubscribeCov,
  decodeWhoIs,
  encodeCovNotification,
  encodeErrorBody,
  encodeIAm,
  encodeReadPropertyAck,
  encodeReadPropertyMultipleAck,
  type PropertyReference,
  type PropertyResult,
  type ReadAccessResult,
  whoIsMatches
} from "./Services.ts"

export interface SimulatedObjectConfig {
  readonly objectType: ObjectTypeName
  readonly instance: number
  readonly name: string
  readonly presentValue: BacnetValue
  /** BACnetEngineeringUnits, for analog objects (e.g. 62 = degrees Celsius). */
  readonly units?: number
}

export interface SimulatedDeviceConfig {
  readonly instance: number
  readonly name: string
  /** Default 0 (ASHRAE). */
  readonly vendorId?: number
  /** Largest APDU the device accepts and sends (default 1476). */
  readonly maxApdu?: number
  readonly objects: ReadonlyArray<SimulatedObjectConfig>
}

/** A COV subscription a simulated device holds (clause 13.14). */
export interface CovSubscription {
  /** Who subscribed, as the server identifies requesters (e.g. their address). */
  readonly subscriber: string
  readonly processId: number
  readonly object: ObjectId
  /** When it ends, in epoch milliseconds; absent for an indefinite one. */
  readonly expiresAt?: number
}

export interface SimulatedDevice {
  readonly instance: number
  readonly vendorId: number
  readonly maxApdu: number
  /** Property values by object (`type:instance`) and property number. */
  readonly objects: Map<string, Map<number, ReadonlyArray<BacnetValue>>>
  /** By subscriber, process and object: a new subscription for the same three replaces the old one. */
  readonly subscriptions: Map<string, CovSubscription>
  /** Called with the object whenever its present value or status flags change. */
  readonly onChange: Set<(object: ObjectId) => void>
}

/** Who sent a request, and when, for the services that remember the requester. */
export interface Requester {
  readonly subscriber: string
  /** Epoch milliseconds. */
  readonly now: number
}

const keyOf = (id: ObjectId) => `${id.objectType}:${id.instance}`

const subscriptionKey = (subscriber: string, processId: number, object: ObjectId) =>
  `${subscriber}|${processId}|${keyOf(object)}`

/** Properties whose change is reported to COV subscribers (clause 13.1, Table 13-1). */
const covProperties = [PropertyId["present-value"], PropertyId["status-flags"]] as const

/** Device instance 4,194,303 in a request means "this device", whatever its instance (clause 15.5.1.1.1). */
const WILDCARD_INSTANCE = 4_194_303

/** Objects whose present value is commanded through a priority array (clause 19.2); outputs must be. */
const commandable = new Set<ObjectTypeName>(["analog-output", "binary-output", "multi-state-output"])

/** A single-valued property. */
const one = (value: BacnetValue): ReadonlyArray<BacnetValue> => [value]

/** Properties that are arrays (clause 12): an index reads one element, index 0 the length. */
const arrayProperties = new Set<number>([
  PropertyId["object-list"],
  PropertyId["priority-array"],
  PropertyId["state-text"]
])

export const makeSimulatedDevice = (config: SimulatedDeviceConfig): SimulatedDevice => {
  const vendorId = config.vendorId ?? 0
  const maxApdu = config.maxApdu ?? 1476
  const deviceId: ObjectId = { objectType: ObjectType.device, instance: config.instance }
  const objectIds = config.objects.map((object) => ({
    objectType: ObjectType[object.objectType],
    instance: object.instance
  }))
  const objects = new Map<string, Map<number, ReadonlyArray<BacnetValue>>>()

  objects.set(
    keyOf(deviceId),
    new Map([
      [PropertyId["object-identifier"], one({ type: "object-identifier", value: deviceId })],
      [PropertyId["object-name"], one({ type: "character-string", value: config.name })],
      [PropertyId["object-type"], one({ type: "enumerated", value: ObjectType.device })],
      [PropertyId["system-status"], one({ type: "enumerated", value: 0 })],
      [PropertyId["vendor-name"], one({ type: "character-string", value: "Plenum simulator" })],
      [PropertyId["vendor-identifier"], one({ type: "unsigned", value: vendorId })],
      [PropertyId["model-name"], one({ type: "character-string", value: "simulated device" })],
      [PropertyId["protocol-version"], one({ type: "unsigned", value: 1 })],
      [PropertyId["protocol-revision"], one({ type: "unsigned", value: 14 })],
      [PropertyId["max-apdu-length-accepted"], one({ type: "unsigned", value: maxApdu })],
      [PropertyId["segmentation-supported"], one({ type: "enumerated", value: Segmentation["no-segmentation"] })],
      [
        PropertyId["object-list"],
        [deviceId, ...objectIds].map((value): BacnetValue => ({ type: "object-identifier", value }))
      ]
    ])
  )
  config.objects.forEach((object, index) => {
    const id = objectIds[index] ?? deviceId
    const properties = new Map<number, ReadonlyArray<BacnetValue>>([
      [PropertyId["object-identifier"], one({ type: "object-identifier", value: id })],
      [PropertyId["object-name"], one({ type: "character-string", value: object.name })],
      [PropertyId["object-type"], one({ type: "enumerated", value: id.objectType })],
      [PropertyId["present-value"], one(object.presentValue)],
      [PropertyId["status-flags"], one({ type: "bit-string", value: [false, false, false, false] })],
      [PropertyId["event-state"], one({ type: "enumerated", value: 0 })],
      [PropertyId["out-of-service"], one({ type: "boolean", value: false })]
    ])
    if (object.units !== undefined) properties.set(PropertyId.units, one({ type: "enumerated", value: object.units }))
    if (commandable.has(object.objectType)) {
      properties.set(
        PropertyId["priority-array"],
        Array.from({ length: 16 }, (): BacnetValue => ({ type: "null" }))
      )
      properties.set(PropertyId["relinquish-default"], one(object.presentValue))
    }
    objects.set(keyOf(id), properties)
  })
  return { instance: config.instance, vendorId, maxApdu, objects, subscriptions: new Map(), onChange: new Set() }
}

/** Change a property, as a sensor or an operator would. Returns false if the object does not exist. */
export const setProperty = (
  device: SimulatedDevice,
  object: { readonly objectType: ObjectTypeName | number; readonly instance: number },
  property: number,
  value: BacnetValue
): boolean => {
  const objectType = typeof object.objectType === "number" ? object.objectType : ObjectType[object.objectType]
  const id = { objectType, instance: object.instance }
  const properties = device.objects.get(keyOf(id))
  if (properties === undefined) return false
  const before = properties.get(property)
  properties.set(property, [value])
  const changed = before === undefined || before.length !== 1 || !sameValue(before[0], value)
  if (changed && covProperties.some((covProperty) => covProperty === property)) {
    for (const listener of device.onChange) listener(id)
  }
  return true
}

const sameValue = (left: BacnetValue | undefined, right: BacnetValue) =>
  left !== undefined && JSON.stringify(left) === JSON.stringify(right)

/**
 * The notifications `object` causes now: one UnconfirmedCOVNotification per
 * live subscription to it (only `subscriber`'s, if given), with its present
 * value and status flags. Expired subscriptions are dropped on the way.
 */
export const covNotifications = (
  device: SimulatedDevice,
  object: ObjectId,
  now: number,
  subscriber?: string
): ReadonlyArray<{ readonly subscriber: string; readonly apdu: Apdu }> => {
  const properties = device.objects.get(keyOf(object))
  if (properties === undefined) return []
  const notifications: Array<{ readonly subscriber: string; readonly apdu: Apdu }> = []
  for (const [key, subscription] of device.subscriptions) {
    if (subscription.expiresAt !== undefined && subscription.expiresAt <= now) {
      device.subscriptions.delete(key)
      continue
    }
    if (keyOf(subscription.object) !== keyOf(object)) continue
    if (subscriber !== undefined && subscription.subscriber !== subscriber) continue
    const notification: CovNotification = {
      processId: subscription.processId,
      initiatingDevice: { objectType: ObjectType.device, instance: device.instance },
      object,
      timeRemaining:
        subscription.expiresAt === undefined ? 0 : Math.max(1, Math.ceil((subscription.expiresAt - now) / 1000)),
      values: covProperties.map((property) => ({ property, values: properties.get(property) ?? [] }))
    }
    notifications.push({
      subscriber: subscription.subscriber,
      apdu: {
        _tag: "UnconfirmedRequest",
        service: UnconfirmedService.UnconfirmedCovNotification,
        body: encodeCovNotification(notification)
      }
    })
  }
  return notifications
}

/** Change an object's present value. */
export const setPresentValue = (
  device: SimulatedDevice,
  object: { readonly objectType: ObjectTypeName | number; readonly instance: number },
  value: BacnetValue
) => setProperty(device, object, PropertyId["present-value"], value)

const propertyError = (errorCode: number) => ({
  _tag: "Error" as const,
  errorClass: errorCode === ErrorCode["unknown-object"] ? ErrorClass.object : ErrorClass.property,
  errorCode
})

/** Read one property reference of one object, as a ReadPropertyMultiple result. */
const readOne = (device: SimulatedDevice, object: ObjectId, reference: PropertyReference): PropertyResult => {
  const properties = device.objects.get(keyOf(object))
  if (properties === undefined) return { ...reference, ...propertyError(ErrorCode["unknown-object"]) }
  const values = properties.get(reference.property)
  if (values === undefined) return { ...reference, ...propertyError(ErrorCode["unknown-property"]) }
  if (reference.arrayIndex === undefined) return { ...reference, _tag: "Value", values }
  if (!arrayProperties.has(reference.property)) {
    return { ...reference, ...propertyError(ErrorCode["property-is-not-an-array"]) }
  }
  if (reference.arrayIndex === 0)
    return { ...reference, _tag: "Value", values: [{ type: "unsigned", value: values.length }] }
  const element = values[reference.arrayIndex - 1]
  return element === undefined
    ? { ...reference, ...propertyError(ErrorCode["invalid-array-index"]) }
    : { ...reference, _tag: "Value", values: [element] }
}

/** `all` and `required` expand to every property the object has (clause 15.7.3.1.2). */
const expand = (
  device: SimulatedDevice,
  object: ObjectId,
  reference: PropertyReference
): ReadonlyArray<PropertyReference> => {
  if (reference.property !== PropertyId.all && reference.property !== PropertyId.required) return [reference]
  const properties = device.objects.get(keyOf(object))
  return properties === undefined ? [reference] : [...properties.keys()].map((property) => ({ property }))
}

/**
 * The device's answer to `request`, or `undefined` when it stays silent
 * (an unconfirmed request it does not act on, or anything that is not a
 * request).
 */
const resolveWildcard = (device: SimulatedDevice, object: ObjectId): ObjectId =>
  object.objectType === ObjectType.device && object.instance === WILDCARD_INSTANCE
    ? { objectType: ObjectType.device, instance: device.instance }
    : object

export const answer = (
  device: SimulatedDevice,
  request: Apdu,
  requester: Requester = { subscriber: "", now: 0 }
): Apdu | undefined => {
  if (request._tag === "UnconfirmedRequest") {
    if (request.service !== UnconfirmedService.WhoIs) return undefined
    const whoIs = decodeWhoIs(request.body)
    if (Result.isFailure(whoIs) || !whoIsMatches(whoIs.success, device.instance)) return undefined
    return {
      _tag: "UnconfirmedRequest",
      service: UnconfirmedService.IAm,
      body: encodeIAm({
        device: { objectType: ObjectType.device, instance: device.instance },
        maxApdu: device.maxApdu,
        segmentation: Segmentation["no-segmentation"],
        vendorId: device.vendorId
      })
    }
  }
  if (request._tag !== "ConfirmedRequest") return undefined
  const { invokeId, service } = request
  const reject = (reason: number): Apdu => ({ _tag: "Reject", invokeId, reason })
  const ack = (body: Uint8Array): Apdu => {
    const response: Apdu = { _tag: "ComplexAck", invokeId, service, body }
    // Never segments: an answer that does not fit what either side accepts is aborted (clause 20.1.2.5).
    return encodeApdu(response).length > Math.min(request.maxApdu, device.maxApdu)
      ? { _tag: "Abort", invokeId, reason: AbortReason.SegmentationNotSupported, fromServer: true }
      : response
  }

  switch (service) {
    case ConfirmedService.ReadProperty: {
      const decoded = decodeReadProperty(request.body)
      if (Result.isFailure(decoded)) return reject(RejectReason.InvalidTag)
      const { object: requested, ...reference } = decoded.success
      const object = resolveWildcard(device, requested)
      const result = readOne(device, object, reference)
      if (result._tag === "Error") {
        return {
          _tag: "Error",
          invokeId,
          service,
          body: encodeErrorBody({ errorClass: result.errorClass, errorCode: result.errorCode })
        }
      }
      return ack(encodeReadPropertyAck({ object, ...reference, values: result.values }))
    }
    case ConfirmedService.ReadPropertyMultiple: {
      const decoded = decodeReadPropertyMultiple(request.body)
      if (Result.isFailure(decoded)) return reject(RejectReason.InvalidTag)
      const results: Array<ReadAccessResult> = decoded.success.map((specification) => {
        const object = resolveWildcard(device, specification.object)
        return {
          object,
          results: specification.properties
            .flatMap((reference) => expand(device, object, reference))
            .map((reference) => readOne(device, object, reference))
        }
      })
      return ack(encodeReadPropertyMultipleAck(results))
    }
    case ConfirmedService.SubscribeCov: {
      const decoded = decodeSubscribeCov(request.body)
      if (Result.isFailure(decoded)) return reject(RejectReason.InvalidTag)
      const subscription = decoded.success
      const error = (errorClass: number, errorCode: number): Apdu => ({
        _tag: "Error",
        invokeId,
        service,
        body: encodeErrorBody({ errorClass, errorCode })
      })
      const properties = device.objects.get(keyOf(subscription.object))
      if (properties === undefined) return error(ErrorClass.object, ErrorCode["unknown-object"])
      if (!properties.has(PropertyId["present-value"])) {
        return error(ErrorClass.object, ErrorCode["optional-functionality-not-supported"])
      }
      const key = subscriptionKey(requester.subscriber, subscription.processId, subscription.object)
      if (subscription.confirmed === undefined && subscription.lifetime === undefined) {
        // A cancellation; one for a subscription that does not exist succeeds too (clause 13.14.2).
        device.subscriptions.delete(key)
      } else if (subscription.confirmed === true) {
        return error(ErrorClass.services, ErrorCode["optional-functionality-not-supported"])
      } else {
        const lifetime = subscription.lifetime ?? 0
        device.subscriptions.set(key, {
          subscriber: requester.subscriber,
          processId: subscription.processId,
          object: subscription.object,
          ...(lifetime === 0 ? {} : { expiresAt: requester.now + lifetime * 1000 })
        })
      }
      return { _tag: "SimpleAck", invokeId, service }
    }
    default:
      return reject(RejectReason.UnrecognizedService)
  }
}

const binaryObjectTypes = new Set<string>(["binary-input", "binary-output", "binary-value"])

const isObjectTypeName = (name: string): name is ObjectTypeName => Object.hasOwn(ObjectType, name)

/**
 * A simulated device with an object for every point of `device` (named
 * object types only; proprietary numeric ones are left out). Binary objects
 * start `inactive`, everything else at 0.
 */
export const simulatedDeviceFor = (device: BacnetDevice): SimulatedDevice => {
  const objects = new Map<string, SimulatedObjectConfig>()
  for (const point of device.points) {
    const objectType = point.objectType
    if (!isObjectTypeName(objectType)) continue
    objects.set(`${objectType}:${point.instance}`, {
      objectType,
      instance: point.instance,
      name: point.name,
      presentValue: binaryObjectTypes.has(objectType) ? { type: "enumerated", value: 0 } : { type: "real", value: 0 }
    })
  }
  return makeSimulatedDevice({ instance: device.deviceInstance, name: device.id, objects: [...objects.values()] })
}
