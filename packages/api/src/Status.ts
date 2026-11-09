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
  /** How often the gateway reads it, from the config. */
  pollIntervalMs: Schema.Number,
  /** Why the device is failing (the health topic's reason). */
  reason: Schema.optionalKey(Schema.String),
  lastSuccess: Schema.optionalKey(Schema.Number),
  /** How many points the config gives it, also when `points` is left out (`/api/status?points=none`). */
  pointCount: Schema.Number,
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

/** The gateway process and its machine, from the last sample of the host monitor (every 15 s). */
export const HostStatus = Schema.Struct({
  version: Schema.String,
  node: Schema.String,
  /** Resident memory and V8 heap in use, in bytes. */
  memoryBytes: Schema.Number,
  heapBytes: Schema.Number,
  /** Share of one CPU core since the previous sample, in percent. */
  cpuPercent: Schema.Number,
  /** The worst event-loop delay of the last minute, in ms. */
  eventLoopLagMs: Schema.Struct({ p99: Schema.Number, max: Schema.Number }),
  /** Wall-clock steps (NTP setting the time) since the gateway started. */
  clockSteps: Schema.Number,
  openFds: Schema.optionalKey(Schema.Number),
  temperatureC: Schema.optionalKey(Schema.Number),
  /**
   * Raspberry Pi power and thermal conditions; absent off a Pi. `now` is any seen in the last four samples (about a
   * minute). `watched` is what the Pi lets the gateway see: all four conditions on kernels that still expose the
   * firmware's mask, under-voltage alone on newer ones (the Raspberry Pi kernel dropped the mask in 6.12, in March 2025).
   */
  throttled: Schema.optionalKey(
    Schema.Struct({ now: Schema.Array(Schema.String), watched: Schema.Array(Schema.String) })
  ),
  /** Free space on the outbox's filesystem, in bytes. */
  diskFreeBytes: Schema.optionalKey(Schema.Number)
})
export type HostStatus = typeof HostStatus.Type

/**
 * The latest message the gateway published on one topic under its site and building: values, `$meta`, health and
 * command results. What a subscriber to `site/building/#` would see, kept on the gateway so the page can show it.
 */
export const MessageStatus = Schema.Struct({
  topic: Schema.String,
  /** The payload, cut to its first 2,000 characters (`truncated` says so). */
  payload: Schema.String,
  truncated: Schema.Boolean,
  /** Retained: the broker keeps it and hands it to every subscriber that connects later. */
  retained: Schema.Boolean,
  /** Unix ms of the latest message on this topic, from the gateway's wall clock. */
  at: Schema.Number,
  /** Messages on this topic since the gateway started. */
  count: Schema.Number
})
export type MessageStatus = typeof MessageStatus.Type

/** What the broker allowed when the gateway connected (its CONNACK). */
export const BrokerConnection = Schema.Struct({
  protocolVersion: Schema.Literals(["5", "3.1.1"]),
  maximumQoS: Schema.Literals([0, 1]),
  retainAvailable: Schema.Boolean,
  /** Seconds between pings, the broker's if it set one. */
  keepAliveSeconds: Schema.Number,
  /** Unacknowledged QoS 1 publishes the gateway allows itself. */
  receiveMaximum: Schema.Number,
  /** Bytes; absent when the broker announced no limit. */
  maximumPacketSize: Schema.optionalKey(Schema.Number)
})
export type BrokerConnection = typeof BrokerConnection.Type

/** The broker connection and what went through it since the gateway started. */
export const BrokerStatus = Schema.Struct({
  url: Schema.String,
  connected: Schema.Boolean,
  /** Unix ms of the latest successful connect, and what the broker allowed then; absent before the first. */
  connectedAt: Schema.optionalKey(Schema.Number),
  connection: Schema.optionalKey(BrokerConnection),
  /** Successful connects (the first one and every reconnect), and attempts that failed or the broker refused. */
  connects: Schema.Number,
  failedConnects: Schema.Number,
  /** Point values published, and messages that could not be published (without a buffer, those are lost). */
  published: Schema.Number,
  publishFailures: Schema.Number
})
export type BrokerStatus = typeof BrokerStatus.Type

