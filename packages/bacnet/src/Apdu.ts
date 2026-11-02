/**
 * Application layer PDUs, APDU (ASHRAE 135, clause 20.1). The service
 * parameters stay as bytes here; `Services.ts` encodes and decodes them.
 *
 * Plenum never sends segmented messages and does not accept segmented
 * responses (it asks for small batches instead). A segmented ComplexACK is
 * still decoded, with its segment fields, so the client can abort it.
 */
import type { Result } from "effect"
import { type BacnetCodecError, decodeWith, Writer } from "./Encoding.ts"

export const PduType = {
  ConfirmedRequest: 0,
  UnconfirmedRequest: 1,
  SimpleAck: 2,
  ComplexAck: 3,
  SegmentAck: 4,
  Error: 5,
  Reject: 6,
  Abort: 7
} as const

/** Confirmed service choices (clause 21, BACnetConfirmedServiceChoice). */
export const ConfirmedService = {
  AcknowledgeAlarm: 0,
  ConfirmedCovNotification: 1,
  SubscribeCov: 5,
  ReadProperty: 12,
  ReadPropertyMultiple: 14,
  WriteProperty: 15,
  WritePropertyMultiple: 16,
  DeviceCommunicationControl: 17,
  ReinitializeDevice: 20,
  SubscribeCovProperty: 28
} as const

/** Unconfirmed service choices (clause 21, BACnetUnconfirmedServiceChoice). */
export const UnconfirmedService = {
  IAm: 0,
  IHave: 1,
  UnconfirmedCovNotification: 2,
  WhoHas: 7,
  WhoIs: 8
} as const

/** Reject reasons (clause 21, BACnetRejectReason). */
export const RejectReason = {
  Other: 0,
  BufferOverflow: 1,
  InconsistentParameters: 2,
  InvalidParameterDataType: 3,
  InvalidTag: 4,
  MissingRequiredParameter: 5,
  ParameterOutOfRange: 6,
  TooManyArguments: 7,
  UndefinedEnumeration: 8,
  UnrecognizedService: 9
} as const

/** Abort reasons (clause 21, BACnetAbortReason). */
export const AbortReason = {
  Other: 0,
  BufferOverflow: 1,
  InvalidApduInThisState: 2,
  PreemptedByHigherPriorityTask: 3,
  SegmentationNotSupported: 4
} as const

/** Maximum APDU sizes by their 4-bit code (clause 20.1.2.5). */
const maxApduSizes = [50, 128, 206, 480, 1024, 1476] as const

/** The largest APDU on BACnet/IP (clause J.2, an Ethernet frame minus headers). */
export const MAX_APDU_IP = 1476

const maxApduCode = (size: number) => {
  let code = 0
  maxApduSizes.forEach((limit, index) => {
    if (size >= limit) code = index
  })
  return code
}

export type Apdu =
  | {
      readonly _tag: "ConfirmedRequest"
      readonly invokeId: number
      readonly service: number
      /** Largest APDU the requester accepts, in bytes. */
      readonly maxApdu: number
      readonly segmentedResponseAccepted: boolean
      readonly body: Uint8Array
    }
  | { readonly _tag: "UnconfirmedRequest"; readonly service: number; readonly body: Uint8Array }
  | { readonly _tag: "SimpleAck"; readonly invokeId: number; readonly service: number }
  | {
      readonly _tag: "ComplexAck"
      readonly invokeId: number
      readonly service: number
      /** Present when the ACK is one segment of several. */
      readonly segment?: { readonly sequenceNumber: number; readonly moreFollows: boolean; readonly windowSize: number }
      readonly body: Uint8Array
    }
  | {
      readonly _tag: "SegmentAck"
      readonly invokeId: number
      readonly negative: boolean
      readonly fromServer: boolean
      readonly sequenceNumber: number
      readonly windowSize: number
    }
  | { readonly _tag: "Error"; readonly invokeId: number; readonly service: number; readonly body: Uint8Array }
  | { readonly _tag: "Reject"; readonly invokeId: number; readonly reason: number }
  | { readonly _tag: "Abort"; readonly invokeId: number; readonly reason: number; readonly fromServer: boolean }

