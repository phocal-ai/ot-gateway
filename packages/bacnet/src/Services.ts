/**
 * Service parameters for the services a gateway needs to discover devices
 * and read them (ASHRAE 135, clause 21 for the ASN.1 productions):
 *
 * - Who-Is and I-Am (clause 16.10)
 * - ReadProperty (clause 15.5)
 * - ReadPropertyMultiple (clause 15.7)
 * - the Error PDU's error class and code (clause 18)
 *
 * Each pair works on the bytes after the service choice in the APDU.
 */
import type { Result } from "effect"
import {
  type BacnetCodecError,
  type BacnetValue,
  decodeWith,
  type ObjectId,
  type Reader,
  writeClosing,
  writeContextObjectId,
  writeContextUnsigned,
  writeOpening,
  Writer,
  writeValue
} from "./Encoding.ts"

// --- Who-Is / I-Am -------------------------------------------------------------

/** Who-Is, optionally limited to device instances `low` to `high` (both or neither). */
export interface WhoIs {
  readonly range?: { readonly low: number; readonly high: number }
}

export const encodeWhoIs = (whoIs: WhoIs): Uint8Array => {
  const writer = new Writer()
  if (whoIs.range !== undefined) {
    writeContextUnsigned(writer, 0, whoIs.range.low)
    writeContextUnsigned(writer, 1, whoIs.range.high)
  }
  return writer.toBytes()
}

export const decodeWhoIs = (body: Uint8Array): Result.Result<WhoIs, BacnetCodecError> =>
  decodeWith(body, (reader): WhoIs => {
    if (reader.remaining === 0) return {}
    const low = reader.contextUnsigned(0)
    const high = reader.contextUnsigned(1)
    return { range: { low, high } }
  })

/** Whether a Who-Is asks for device `instance`. */
export const whoIsMatches = (whoIs: WhoIs, instance: number) =>
  whoIs.range === undefined || (instance >= whoIs.range.low && instance <= whoIs.range.high)

export interface IAm {
  /** The device object, so its type is always `device` (8). */
  readonly device: ObjectId
  readonly maxApdu: number
  /** BACnetSegmentation, see `Segmentation`. */
  readonly segmentation: number
  readonly vendorId: number
}

export const encodeIAm = (iAm: IAm): Uint8Array => {
  const writer = new Writer()
  writeValue(writer, { type: "object-identifier", value: iAm.device })
  writeValue(writer, { type: "unsigned", value: iAm.maxApdu })
  writeValue(writer, { type: "enumerated", value: iAm.segmentation })
  writeValue(writer, { type: "unsigned", value: iAm.vendorId })
  return writer.toBytes()
}

export const decodeIAm = (body: Uint8Array): Result.Result<IAm, BacnetCodecError> =>
  decodeWith(body, (reader) => ({
    device: reader.applicationObjectId(),
    maxApdu: reader.applicationUnsigned(),
    segmentation: reader.applicationEnumerated(),
    vendorId: reader.applicationUnsigned()
  }))

// --- ReadProperty ----------------------------------------------------------------

export interface PropertyReference {
  readonly property: number
  /** An element of an array property; absent for the whole property. */
  readonly arrayIndex?: number
}

export interface ReadPropertyRequest extends PropertyReference {
  readonly object: ObjectId
}

export interface ReadPropertyAck extends ReadPropertyRequest {
  readonly values: ReadonlyArray<BacnetValue>
}

const writeReference = (writer: Writer, reference: PropertyReference, firstTag: number) => {
  writeContextUnsigned(writer, firstTag, reference.property)
  if (reference.arrayIndex !== undefined) writeContextUnsigned(writer, firstTag + 1, reference.arrayIndex)
}

const readReference = (reader: Reader, firstTag: number): PropertyReference => {
  const property = reader.contextUnsigned(firstTag)
  return reader.peekContext(firstTag + 1)
    ? { property, arrayIndex: reader.contextUnsigned(firstTag + 1) }
    : { property }
}

/** The values between opening and closing tag `tagNumber`. */
const readValuesIn = (reader: Reader, tagNumber: number): ReadonlyArray<BacnetValue> => {
  reader.opening(tagNumber)
  const values: Array<BacnetValue> = []
  while (!reader.peekContext(tagNumber, "closing")) {
    if (reader.remaining === 0) reader.fail(`opening tag ${tagNumber} is never closed`)
    values.push(reader.value())
  }
  reader.closing(tagNumber)
  return values
}

const writeValuesIn = (writer: Writer, tagNumber: number, values: ReadonlyArray<BacnetValue>) => {
  writeOpening(writer, tagNumber)
  for (const value of values) writeValue(writer, value)
  writeClosing(writer, tagNumber)
}

export const encodeReadProperty = (request: ReadPropertyRequest): Uint8Array => {
  const writer = new Writer()
  writeContextObjectId(writer, 0, request.object)
  writeReference(writer, request, 1)
  return writer.toBytes()
}

export const decodeReadProperty = (body: Uint8Array): Result.Result<ReadPropertyRequest, BacnetCodecError> =>
  decodeWith(body, (reader) => {
    const object = reader.contextObjectId(0)
    return { object, ...readReference(reader, 1) }
  })

