/**
 * The protocol-neutral point model.
 *
 * A point is one value in the building: a temperature, a setpoint, a meter
 * reading. Protocol packages extend these shared fields with their own
 * addressing (a Modbus register, a BACnet object).
 */
import { Effect, Schema } from "effect"

/**
 * Identifier used in MQTT topics: lowercase letters, digits, `-` and `_`, at
 * most 64 characters. MQTT wildcards and separators (`+`, `#`, `/`) can never
 * appear, and the longest topic (`site/building/device/point/$meta`, or the
 * health topic that is also the MQTT will) stays far below MQTT's 65,535-byte
 * limit, past which the CONNECT packet could not even be encoded.
 */
export const Slug = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/), Schema.isMaxLength(64)))
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
export const PointFields = {
  id: Slug,
  name: Schema.String,
  /** QUDT unit identifier, e.g. `unit:DEG_C`. */
  unit: Schema.optionalKey(Schema.String),
  /** Writing is opt-in per point. */
  writable: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** Minimum change (after scaling) before a new value is published. */
  deadband: Schema.optionalKey(Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  scaling: Schema.optionalKey(Scaling),
  semantics: Schema.optionalKey(Semantics)
} as const

/** Value types a register-based protocol can decode. */
export const DataType = Schema.Literals(["int16", "uint16", "int32", "uint32", "float32", "bool"])
export type DataType = typeof DataType.Type

/** A point on a Modbus TCP device. */
export const ModbusPoint = Schema.Struct({
  ...PointFields,
  table: Schema.Literals(["holding", "input", "coil", "discrete"]),
  address: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))),
  dataType: DataType
})
export type ModbusPoint = typeof ModbusPoint.Type

/** A point on a BACnet/IP device. */
export const BacnetPoint = Schema.Struct({
  ...PointFields,
  /** Object type by its ASHRAE 135 name (`analog-input`) or number (proprietary types, 128 and up). */
  objectType: Schema.String,
  /** 22 bits on the wire (clause 20.2.14). */
  instance: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 4_194_302 }))),
  /** Property by its ASHRAE 135 name or number (default `present-value`). */
  property: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("present-value")))
})
export type BacnetPoint = typeof BacnetPoint.Type

/** A simulated point, used in tests and demos. */
export const SimulatedPoint = Schema.Struct({
  ...PointFields,
  waveform: Schema.Literals(["sine", "ramp", "constant"]),
  min: Schema.Finite,
  max: Schema.Finite,
  periodSeconds: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(60)))
})
export type SimulatedPoint = typeof SimulatedPoint.Type

/** The shared view of any point, used by the pipeline. */
export interface AnyPoint {
  readonly id: Slug
  readonly name: string
  readonly unit?: string
  readonly writable: boolean
  readonly deadband?: number
  readonly scaling?: Scaling
  readonly semantics?: Semantics
}
