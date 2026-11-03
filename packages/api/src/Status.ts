/**
 * The status API: one read-only snapshot of the gateway, for the local status
 * page (apps/web) and anything else on the LAN that wants it. Schemas, not
 * types, so the gateway encodes and the browser decodes the same contract.
 * Commands are not here on purpose: they go through MQTT and the command guard.
 */
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

/** A point as the page shows it: its last published value, if any since the gateway started. */
export const PointStatus = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  unit: Schema.optionalKey(Schema.String),
  writable: Schema.Boolean,
  value: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Boolean])),
  /** Unix ms of the reading, from the gateway's wall clock. */
  ts: Schema.optionalKey(Schema.Number)
})
export type PointStatus = typeof PointStatus.Type

export const DeviceStatus = Schema.Struct({
  id: Schema.String,
  protocol: Schema.Literals(["modbus-tcp", "bacnet-ip", "simulator"]),
  status: Schema.Literals(["starting", "ok", "failing"]),
  /** Why the device is failing (the health topic's reason). */
  reason: Schema.optionalKey(Schema.String),
  lastSuccess: Schema.optionalKey(Schema.Number),
  points: Schema.Array(PointStatus)
})
export type DeviceStatus = typeof DeviceStatus.Type

/** One command and what became of it. */
export const CommandStatus = Schema.Struct({
  at: Schema.Number,
  device: Schema.String,
  point: Schema.String,
  status: Schema.Literals(["written", "rejected", "failed"]),
  reason: Schema.optionalKey(Schema.String)
})
export type CommandStatus = typeof CommandStatus.Type

export const GatewayStatus = Schema.Struct({
  site: Schema.String,
  building: Schema.String,
  id: Schema.String,
  /** Unix ms when the gateway started, and when this snapshot was taken. */
  since: Schema.Number,
  now: Schema.Number,
  broker: Schema.Struct({ url: Schema.String, connected: Schema.Boolean }),
  /** Absent without a `buffer` in the config. */
  buffer: Schema.optionalKey(Schema.Struct({ path: Schema.String, rows: Schema.Number })),
  devices: Schema.Array(DeviceStatus),
  /** The most recent commands, newest first. */
  commands: Schema.Array(CommandStatus)
})
export type GatewayStatus = typeof GatewayStatus.Type

export class StatusGroup extends HttpApiGroup.make("status").add(
  HttpApiEndpoint.get("status", "/api/status", { success: GatewayStatus })
) {}

export class PlenumApi extends HttpApi.make("plenum").add(StatusGroup) {}
