/**
 * A simulated BACnet device, as pure request → response logic. It answers
 * Who-Is, ReadProperty and ReadPropertyMultiple the way a strict device
 * does: unknown objects and properties are errors, malformed requests are
 * rejected, other services are rejected as unrecognized, and an answer
 * larger than the requester accepts is aborted (it never segments).
 *
 * The UDP server that puts it on the network lives with the transport.
 */
import type { BacnetDevice } from "@plenum/core"
import { Result } from "effect"
import { AbortReason, type Apdu, ConfirmedService, encodeApdu, RejectReason, UnconfirmedService } from "./Apdu.ts"
import type { BacnetValue, ObjectId } from "./Encoding.ts"
import { ErrorClass, ErrorCode, ObjectType, type ObjectTypeName, PropertyId, Segmentation } from "./Enums.ts"
import {
  decodeReadProperty,
  decodeReadPropertyMultiple,
  decodeWhoIs,
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

export interface SimulatedDevice {
  readonly instance: number
  readonly vendorId: number
  readonly maxApdu: number
  /** Property values by object (`type:instance`) and property number. */
  readonly objects: Map<string, Map<number, ReadonlyArray<BacnetValue>>>
}

const keyOf = (id: ObjectId) => `${id.objectType}:${id.instance}`

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
  return { instance: config.instance, vendorId, maxApdu, objects }
}

/** Change a property, as a sensor or an operator would. Returns false if the object does not exist. */
export const setProperty = (
  device: SimulatedDevice,
  object: { readonly objectType: ObjectTypeName | number; readonly instance: number },
  property: number,
  value: BacnetValue
): boolean => {
  const objectType = typeof object.objectType === "number" ? object.objectType : ObjectType[object.objectType]
  const properties = device.objects.get(keyOf({ objectType, instance: object.instance }))
  if (properties === undefined) return false
  properties.set(property, [value])
  return true
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

export const answer = (device: SimulatedDevice, request: Apdu): Apdu | undefined => {
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