export const encodeReadPropertyAck = (ack: ReadPropertyAck): Uint8Array => {
  const writer = new Writer()
  writeContextObjectId(writer, 0, ack.object)
  writeReference(writer, ack, 1)
  writeValuesIn(writer, 3, ack.values)
  return writer.toBytes()
}

export const decodeReadPropertyAck = (body: Uint8Array): Result.Result<ReadPropertyAck, BacnetCodecError> =>
  decodeWith(body, (reader) => {
    const object = reader.contextObjectId(0)
    const reference = readReference(reader, 1)
    return { object, ...reference, values: readValuesIn(reader, 3) }
  })

// --- ReadPropertyMultiple ----------------------------------------------------------

export interface ReadAccessSpecification {
  readonly object: ObjectId
  readonly properties: ReadonlyArray<PropertyReference>
}

/** What one property read returned: its values, or why it could not be read. */
export type PropertyResult = PropertyReference &
  (
    | { readonly _tag: "Value"; readonly values: ReadonlyArray<BacnetValue> }
    | { readonly _tag: "Error"; readonly errorClass: number; readonly errorCode: number }
  )

export interface ReadAccessResult {
  readonly object: ObjectId
  readonly results: ReadonlyArray<PropertyResult>
}

export const encodeReadPropertyMultiple = (specifications: ReadonlyArray<ReadAccessSpecification>): Uint8Array => {
  const writer = new Writer()
  for (const specification of specifications) {
    writeContextObjectId(writer, 0, specification.object)
    writeOpening(writer, 1)
    for (const reference of specification.properties) writeReference(writer, reference, 0)
    writeClosing(writer, 1)
  }
  return writer.toBytes()
}

export const decodeReadPropertyMultiple = (
  body: Uint8Array
): Result.Result<ReadonlyArray<ReadAccessSpecification>, BacnetCodecError> =>
  decodeWith(body, (reader) => {
    const specifications: Array<ReadAccessSpecification> = []
    while (reader.remaining > 0) {
      const object = reader.contextObjectId(0)
      reader.opening(1)
      const properties: Array<PropertyReference> = []
      while (!reader.peekContext(1, "closing")) {
        if (reader.remaining === 0) reader.fail("list of property references is never closed")
        properties.push(readReference(reader, 0))
      }
      reader.closing(1)
      if (properties.length === 0) reader.fail("read access specification without properties")
      specifications.push({ object, properties })
    }
    if (specifications.length === 0) reader.fail("ReadPropertyMultiple without a specification")
    return specifications
  })

const writeErrorPair = (writer: Writer, errorClass: number, errorCode: number) => {
  writeValue(writer, { type: "enumerated", value: errorClass })
  writeValue(writer, { type: "enumerated", value: errorCode })
}

export const encodeReadPropertyMultipleAck = (results: ReadonlyArray<ReadAccessResult>): Uint8Array => {
  const writer = new Writer()
  for (const result of results) {
    writeContextObjectId(writer, 0, result.object)
    writeOpening(writer, 1)
    for (const item of result.results) {
      writeReference(writer, item, 2)
      if (item._tag === "Value") writeValuesIn(writer, 4, item.values)
      else {
        writeOpening(writer, 5)
        writeErrorPair(writer, item.errorClass, item.errorCode)
        writeClosing(writer, 5)
      }
    }
    writeClosing(writer, 1)
  }
  return writer.toBytes()
}

export const decodeReadPropertyMultipleAck = (
  body: Uint8Array
): Result.Result<ReadonlyArray<ReadAccessResult>, BacnetCodecError> =>
  decodeWith(body, (reader) => {
    const results: Array<ReadAccessResult> = []
    while (reader.remaining > 0) {
      const object = reader.contextObjectId(0)
      reader.opening(1)
      const items: Array<PropertyResult> = []
      while (!reader.peekContext(1, "closing")) {
        if (reader.remaining === 0) reader.fail("list of results is never closed")
        const reference = readReference(reader, 2)
        if (reader.peekContext(4, "opening")) {
          items.push({ ...reference, _tag: "Value", values: readValuesIn(reader, 4) })
        } else {
          reader.opening(5)
          const errorClass = reader.applicationEnumerated()
          const errorCode = reader.applicationEnumerated()
          reader.closing(5)
          items.push({ ...reference, _tag: "Error", errorClass, errorCode })
        }
      }
      reader.closing(1)
      results.push({ object, results: items })
    }
    return results
  })

// --- Error PDU ---------------------------------------------------------------------

export interface ErrorBody {
  readonly errorClass: number
  readonly errorCode: number
}

export const encodeErrorBody = (error: ErrorBody): Uint8Array => {
  const writer = new Writer()
  writeErrorPair(writer, error.errorClass, error.errorCode)
  return writer.toBytes()
}

/**
 * The error class and code of an Error PDU. Most services send the plain
 * pair; a few (WritePropertyMultiple, for one) wrap it in context tag 0
 * and add detail after it, which is skipped.
 */
export const decodeErrorBody = (body: Uint8Array): Result.Result<ErrorBody, BacnetCodecError> =>
  decodeWith(
    body,
    (reader) => {
      const wrapped = reader.peekContext(0, "opening")
      if (wrapped) reader.opening(0)
      const errorClass = reader.applicationEnumerated()
      const errorCode = reader.applicationEnumerated()
      if (wrapped) reader.closing(0)
      return { errorClass, errorCode }
    },
    { whole: false }
  )
