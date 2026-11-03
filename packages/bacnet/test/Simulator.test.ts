/**
 * The simulated device answers like a strict one: errors for unknown objects
 * and properties, rejects for malformed or unknown requests, and an abort
 * when an answer would need segmentation.
 */
import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import {
  AbortReason,
  type Apdu,
  answer,
  ConfirmedService,
  decodeErrorBody,
  decodeIAm,
  decodeReadPropertyAck,
  decodeReadPropertyMultipleAck,
  encodeReadProperty,
  encodeReadPropertyMultiple,
  encodeWhoIs,
  ErrorClass,
  ErrorCode,
  makeSimulatedDevice,
  ObjectType,
  PropertyId,
  type ReadAccessResult,
  RejectReason,
  setPresentValue,
  UnconfirmedService
} from "../src/index.ts"

const makeDevice = (maxApdu?: number) =>
  makeSimulatedDevice({
    instance: 1001,
    name: "ahu-1",
    vendorId: 260,
    ...(maxApdu === undefined ? {} : { maxApdu }),
    objects: [
      {
        objectType: "analog-input",
        instance: 1,
        name: "supply-temp",
        presentValue: { type: "real", value: 18.5 },
        units: 62
      },
      { objectType: "binary-output", instance: 2, name: "fan", presentValue: { type: "enumerated", value: 1 } }
    ]
  })

const supplyTemp = { objectType: ObjectType["analog-input"], instance: 1 }
const deviceObject = { objectType: ObjectType.device, instance: 1001 }

const confirmed = (service: number, body: Uint8Array, maxApdu = 1476): Apdu => ({
  _tag: "ConfirmedRequest",
  invokeId: 7,
  service,
  maxApdu,
  segmentedResponseAccepted: false,
  body
})

const readProperty = (object: { objectType: number; instance: number }, property: number, arrayIndex?: number) =>
  confirmed(
    ConfirmedService.ReadProperty,
    encodeReadProperty({ object, property, ...(arrayIndex === undefined ? {} : { arrayIndex }) })
  )

/** The values of a ComplexAck to ReadProperty, or the APDU itself when it is something else. */
const valuesOf = (response: Apdu | undefined) =>
  response?._tag === "ComplexAck" ? Result.map(decodeReadPropertyAck(response.body), (ack) => ack.values) : response

/** The error class and code of an Error PDU, or the APDU itself when it is something else. */
const errorOf = (response: Apdu | undefined) => (response?._tag === "Error" ? decodeErrorBody(response.body) : response)

const whoIs = (range?: { low: number; high: number }): Apdu => ({
  _tag: "UnconfirmedRequest",
  service: UnconfirmedService.WhoIs,
  body: encodeWhoIs(range === undefined ? {} : { range })
})

/** The results of a ComplexAck to ReadPropertyMultiple; anything else is a failure. */
const multipleOf = (response: Apdu | undefined): Result.Result<ReadonlyArray<ReadAccessResult>, unknown> =>
  response?._tag === "ComplexAck" ? decodeReadPropertyMultipleAck(response.body) : Result.fail(response)

describe("Who-Is", () => {
  it("answers a global Who-Is with I-Am", () => {
    const response = answer(makeDevice(), whoIs())
    expect(response).toMatchObject({ _tag: "UnconfirmedRequest", service: UnconfirmedService.IAm })
    expect(response?._tag === "UnconfirmedRequest" ? decodeIAm(response.body) : response).toEqual(
      Result.succeed({ device: deviceObject, maxApdu: 1476, segmentation: 3, vendorId: 260 })
    )
  })

  it("answers only a range that includes its instance", () => {
    expect(answer(makeDevice(), whoIs({ low: 1000, high: 1001 }))).toBeDefined()
    expect(answer(makeDevice(), whoIs({ low: 1002, high: 2000 }))).toBeUndefined()
  })

  it("stays silent on other unconfirmed services and on acknowledgements", () => {
    const device = makeDevice()
    expect(answer(device, { _tag: "UnconfirmedRequest", service: 2, body: new Uint8Array(0) })).toBeUndefined()
    expect(answer(device, { _tag: "SimpleAck", invokeId: 1, service: 15 })).toBeUndefined()
  })
})

