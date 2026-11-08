/**
 * The protocol-neutral point model.
 *
 * A point is one value in the building: a temperature, a setpoint, a meter
 * reading. Protocol packages extend these shared fields with their own
 * addressing (a Modbus register, a BACnet object).
 */
import { Effect, Schema } from "effect"
import { Publish } from "./Publish.ts"

/**
 * Identifier used in MQTT topics: lowercase letters, digits, `-` and `_`, at
 * most 64 characters. MQTT wildcards and separators (`+`, `#`, `/`) can never
 * appear, and the longest topic (`site/building/device/point/$meta`, or the
 * health topic that is also the MQTT will) stays far below MQTT's 65,535-byte
 * limit, past which the CONNECT packet could not even be encoded.
 */
export const Slug = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/, {
      message:
        "Expected a slug: lowercase letters, digits, - and _, starting with a letter or digit (site-1, not Site 1)"
    }),
    Schema.isMaxLength(64)
  )
)
export type Slug = typeof Slug.Type

/** Optional semantic tagging. Brick is primary, Haystack tags are for integrators. */
export const Semantics = Schema.Struct({
  /** Brick class name, e.g. `Supply_Air_Temperature_Sensor`. */
  brick: Schema.optionalKey(Schema.String),
  /** Haystack marker tags, e.g. `["discharge", "air", "temp", "sensor"]`. */
  haystack: Schema.optionalKey(Schema.Array(Schema.String))
})
export type Semantics = typeof Semantics.Type

/** Linear scaling applied to raw values: `value = raw * factor + offset`. */
export const Scaling = Schema.Struct({
  /** Not 0, which would publish `offset` whatever the device reads. */
  factor: Schema.Finite.pipe(
    Schema.check(Schema.makeFilter((factor) => factor !== 0 || "a scaling factor of 0 hides every reading")),
    Schema.withDecodingDefaultKey(Effect.succeed(1))
  ),
  offset: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0)))
})
export type Scaling = typeof Scaling.Type

/** Fields every point has, whatever its protocol. */
/**
 * The values a command may set, in engineering units (after scaling),
 * inclusive. Required on every writable numeric point: there is no
 * unlimited write (VISION.md, principle 6).
 */
export const Limits = Schema.Struct({ min: Schema.Finite, max: Schema.Finite }).check(
  Schema.makeFilter((limits) => limits.min <= limits.max || { path: ["max"], issue: "max is below min" })
)
export type Limits = typeof Limits.Type

export const PointFields = {
  id: Slug,
  name: Schema.String,
  /** QUDT unit identifier, e.g. `unit:DEG_C`. */
  unit: Schema.optionalKey(Schema.String),
  /** Writing is opt-in per point. */
  writable: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  limits: Schema.optionalKey(Limits),
  /**
   * Minimum change (after scaling) before a new value is published: the short form of
   * `publish: { mode: "change", deadband }`. A point has one or the other.
   */
  deadband: Schema.optionalKey(Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  /** How this point's values go out, instead of its device's `publish` (see `Publish.ts`). */
  publish: Schema.optionalKey(Publish),
  scaling: Schema.optionalKey(Scaling),
  semantics: Schema.optionalKey(Semantics)
} as const

/** Value types a register-based protocol can decode. */
export const DataType = Schema.Literals([
  "int16",
  "uint16",
  "int32",
  "uint32",
  "float32",
  "int64",
  "uint64",
  "float64",
  "bool"
])
export type DataType = typeof DataType.Type

/** How many 16-bit registers a value of `dataType` takes. */
export const registerWidth = (dataType: DataType): 1 | 2 | 4 => {
  switch (dataType) {
    case "int32":
    case "uint32":
    case "float32":
      return 2
    case "int64":
    case "uint64":
    case "float64":
      return 4
    case "int16":
    case "uint16":
    case "bool":
      return 1
  }
}

/**
 * The order of a value's bytes across its registers, naming the bytes of a
 * 32-bit value A (most significant) to D as the device sends them (Modbus
 * itself only fixes big-endian within one register, §4.2):
 *
 * - `ABCD`: big-endian, high word first (the default, and most devices);
 * - `CDAB`: words swapped, low word first (common on meters and PLCs);
 * - `BADC`: bytes swapped within each register;
 * - `DCBA`: little-endian.
 *
 * Wider values follow the same two rules (word order reversed, bytes swapped
 * within each register); a single register is only byte-swapped (`BADC`, `DCBA`).
 */
export const ByteOrder = Schema.Literals(["ABCD", "CDAB", "BADC", "DCBA"])
export type ByteOrder = typeof ByteOrder.Type

/**
 * A point on a Modbus TCP device. Addresses are 0 to 65535 (Modbus
 * Application Protocol §4.4), and a value of several registers must end
 * there too: a read cannot run past the last address.
 */
export const ModbusPoint = Schema.Struct({
  ...PointFields,
  table: Schema.Literals(["holding", "input", "coil", "discrete"]),
  address: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))),
  dataType: DataType,
  byteOrder: ByteOrder.pipe(Schema.withDecodingDefaultKey(Effect.succeed("ABCD"))),
  /**
   * One bit of a holding or input register, 0 (least significant) to 15:
   * a status word's alarm flag, say. The point is true or false, so it needs
   * `dataType: "bool"`, and it cannot be written: setting one bit means
   * reading the register and writing it back, which could undo another
   * change made to it in between.
   */
  bit: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 15 }))))
}).check(
  Schema.makeFilter((point) => {
    if (point.bit === undefined) return true
    if (point.table !== "holding" && point.table !== "input") {
      return {
        path: ["bit"],
        issue: "a bit is read from a holding or input register; coils and discrete inputs are bits already"
      }
    }
    if (point.dataType !== "bool") return { path: ["dataType"], issue: 'a bit of a register is "bool"' }
    return !point.writable || { path: ["writable"], issue: "a bit of a register cannot be written" }
  }),
  Schema.makeFilter((point) => {
    if (point.table !== "holding" && point.table !== "input") return true
    const width = registerWidth(point.dataType)
    return (
      point.address + width - 1 <= 65535 || {
        path: ["address"],
        issue: `a ${point.dataType} takes ${width} registers, so its address must be at most ${65536 - width}`
      }
    )
  }),
  Schema.makeFilter((point) => {
    if (!point.writable) return true
    if (point.table !== "holding" && point.table !== "coil") {
      return {
        path: ["writable"],
        issue: `${point.table} ${point.table === "input" ? "registers" : "inputs"} are read-only`
      }
    }
    const numeric = point.table === "holding" && point.dataType !== "bool"
    return !numeric || point.limits !== undefined || limitsRequired
  })
)
export type ModbusPoint = typeof ModbusPoint.Type

