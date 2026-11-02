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

/**
 * How long one polling cycle (reading the device, retries included, and
 * publishing its values) may take before it is abandoned as hung. Optional:
 * the default depends on `pollIntervalMs` (see `cycleTimeoutMs`), so it
 * cannot be a decoding default.
 */
const cycleTimeoutMsField = Schema.optionalKey(
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1_000, maximum: 86_400_000 })))
)

/** The default cycle deadline: twice the poll interval, and at least the interval plus 30 s. */
export const defaultCycleTimeoutMs = (intervalMs: number): number =>
  Math.max(2 * intervalMs, intervalMs + 30_000)

/** A device's cycle deadline: its `cycleTimeoutMs`, or the default for its poll interval. */
export const cycleTimeoutMs = (device: { readonly pollIntervalMs: number; readonly cycleTimeoutMs?: number }) =>
  device.cycleTimeoutMs ?? defaultCycleTimeoutMs(device.pollIntervalMs)

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
  cycleTimeoutMs: cycleTimeoutMsField,
  points: Schema.Array(ModbusPoint)
})
export type ModbusDevice = typeof ModbusDevice.Type

const octet = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)"
const ipv4 = `${octet}(\\.${octet}){3}`

/** A dotted IPv4 address. BACnet/IP is IPv4 only (Annex J). */
const Ipv4Address = Schema.String.pipe(Schema.check(Schema.isPattern(new RegExp(`^${ipv4}$`))))

/** A UDP or TCP port, 1 to 65535. */
const port = "(6553[0-5]|655[0-2]\\d|65[0-4]\\d\\d|6[0-4]\\d{3}|[1-5]\\d{4}|[1-9]\\d{0,3})"

/** An IPv4 address, optionally with a port: `192.168.1.20` or `192.168.1.20:47809`. */
const Ipv4Endpoint = Schema.String.pipe(Schema.check(Schema.isPattern(new RegExp(`^${ipv4}(:${port})?$`))))

export const BacnetDevice = Schema.Struct({
  protocol: Schema.Literal("bacnet-ip"),
  id: Slug,
  /** 22 bits on the wire (ASHRAE 135, clause 12.11.1); 4,194,303 means "any device". */
  deviceInstance: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 4_194_302 }))),
  /**
   * Fixed IPv4 address, with the port if it is not 47808. Without it the
   * device is found by broadcasting Who-Is; with it, Who-Is goes to that
   * address only (to learn the largest request the device accepts).
   */
  address: Schema.optionalKey(Ipv4Endpoint),
  /** Use change-of-value subscriptions where the device supports them. */
  cov: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  pollIntervalMs,
  cycleTimeoutMs: cycleTimeoutMsField,
  points: Schema.Array(BacnetPoint)
})
export type BacnetDevice = typeof BacnetDevice.Type

export const SimulatorDevice = Schema.Struct({
  protocol: Schema.Literal("simulator"),
  id: Slug,
  pollIntervalMs,
  cycleTimeoutMs: cycleTimeoutMsField,
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

/** The gateway's own BACnet/IP endpoint, shared by every `bacnet-ip` device. */
export const BacnetSettings = Schema.Struct({
  /**
   * Local IPv4 address to bind (default `0.0.0.0`, every interface). On
   * Linux a socket bound to one address does not receive broadcasts, so
   * devices that answer Who-Is with a broadcast I-Am are only found with
   * the default.
   */
  bindAddress: Ipv4Address.pipe(Schema.withDecodingDefaultKey(Effect.succeed("0.0.0.0"))),
  /**
   * This gateway's UDP port (default 47808, `0xBAC0`). Devices broadcast
   * I-Am to 47808, so on another port (to share the host with other BACnet
   * software) the gateway only hears devices that answer it directly.
   */
  port: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
    Schema.withDecodingDefaultKey(Effect.succeed(47_808))
  ),
  /**
   * Where Who-Is goes: the subnet's broadcast address, e.g. `192.168.1.255`,
   * port 47808 unless given (default `255.255.255.255`, which leaves through
   * the default route's interface only).
   */
  broadcastAddress: Ipv4Endpoint.pipe(Schema.withDecodingDefaultKey(Effect.succeed("255.255.255.255"))),
  /** How long to wait for an answer before resending (default 3 s). */
  requestTimeoutMs: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 100, maximum: 60_000 })),
    Schema.withDecodingDefaultKey(Effect.succeed(3_000))
  ),
  /** How often a request is resent after a timeout (default 2). */
  retries: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
    Schema.withDecodingDefaultKey(Effect.succeed(2))
  )
})
export type BacnetSettings = typeof BacnetSettings.Type

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
  bacnet: BacnetSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  devices: Schema.Array(Device)
})
export type GatewayConfig = typeof GatewayConfig.Type

/** Decode and validate a config from a JSON string. */
export const parseConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayConfig))