/**
 * The store-and-forward buffer. `rows` wait for the broker, out of `maxRows`. Since the gateway started: `written`
 * messages went into it, `delivered` came out to the broker, and `dropped` were given up on, by reason in
 * `droppedBy` (`overflow` past `maxRows`, `rejected` by the broker, `unreadable`, `undeliverable`, `lost`).
 * `failures` counts disk operations that failed; `disabled` means it could not be used and values go straight to the
 * broker.
 */
export const BufferStatus = Schema.Struct({
  path: Schema.String,
  rows: Schema.Number,
  maxRows: Schema.Number,
  dropped: Schema.Number,
  written: Schema.Number,
  delivered: Schema.Number,
  droppedBy: Schema.Record(Schema.String, Schema.Number),
  failures: Schema.Number,
  disabled: Schema.Boolean
})
export type BufferStatus = typeof BufferStatus.Type

export const GatewayStatus = Schema.Struct({
  site: Schema.String,
  building: Schema.String,
  id: Schema.String,
  /** Unix ms when the gateway started, and when this snapshot was taken. */
  since: Schema.Number,
  now: Schema.Number,
  broker: BrokerStatus,
  /** Absent without a `buffer` in the config. */
  buffer: Schema.optionalKey(BufferStatus),
  /** Absent until the host monitor's first sample. */
  host: Schema.optionalKey(HostStatus),
  devices: Schema.Array(DeviceStatus),
  /** The most recent commands, newest first. */
  commands: Schema.Array(CommandStatus)
})
export type GatewayStatus = typeof GatewayStatus.Type

/** One point's last read, by its key: absent `value` and `ts` mean nothing read since the gateway started. */
export const PointReading = Schema.Struct({
  device: Schema.String,
  point: Schema.String,
  value: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Boolean])),
  ts: Schema.optionalKey(Schema.Number)
})
export type PointReading = typeof PointReading.Type

/**
 * The last reads of the points asked for, in the order asked; points the config does not have are left out. For a
 * page that shows some of many points: `/api/status` carries every point's value, a megabyte at 10,000 points.
 */
export const PointReadings = Schema.Struct({ readings: Schema.Array(PointReading) })
export type PointReadings = typeof PointReadings.Type

/** How many points one `/api/values` request may name. */
export const MAX_VALUES_PER_REQUEST = 500

/**
 * Asked for more than `MAX_VALUES_PER_REQUEST` points. A key that names no configured point (or is not `device/point`)
 * is not an error: it is left out of the answer, like a point not read yet.
 */