/** The issue of a writable numeric point without limits. */
const limitsRequired = {
  path: ["limits"],
  issue: "a writable numeric point needs limits ({ min, max }): there is no unlimited write"
} as const

/** A config name (`binary-output`) or plain number (`4`) for one BACnet enumeration value. */
const names = (value: string, name: string, number: number) =>
  value === name || (/^\d+$/.test(value) && Number(value) === number)

/**
 * What a BACnet point's present value takes when written: true or false
 * (binary objects, clause 12.6-12.8), a whole number from 1 (multi-state
 * objects, an Unsigned state index, clause 12.18-12.20) or a REAL. Any other
 * property is a REAL too. Names and numbers count alike, as the driver
 * resolves both, so the config, the guard and the driver always agree.
 */
export const bacnetValueKind = (point: {
  readonly objectType: string
  readonly property: string
}): "binary" | "multi-state" | "real" => {
  if (!names(point.property, "present-value", 85)) return "real"
  const type = point.objectType
  if (names(type, "binary-input", 3) || names(type, "binary-output", 4) || names(type, "binary-value", 5))
    return "binary"
  if (
    names(type, "multi-state-input", 13) ||
    names(type, "multi-state-output", 14) ||
    names(type, "multi-state-value", 19)
  )
    return "multi-state"
  return "real"
}

/** A point on a BACnet/IP device. */
export const BacnetPoint = Schema.Struct({
  ...PointFields,
  /** Object type by its ASHRAE 135 name (`analog-input`) or number (proprietary types, 128 and up). */
  objectType: Schema.String,
  /** 22 bits on the wire (clause 20.2.14). */
  instance: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 4_194_302 }))),
  /** Property by its ASHRAE 135 name or number (default `present-value`). */
  property: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("present-value"))),
  /**
   * The priority array slot writes use (clause 19.2), 1 (highest) to 16;
   * default 8, manual operator. 6 is reserved for minimum on/off time.
   */
  priority: Schema.Int.pipe(
    Schema.check(
      Schema.isBetween({ minimum: 1, maximum: 16 }),
      Schema.makeFilter((priority) => priority !== 6 || "priority 6 is reserved for minimum on/off time")
    ),
    Schema.withDecodingDefaultKey(Effect.succeed(8))
  )
}).check(
  Schema.makeFilter((point) => {
    // A binary object's present value is active or inactive; anything else written is a number.
    const numeric = bacnetValueKind(point) !== "binary"
    return !point.writable || !numeric || point.limits !== undefined || limitsRequired
  })
)
export type BacnetPoint = typeof BacnetPoint.Type

/** A simulated point, used in tests and demos. */
export const SimulatedPoint = Schema.Struct({
  ...PointFields,
  waveform: Schema.Literals(["sine", "ramp", "constant"]),
  min: Schema.Finite,
  max: Schema.Finite,
  periodSeconds: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(60)))
}).check(
  Schema.makeFilter(
    (point) => !point.writable || { path: ["writable"], issue: "a simulated waveform cannot be written" }
  )
)
export type SimulatedPoint = typeof SimulatedPoint.Type

/** The shared view of any point, used by the pipeline. */
export interface AnyPoint {
  readonly id: Slug
  readonly name: string
  readonly unit?: string
  readonly writable: boolean
  readonly limits?: Limits
  readonly deadband?: number
  readonly publish?: Publish
  readonly scaling?: Scaling
  readonly semantics?: Semantics
}