describe("ReadProperty", () => {
  it("reads a present value and follows changes", () => {
    const device = makeDevice()
    expect(valuesOf(answer(device, readProperty(supplyTemp, PropertyId["present-value"])))).toEqual(
      Result.succeed([{ type: "real", value: 18.5 }])
    )
    setPresentValue(device, { objectType: "analog-input", instance: 1 }, { type: "real", value: 19 })
    expect(valuesOf(answer(device, readProperty(supplyTemp, PropertyId["present-value"])))).toEqual(
      Result.succeed([{ type: "real", value: 19 }])
    )
  })

  it("echoes the invoke ID and service", () => {
    expect(answer(makeDevice(), readProperty(supplyTemp, PropertyId.units))).toMatchObject({
      _tag: "ComplexAck",
      invokeId: 7,
      service: ConfirmedService.ReadProperty
    })
  })

  it("reads the object list whole, by index, and its length at index 0", () => {
    const device = makeDevice()
    const objectList = PropertyId["object-list"]
    expect(valuesOf(answer(device, readProperty(deviceObject, objectList)))).toEqual(
      Result.succeed([
        { type: "object-identifier", value: deviceObject },
        { type: "object-identifier", value: supplyTemp },
        { type: "object-identifier", value: { objectType: ObjectType["binary-output"], instance: 2 } }
      ])
    )
    expect(valuesOf(answer(device, readProperty(deviceObject, objectList, 0)))).toEqual(
      Result.succeed([{ type: "unsigned", value: 3 }])
    )
    expect(valuesOf(answer(device, readProperty(deviceObject, objectList, 2)))).toEqual(
      Result.succeed([{ type: "object-identifier", value: supplyTemp }])
    )
  })

  it.each([
    [
      "an unknown object",
      { objectType: 0, instance: 99 },
      PropertyId["present-value"],
      undefined,
      ErrorClass.object,
      ErrorCode["unknown-object"]
    ],
    [
      "an unknown property",
      supplyTemp,
      PropertyId["priority-array"],
      undefined,
      ErrorClass.property,
      ErrorCode["unknown-property"]
    ],
    [
      "an index into a non-array",
      supplyTemp,
      PropertyId["present-value"],
      1,
      ErrorClass.property,
      ErrorCode["property-is-not-an-array"]
    ],
    [
      "an index past the end",
      deviceObject,
      PropertyId["object-list"],
      4,
      ErrorClass.property,
      ErrorCode["invalid-array-index"]
    ]
  ])("answers %s with an error", (_name, object, property, arrayIndex, errorClass, errorCode) => {
    expect(errorOf(answer(makeDevice(), readProperty(object, property, arrayIndex)))).toEqual(
      Result.succeed({ errorClass, errorCode })
    )
  })
})

describe("ReadPropertyMultiple", () => {
  it("returns values and per-property errors in one answer", () => {
    const response = answer(
      makeDevice(),
      confirmed(
        ConfirmedService.ReadPropertyMultiple,
        encodeReadPropertyMultiple([
          {
            object: supplyTemp,
            properties: [{ property: PropertyId["present-value"] }, { property: PropertyId["cov-increment"] }]
          }
        ])
      )
    )
    expect(multipleOf(response)).toEqual(
      Result.succeed([
        {
          object: supplyTemp,
          results: [
            { property: PropertyId["present-value"], _tag: "Value", values: [{ type: "real", value: 18.5 }] },
            {
              property: PropertyId["cov-increment"],
              _tag: "Error",
              errorClass: ErrorClass.property,
              errorCode: ErrorCode["unknown-property"]
            }
          ]
        }
      ])
    )
  })

  it("expands `all` to every property of the object", () => {
    const response = answer(
      makeDevice(),
      confirmed(
        ConfirmedService.ReadPropertyMultiple,
        encodeReadPropertyMultiple([{ object: supplyTemp, properties: [{ property: PropertyId.all }] }])
      )
    )
    const properties = Result.map(multipleOf(response), (acks) =>
      acks.flatMap((ack) => ack.results.map((result) => result.property))
    )
    expect(properties).toEqual(
      Result.succeed([
        PropertyId["object-identifier"],
        PropertyId["object-name"],
        PropertyId["object-type"],
        PropertyId["present-value"],
        PropertyId["status-flags"],
        PropertyId["event-state"],
        PropertyId["out-of-service"],
        PropertyId.units
      ])
    )
  })

  it("aborts an answer larger than the requester accepts, since it never segments", () => {
    const allOfEverything = encodeReadPropertyMultiple(
      [deviceObject, supplyTemp].map((object) => ({ object, properties: [{ property: PropertyId.all }] }))
    )
    expect(answer(makeDevice(), confirmed(ConfirmedService.ReadPropertyMultiple, allOfEverything, 128))).toEqual({
      _tag: "Abort",
      invokeId: 7,
      reason: AbortReason.SegmentationNotSupported,
      fromServer: true
    })
    expect(answer(makeDevice(128), confirmed(ConfirmedService.ReadPropertyMultiple, allOfEverything))).toMatchObject({
      _tag: "Abort"
    })
    expect(answer(makeDevice(), confirmed(ConfirmedService.ReadPropertyMultiple, allOfEverything))).toMatchObject({
      _tag: "ComplexAck"
    })
  })
})

describe("rejects", () => {
  it("rejects a malformed request", () => {
    expect(answer(makeDevice(), confirmed(ConfirmedService.ReadProperty, Uint8Array.of(0x0c, 0x00)))).toEqual({
      _tag: "Reject",
      invokeId: 7,
      reason: RejectReason.InvalidTag
    })
  })

  it("rejects services it does not implement", () => {
    expect(answer(makeDevice(), confirmed(ConfirmedService.WriteProperty, new Uint8Array(0)))).toEqual({
      _tag: "Reject",
      invokeId: 7,
      reason: RejectReason.UnrecognizedService
    })
  })
})

describe("device conventions", () => {
  it("reads the device itself through the wildcard instance", () => {
    const wildcard = { objectType: ObjectType.device, instance: 4_194_303 }
    expect(valuesOf(answer(makeDevice(), readProperty(wildcard, PropertyId["object-identifier"])))).toEqual(
      Result.succeed([{ type: "object-identifier", value: deviceObject }])
    )
  })

  it("gives outputs a priority array and relinquish default", () => {
    const fan = { objectType: ObjectType["binary-output"], instance: 2 }
    expect(valuesOf(answer(makeDevice(), readProperty(fan, PropertyId["priority-array"], 0)))).toEqual(
      Result.succeed([{ type: "unsigned", value: 16 }])
    )
    expect(valuesOf(answer(makeDevice(), readProperty(fan, PropertyId["relinquish-default"])))).toEqual(
      Result.succeed([{ type: "enumerated", value: 1 }])
    )
  })
})