export const encodeApdu = (apdu: Apdu): Uint8Array => {
  const writer = new Writer()
  switch (apdu._tag) {
    case "ConfirmedRequest":
      writer
        .byte((PduType.ConfirmedRequest << 4) | (apdu.segmentedResponseAccepted ? 0x02 : 0))
        .byte(maxApduCode(apdu.maxApdu))
        .byte(apdu.invokeId)
        .byte(apdu.service)
        .bytes(apdu.body)
      break
    case "UnconfirmedRequest":
      writer
        .byte(PduType.UnconfirmedRequest << 4)
        .byte(apdu.service)
        .bytes(apdu.body)
      break
    case "SimpleAck":
      writer
        .byte(PduType.SimpleAck << 4)
        .byte(apdu.invokeId)
        .byte(apdu.service)
      break
    case "ComplexAck":
      if (apdu.segment === undefined) {
        writer.byte(PduType.ComplexAck << 4).byte(apdu.invokeId)
      } else {
        writer
          .byte((PduType.ComplexAck << 4) | 0x08 | (apdu.segment.moreFollows ? 0x04 : 0))
          .byte(apdu.invokeId)
          .byte(apdu.segment.sequenceNumber)
          .byte(apdu.segment.windowSize)
      }
      writer.byte(apdu.service).bytes(apdu.body)
      break
    case "SegmentAck":
      writer
        .byte((PduType.SegmentAck << 4) | (apdu.negative ? 0x02 : 0) | (apdu.fromServer ? 0x01 : 0))
        .byte(apdu.invokeId)
        .byte(apdu.sequenceNumber)
        .byte(apdu.windowSize)
      break
    case "Error":
      writer
        .byte(PduType.Error << 4)
        .byte(apdu.invokeId)
        .byte(apdu.service)
        .bytes(apdu.body)
      break
    case "Reject":
      writer
        .byte(PduType.Reject << 4)
        .byte(apdu.invokeId)
        .byte(apdu.reason)
      break
    case "Abort":
      writer
        .byte((PduType.Abort << 4) | (apdu.fromServer ? 0x01 : 0))
        .byte(apdu.invokeId)
        .byte(apdu.reason)
      break
  }
  return writer.toBytes()
}

export const decodeApdu = (bytes: Uint8Array): Result.Result<Apdu, BacnetCodecError> =>
  decodeWith(bytes, (reader): Apdu => {
    const first = reader.byte()
    const rest = () => Uint8Array.from(reader.bytes(reader.remaining))
    switch (first >> 4) {
      case PduType.ConfirmedRequest: {
        if ((first & 0x08) !== 0) reader.fail("segmented requests are not supported")
        const sizes = reader.byte()
        const invokeId = reader.byte()
        const service = reader.byte()
        return {
          _tag: "ConfirmedRequest",
          invokeId,
          service,
          maxApdu: maxApduSizes[sizes & 0x0f] ?? 50,
          segmentedResponseAccepted: (first & 0x02) !== 0,
          body: rest()
        }
      }
      case PduType.UnconfirmedRequest:
        return { _tag: "UnconfirmedRequest", service: reader.byte(), body: rest() }
      case PduType.SimpleAck:
        return { _tag: "SimpleAck", invokeId: reader.byte(), service: reader.byte() }
      case PduType.ComplexAck: {
        const invokeId = reader.byte()
        if ((first & 0x08) === 0) return { _tag: "ComplexAck", invokeId, service: reader.byte(), body: rest() }
        const sequenceNumber = reader.byte()
        const windowSize = reader.byte()
        return {
          _tag: "ComplexAck",
          invokeId,
          segment: { sequenceNumber, windowSize, moreFollows: (first & 0x04) !== 0 },
          service: reader.byte(),
          body: rest()
        }
      }
      case PduType.SegmentAck:
        return {
          _tag: "SegmentAck",
          negative: (first & 0x02) !== 0,
          fromServer: (first & 0x01) !== 0,
          invokeId: reader.byte(),
          sequenceNumber: reader.byte(),
          windowSize: reader.byte()
        }
      case PduType.Error:
        return { _tag: "Error", invokeId: reader.byte(), service: reader.byte(), body: rest() }
      case PduType.Reject:
        return { _tag: "Reject", invokeId: reader.byte(), reason: reader.byte() }
      case PduType.Abort:
        return { _tag: "Abort", fromServer: (first & 0x01) !== 0, invokeId: reader.byte(), reason: reader.byte() }
      default:
        return reader.fail(`reserved PDU type ${first >> 4}`)
    }
  })
