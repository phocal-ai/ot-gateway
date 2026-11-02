/**
 * Service parameters: Who-Is/I-Am (16.10), ReadProperty (15.5),
 * ReadPropertyMultiple (15.7) and the Error PDU (18).
 */
import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import {
  decodeErrorBody,
  decodeIAm,
  decodeReadProperty,
  decodeReadPropertyAck,
  decodeReadPropertyMultiple,
  decodeReadPropertyMultipleAck,
  decodeWhoIs,
  encodeErrorBody,
  encodeIAm,
  encodeReadProperty,
  encodeReadPropertyAck,
  encodeReadPropertyMultiple,
  encodeReadPropertyMultipleAck,
  encodeWhoIs,
  ErrorClass,
  ErrorCode,
  type IAm,
  ObjectType,
  PropertyId,
  type ReadAccessResult,
  type ReadAccessSpecification,
  type ReadPropertyAck,
  Segmentation,
  whoIsMatches
} from "../src/index.ts"

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ")
const bytesOf = (text: string) => Uint8Array.from(text.split(" "), (b) => Number.parseInt(b, 16))

const analogInput5 = { objectType: ObjectType["analog-input"], instance: 5 }

describe("Who-Is", () => {
  it("encodes a range as context tags 0 and 1", () => {
    expect(hex(encodeWhoIs({ range: { low: 3, high: 3 } }))).toBe("09 03 19 03")
    expect(decodeWhoIs(bytesOf("09 03 19 03"))).toEqual(Result.succeed({ range: { low: 3, high: 3 } }))
  })

  it("encodes a global Who-Is as no parameters", () => {
    expect(encodeWhoIs({})).toHaveLength(0)
    expect(decodeWhoIs(new Uint8Array(0))).toEqual(Result.succeed({}))
  })

  it("rejects a range with only a low limit", () => {
    expect(Result.isFailure(decodeWhoIs(bytesOf("09 03")))).toBe(true)
  })

  it("matches instances inside the range, limits included", () => {
    const whoIs = { range: { low: 10, high: 20 } }
    expect([9, 10, 20, 21].map((instance) => whoIsMatches(whoIs, instance))).toEqual([false, true, true, false])
    expect(whoIsMatches({}, 4_194_302)).toBe(true)
  })
})

describe("I-Am", () => {
  it("encodes device, max APDU, segmentation and vendor as application values", () => {
    const iAm: IAm = {
      device: { objectType: ObjectType.device, instance: 111 },
      maxApdu: 480,
      segmentation: Segmentation["no-segmentation"],
      vendorId: 99
    }
    expect(hex(encodeIAm(iAm))).toBe("c4 02 00 00 6f 22 01 e0 91 03 21 63")
    expect(decodeIAm(encodeIAm(iAm))).toEqual(Result.succeed(iAm))
  })
})

describe("ReadProperty", () => {
  it("encodes the request from the Annex F example", () => {
    const request = { object: analogInput5, property: PropertyId["present-value"] }
    expect(hex(encodeReadProperty(request))).toBe("0c 00 00 00 05 19 55")
    expect(decodeReadProperty(encodeReadProperty(request))).toEqual(Result.succeed(request))
  })

  it("encodes the acknowledgement from the Annex F example (72.4)", () => {
    const ack: ReadPropertyAck = {
      object: analogInput5,
      property: PropertyId["present-value"],
      values: [{ type: "real", value: 72.4 }]
    }
    expect(hex(encodeReadPropertyAck(ack))).toBe("0c 00 00 00 05 19 55 3e 44 42 90 cc cd 3f")
    expect(decodeReadPropertyAck(bytesOf("0c 00 00 00 05 19 55 3e 44 42 90 cc cd 3f"))).toEqual(Result.succeed(ack))
  })

  it("round-trips an array index and an array of values", () => {
    const ack = {
      object: { objectType: ObjectType.device, instance: 1 },
      property: PropertyId["object-list"],
      arrayIndex: 2,
      values: [{ type: "object-identifier" as const, value: analogInput5 }]
    }
    expect(decodeReadPropertyAck(encodeReadPropertyAck(ack))).toEqual(Result.succeed(ack))
  })

  it("rejects an acknowledgement whose value list is never closed", () => {
    expect(Result.isFailure(decodeReadPropertyAck(bytesOf("0c 00 00 00 05 19 55 3e 44 42 90 cc cd")))).toBe(true)
  })
})

describe("ReadPropertyMultiple", () => {
  it("encodes a list of property references per object", () => {
    const request: ReadonlyArray<ReadAccessSpecification> = [
      {
        object: analogInput5,
        properties: [{ property: PropertyId["present-value"] }, { property: PropertyId["status-flags"] }]
      }
    ]
    expect(hex(encodeReadPropertyMultiple(request))).toBe("0c 00 00 00 05 1e 09 55 09 6f 1f")
    expect(decodeReadPropertyMultiple(encodeReadPropertyMultiple(request))).toEqual(Result.succeed(request))
  })

  it("rejects an empty request and an object without properties", () => {
    expect(Result.isFailure(decodeReadPropertyMultiple(new Uint8Array(0)))).toBe(true)
    expect(Result.isFailure(decodeReadPropertyMultiple(bytesOf("0c 00 00 00 05 1e 1f")))).toBe(true)
  })

  it("round-trips values and per-property errors in one acknowledgement", () => {
    const ack: ReadonlyArray<ReadAccessResult> = [
      {
        object: analogInput5,
        results: [
          { property: PropertyId["present-value"], _tag: "Value", values: [{ type: "real", value: 21.5 }] },
          {
            property: PropertyId["priority-array"],
            arrayIndex: 1,
            _tag: "Error",
            errorClass: ErrorClass.property,
            errorCode: ErrorCode["unknown-property"]
          }
        ]
      },
      {
        object: { objectType: ObjectType["binary-input"], instance: 1 },
        results: [{ property: PropertyId["present-value"], _tag: "Value", values: [{ type: "enumerated", value: 1 }] }]
      }
    ]
    expect(decodeReadPropertyMultipleAck(encodeReadPropertyMultipleAck(ack))).toEqual(Result.succeed(ack))
  })
})

describe("Error PDU", () => {
  const unknownProperty = { errorClass: ErrorClass.property, errorCode: ErrorCode["unknown-property"] }

  it("encodes error class and code as enumerations", () => {
    expect(hex(encodeErrorBody(unknownProperty))).toBe("91 02 91 20")
    expect(decodeErrorBody(bytesOf("91 02 91 20"))).toEqual(Result.succeed(unknownProperty))
  })

  it("reads a pair wrapped in context tag 0 and skips the detail after it", () => {
    expect(decodeErrorBody(bytesOf("0e 91 02 91 20 0f 19 03"))).toEqual(Result.succeed(unknownProperty))
  })
})
