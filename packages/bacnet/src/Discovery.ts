/**
 * What a device holds, read once for a config draft: its name and, for each
 * object a gateway would poll, the object's name and engineering units. Used
 * by `main.ts --discover`; the gateway itself never discovers objects.
 *
 * The object list is read entry by entry (array index 0 is its length,
 * clause 12.1.6.1 and 15.5.1.1.3), so a device whose whole list would need a
 * segmented answer still describes itself.
 */
import { Effect } from "effect"
import type { BacnetClient, DeviceAddress } from "./Client.ts"
import type { BacnetValue } from "./Encoding.ts"
import { ObjectType, PropertyId } from "./Enums.ts"

/** Object types a gateway polls; the rest (schedules, trend logs, files…) are not points. */
export const POINT_TYPES = [
  "analog-input",
  "analog-output",
  "analog-value",
  "binary-input",
  "binary-output",
  "binary-value",
  "multi-state-input",
  "multi-state-output",
  "multi-state-value"
] as const
type PointType = (typeof POINT_TYPES)[number]

/** Objects read from one device at most; a draft beyond that is no longer a draft anyone reviews. */
export const MAX_OBJECTS = 2_000

const pointTypeOf = new Map<number, PointType>(POINT_TYPES.map((name) => [ObjectType[name], name]))

/**
 * BACnetEngineeringUnits (clause 21) to QUDT, for the common ones. A unit not
 * here is left out of the draft rather than guessed.
 */
export const qudtUnits: ReadonlyMap<number, string> = new Map([
  [2, "unit:MilliA"],
  [3, "unit:A"],
  [5, "unit:V"],
  [18, "unit:W-HR"],
  [19, "unit:KiloW-HR"],
  [27, "unit:HZ"],
  [29, "unit:PERCENT_RH"],
  [47, "unit:W"],
  [48, "unit:KiloW"],
  [49, "unit:MegaW"],
  [53, "unit:PA"],
  [54, "unit:KiloPA"],
  [55, "unit:BAR"],
  [62, "unit:DEG_C"],
  [63, "unit:K"],
  [64, "unit:DEG_F"],
  [71, "unit:HR"],
  [72, "unit:MIN"],
  [73, "unit:SEC"],
  [96, "unit:PPM"],
  [98, "unit:PERCENT"],
  [104, "unit:REV-PER-MIN"]
])

export interface DescribedObject {
  readonly objectType: PointType
  readonly instance: number
  /** Its object-name, or empty when the device would not say. */
  readonly name: string
  /** QUDT, for an analog object whose units are known here. */
  readonly unit?: string
}

export interface DescribedDevice {
  readonly name: string
  /** How many objects the device lists; only the first `MAX_OBJECTS` are read. */
  readonly listed: number
  readonly objects: ReadonlyArray<DescribedObject>
}

const text = (values: ReadonlyArray<BacnetValue>) => {
  const [first] = values
  return first?.type === "character-string" ? first.value : ""
}

/** Read a device's name and its pollable objects, at most `concurrency` requests at a time. */
export const describeDevice = Effect.fn("Bacnet.describeDevice")(function* (
  client: BacnetClient,
  target: DeviceAddress,
  instance: number,
  concurrency = 4
) {
  const device = { objectType: ObjectType.device, instance }
  const read = (
    object: { readonly objectType: number; readonly instance: number },
    property: number,
    arrayIndex?: number
  ) => client.readProperty(target, { object, property, ...(arrayIndex === undefined ? {} : { arrayIndex }) })
  const name = text(yield* read(device, PropertyId["object-name"]))
  const [count] = yield* read(device, PropertyId["object-list"], 0)
  // The length comes off the wire: bounded before anything is allocated for it.
  const listed = count?.type === "unsigned" ? count.value : 0
  const length = Math.min(listed, MAX_OBJECTS)
  const entries = yield* Effect.forEach(
    Array.from({ length }, (_, index) => index + 1),
    (index) => read(device, PropertyId["object-list"], index),
    { concurrency }
  )
  const objects = entries.flatMap(([entry]) => {
    if (entry?.type !== "object-identifier") return []
    const objectType = pointTypeOf.get(entry.value.objectType)
    return objectType === undefined ? [] : [{ objectType, id: entry.value }]
  })
  const described = yield* Effect.forEach(
    objects,
    ({ objectType, id }) =>
      Effect.gen(function* () {
        const objectName = yield* read(id, PropertyId["object-name"]).pipe(
          Effect.map(text),
          // A device that refuses to name an object (unknown-property) still has the object.
          Effect.catchTag("BacnetDeviceError", () => Effect.succeed(""))
        )
        const units = objectType.startsWith("analog-")
          ? yield* read(id, PropertyId.units).pipe(
              Effect.map(([value]) => (value?.type === "enumerated" ? (qudtUnits.get(value.value) ?? "") : "")),
              Effect.catchTag("BacnetDeviceError", () => Effect.succeed(""))
            )
          : ""
        const object: DescribedObject = {
          objectType,
          instance: id.instance,
          name: objectName,
          ...(units === "" ? {} : { unit: units })
        }
        return object
      }),
    { concurrency }
  )
  return { name, listed, objects: described } satisfies DescribedDevice
})