export class ValuesQueryInvalid extends Schema.TaggedError<ValuesQueryInvalid>()(
  "ValuesQueryInvalid",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

/** The latest message per topic, sorted by topic; a separate endpoint, so the page asks only while it shows them. */
export const Messages = Schema.Struct({
  messages: Schema.Array(MessageStatus),
  /** Topics left out because the gateway keeps at most this many. */
  droppedTopics: Schema.Number
})
export type Messages = typeof Messages.Type

/**
 * A configured point as the points page lists it: what it is, where it comes from and how its values go out. Taken
 * from the config, so it changes only when the gateway restarts; values come with `/api/values`.
 */
export const PointInfo = Schema.Struct({
  device: Schema.String,
  id: Schema.String,
  name: Schema.String,
  unit: Schema.optionalKey(Schema.String),
  writable: Schema.Boolean,
  /** The MQTT topic its values go to (`site/building/device/point`). */
  topic: Schema.String,
  /** Where the gateway reads it, in the config's words: `holding 40 · float32 CDAB`, `analog-input 3 · present-value`. */
  source: Schema.String,
  /** How its values go out: `every read`, `on change ≥ 0.5`, `aggregate every 15 min`. */
  publish: Schema.String,
  limits: Schema.optionalKey(Schema.Struct({ min: Schema.Number, max: Schema.Number })),
  scaling: Schema.optionalKey(Schema.Struct({ factor: Schema.Number, offset: Schema.Number })),
  brick: Schema.optionalKey(Schema.String),
  haystack: Schema.optionalKey(Schema.Array(Schema.String))
})
export type PointInfo = typeof PointInfo.Type

/** Every configured point, in config order: device by device. */
export const PointCatalog = Schema.Struct({ points: Schema.Array(PointInfo) })
export type PointCatalog = typeof PointCatalog.Type

/** One bucket of a point's history: what its reads in `[t, t + stepMs)` were. Booleans count as 0 and 1. */
export const HistoryBucket = Schema.Struct({
  t: Schema.Number,
  min: Schema.Number,
  max: Schema.Number,
  avg: Schema.Number,
  count: Schema.Number
})
export type HistoryBucket = typeof HistoryBucket.Type

/**
 * A point's history between `from` and `to` (Unix ms), in buckets of `stepMs`, oldest first; buckets without a
 * read are left out. `resolution` says where it came from: every read (the last day) or per-minute rollups.
 */
export const HistorySeries = Schema.Struct({
  device: Schema.String,
  point: Schema.String,
  from: Schema.Number,
  to: Schema.Number,
  stepMs: Schema.Number,
  resolution: Schema.Literals(["read", "minute"]),
  buckets: Schema.Array(HistoryBucket)
})
export type HistorySeries = typeof HistorySeries.Type

/** The gateway keeps no history: none configured, or its file could not be opened. */
export class HistoryUnavailable extends Schema.TaggedError<HistoryUnavailable>()(
  "HistoryUnavailable",
  { message: Schema.String },
  { httpApiStatus: 404 }
) {}

/** Asked for a device or point the config does not have, or a range that ends before it starts. */
export class HistoryQueryInvalid extends Schema.TaggedError<HistoryQueryInvalid>()(
  "HistoryQueryInvalid",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

/** One setting: its key in the config file and its value as the file has it (defaults filled in). */
export const ConfigEntry = Schema.Struct({ key: Schema.String, value: Schema.Json })
export type ConfigEntry = typeof ConfigEntry.Type

/**
 * The running config, for reading: the top-level settings as the `gateway` section, then one section per block
 * (`mqtt`, `buffer`, `history`, `status`, and `bacnet` when a device uses it), and each device without its points
 * (the Points tab has those), its `publish` mode in words. It holds no secret: the broker password is only named by
 * `passwordEnv`.
 */
export const ConfigView = Schema.Struct({
  sections: Schema.Array(Schema.Struct({ key: Schema.String, entries: Schema.Array(ConfigEntry) })),
  devices: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      protocol: Schema.String,
      pointCount: Schema.Number,
      entries: Schema.Array(ConfigEntry)
    })
  )
})
export type ConfigView = typeof ConfigView.Type

export class StatusGroup extends HttpApiGroup.make("status")
  .add(
    HttpApiEndpoint.get("status", "/api/status", {
      query: {
        /** `none` leaves each device's `points` empty: health without every value, for a page that pages them. */
        points: Schema.optional(Schema.Literals(["all", "none"]))
      },
      success: GatewayStatus
    })
  )
  .add(
    HttpApiEndpoint.get("values", "/api/values", {
      query: {
        /** Comma-separated `device/point` keys (ids are slugs, so neither has a comma or a slash). */
        points: Schema.String
      },
      success: PointReadings,
      error: ValuesQueryInvalid
    })
  )
  .add(HttpApiEndpoint.get("messages", "/api/messages", { success: Messages }))
  .add(HttpApiEndpoint.get("points", "/api/points", { success: PointCatalog }))
  .add(HttpApiEndpoint.get("config", "/api/config", { success: ConfigView }))
  .add(
    HttpApiEndpoint.get("history", "/api/history", {
      query: {
        device: Schema.String,
        point: Schema.String,
        /** Unix ms; the last hour unless given. */
        from: Schema.optional(Schema.FiniteFromString),
        to: Schema.optional(Schema.FiniteFromString),
        /** About how many buckets to return (default 300, at most 2,000). */
        buckets: Schema.optional(Schema.FiniteFromString)
      },
      success: HistorySeries,
      error: [HistoryUnavailable, HistoryQueryInvalid]
    })
  ) {}

export class OtGatewayApi extends HttpApi.make("ot-gateway").add(StatusGroup) {}
