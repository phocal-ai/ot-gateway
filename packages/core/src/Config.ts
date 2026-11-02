/**
 * Gateway configuration. One JSON document describes the whole gateway, so it
 * can live in a file, in a database, or be edited by a web app.
 */
import { Effect, Schema } from "effect"
import { BacnetPoint, ModbusPoint, SimulatedPoint, Slug } from "./Point.ts"

const pollIntervalMs = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 100, maximum: 86_400_000 })),
  Schema.withDecodingDefaultKey(Effect.succeed(5_000))
)

export const ModbusDevice = Schema.Struct({
  protocol: Schema.Literal("modbus-tcp"),
  id: Slug,
  host: Schema.String,
  port: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
    Schema.withDecodingDefaultKey(Effect.succeed(502))
  ),
  /** One byte on the wire (MBAP unit identifier); 255 or 1 for a plain TCP device, the slave id behind a bridge. */
  unitId: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
    Schema.withDecodingDefaultKey(Effect.succeed(1))
  ),
  pollIntervalMs,
  points: Schema.Array(ModbusPoint)
})
export type ModbusDevice = typeof ModbusDevice.Type

export const BacnetDevice = Schema.Struct({
  protocol: Schema.Literal("bacnet-ip"),
  id: Slug,
  /** 22 bits on the wire (ASHRAE 135, clause 12.11.1); 4,194,303 means "any device". */
  deviceInstance: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 4_194_302 }))),
  /** Optional fixed address; otherwise discovered with Who-Is. */
  address: Schema.optionalKey(Schema.String),
  /** Use change-of-value subscriptions where the device supports them. */
  cov: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  pollIntervalMs,
  points: Schema.Array(BacnetPoint)
})
export type BacnetDevice = typeof BacnetDevice.Type

export const SimulatorDevice = Schema.Struct({
  protocol: Schema.Literal("simulator"),
  id: Slug,
  pollIntervalMs,
  points: Schema.Array(SimulatedPoint)
})
export type SimulatorDevice = typeof SimulatorDevice.Type

export const Device = Schema.Union([ModbusDevice, BacnetDevice, SimulatorDevice])
export type Device = typeof Device.Type

export const MqttSettings = Schema.Struct({
  url: Schema.String,
  clientId: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
  /** Name of the environment variable holding the password. Never inline secrets. */
  passwordEnv: Schema.optionalKey(Schema.String)
})
export type MqttSettings = typeof MqttSettings.Type

export const BufferSettings = Schema.Struct({
  /** SQLite file used for store-and-forward. */
  path: Schema.String,
  /** Rows kept before the oldest are dropped (default 1,000,000). */
  maxRows: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(1)),
    Schema.withDecodingDefaultKey(Effect.succeed(1_000_000))
  )
})
export type BufferSettings = typeof BufferSettings.Type

export const GatewayConfig = Schema.Struct({
  site: Slug,
  building: Slug,
  /** This gateway within the building (default `main`). Its health topic is `site/building/$gateway/<id>/health`. */
  id: Slug.pipe(Schema.withDecodingDefaultKey(Effect.succeed("main"))),
  /** How often the retained health message is refreshed (default 60 s). */
  healthIntervalMs: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1_000, maximum: 3_600_000 })),
    Schema.withDecodingDefaultKey(Effect.succeed(60_000))
  ),
  mqtt: MqttSettings,
  buffer: Schema.optionalKey(BufferSettings),
  devices: Schema.Array(Device)
})
export type GatewayConfig = typeof GatewayConfig.Type

/** Decode and validate a config from a JSON string. */
export const parseConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayConfig))
