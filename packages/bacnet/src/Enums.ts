/**
 * BACnet enumerations Plenum needs, with the hyphenated names ASHRAE 135
 * uses in clause 21 (`analog-input`, `present-value`). Config files name
 * objects and properties this way; the wire carries the numbers.
 */

/** BACnetObjectType (clause 21). The common ones in building automation. */
export const ObjectType = {
  "analog-input": 0,
  "analog-output": 1,
  "analog-value": 2,
  "binary-input": 3,
  "binary-output": 4,
  "binary-value": 5,
  calendar: 6,
  command: 7,
  device: 8,
  "event-enrollment": 9,
  file: 10,
  group: 11,
  loop: 12,
  "multi-state-input": 13,
  "multi-state-output": 14,
  "notification-class": 15,
  program: 16,
  schedule: 17,
  averaging: 18,
  "multi-state-value": 19,
  "trend-log": 20,
  accumulator: 23,
  "pulse-converter": 24,
  "large-analog-value": 46,
  "integer-value": 45,
  "positive-integer-value": 48
} as const

export type ObjectTypeName = keyof typeof ObjectType

/** BACnetPropertyIdentifier (clause 21). The properties a gateway reads. */
export const PropertyId = {
  all: 8,
  "cov-increment": 22,
  description: 28,
  "event-state": 36,
  "max-apdu-length-accepted": 62,
  "model-name": 70,
  "object-identifier": 75,
  "object-list": 76,
  "object-name": 77,
  "object-type": 79,
  "out-of-service": 81,
  "present-value": 85,
  "priority-array": 87,
  reliability: 103,
  "relinquish-default": 104,
  required: 105,
  "segmentation-supported": 107,
  "status-flags": 111,
  "system-status": 112,
  units: 117,
  "vendor-identifier": 120,
  "vendor-name": 121,
  "protocol-version": 98,
  "protocol-revision": 139,
  "max-segments-accepted": 167,
  "state-text": 110,
  "number-of-states": 74,
  "active-text": 4,
  "inactive-text": 46
} as const

export type PropertyName = keyof typeof PropertyId

/** BACnetSegmentation (clause 21). */
export const Segmentation = {
  "segmented-both": 0,
  "segmented-transmit": 1,
  "segmented-receive": 2,
  "no-segmentation": 3
} as const

/** Error classes (clause 18). */
export const ErrorClass = {
  device: 0,
  object: 1,
  property: 2,
  resources: 3,
  security: 4,
  services: 5,
  vt: 6,
  communication: 7
} as const

/** The error codes a read can produce (clause 18). */
export const ErrorCode = {
  other: 0,
  "configuration-in-progress": 2,
  "device-busy": 3,
  "inconsistent-parameters": 7,
  "invalid-data-type": 9,
  "missing-required-parameter": 16,
  "no-space-for-object": 18,
  "read-access-denied": 27,
  "service-request-denied": 29,
  timeout: 30,
  "unknown-object": 31,
  "unknown-property": 32,
  "unsupported-object-type": 36,
  "value-out-of-range": 37,
  "write-access-denied": 40,
  "invalid-array-index": 42,
  "cov-subscription-failed": 43,
  "not-cov-property": 44,
  "property-is-not-an-array": 50,
  "abort-segmentation-not-supported": 128
} as const

/** The name for `value` in `table`, or the number as text for values Plenum does not know. */
export const nameOf = (table: Readonly<Record<string, number>>, value: number): string =>
  Object.entries(table).find(([, number]) => number === value)?.[0] ?? String(value)

/**
 * The number for a configured object type: a name from `ObjectType`, or a
 * plain number for proprietary types (128 and up).
 */
export const objectTypeNumber = (name: string): number | undefined => lookup(ObjectType, name, 0x3_ff)

/** The number for a configured property: a name from `PropertyId`, or a plain number. */
export const propertyNumber = (name: string): number | undefined => lookup(PropertyId, name, 4_194_303)

const lookup = (table: Readonly<Record<string, number>>, name: string, max: number): number | undefined => {
  const known = table[name]
  if (known !== undefined) return known
  if (!/^\d+$/.test(name)) return undefined
  const number = Number(name)
  return number <= max ? number : undefined
}
