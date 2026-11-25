/**
 * The status API: one read-only snapshot of the gateway, for the local status
 * page (apps/web) and anything else on the LAN that wants it. Schemas, not
 * types, so the gateway encodes and the browser decodes the same contract.
 * Commands are not here on purpose: they go through MQTT and the command guard.
 */
import { Effect, Schema, SchemaGetter } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { ConfigEditGroup } from "./Editor.ts"
import { LogsGroup } from "./Logs.ts"
import { SetupGroup } from "./Setup.ts"
import { preciseDuration } from "./SharedCause.ts"

/** A point as the page shows it: its last published value, if any since the gateway started. */
export const PointStatus = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  unit: Schema.optionalKey(Schema.String),
  writable: Schema.Boolean,
  value: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Boolean])),
  /** Unix ms of the reading, from the gateway's wall clock. */
  ts: Schema.optionalKey(Schema.Number),
  /** The point is an alarm, active when its value is on or off (`effectiveAlarmWhen`: `alarmWhen`, else semantics). */
  alarmWhen: Schema.optionalKey(Schema.Literals(["on", "off"])),
  /** For an alarm point that has been read: whether its alarm is active now. */
  alarmActive: Schema.optionalKey(Schema.Boolean)
})
export type PointStatus = typeof PointStatus.Type

export const DeviceStatus = Schema.Struct({
  id: Schema.String,
  protocol: Schema.Literals(["modbus-tcp", "bacnet-ip", "simulator"]),
  status: Schema.Literals(["starting", "ok", "failing"]),
  /** How often the gateway reads it, from the config. */
  pollIntervalMs: Schema.Number,
  /**
   * Why the device is failing, as a class (the health topic's reason): `connection`, `timeout`, `protocol`,
   * `invalid-response`, `configuration`, `not-implemented`, `cycle-timeout` or `crashed`.
   */
  reason: Schema.optionalKey(Schema.String),
  /** Unix ms of the first failure of the current run, while `failing`: it has failed since then without a read. */
  failingSince: Schema.optionalKey(Schema.Number),
  /**
   * The latest failure in one line, from the driver's typed error, while `failing`: `could not connect: connection
   * refused by 127.0.0.1:5020`, `no reply from 127.0.0.1:5020 unit 1 within 3 s (4 item(s) asked)`. It names
   * addresses, never credentials.
   * After the device recovers, `/api/events` still has it.
   */
  lastError: Schema.optionalKey(Schema.String),
  /** Failed polling cycles in a row, while `failing` (the retries inside one cycle count once). */
  failures: Schema.optionalKey(Schema.Number),
  /**
   * Unix ms when the reads of the device's last successful polling cycle came back (recorded once their values were
   * handled). A point's `ts` can be newer: a change-of-value notification or a pushed value arrives between cycles.
   * It stays while the device fails, so it says when the device last answered in full.
   */
  lastSuccess: Schema.optionalKey(Schema.Number),
  /**
   * The host the gateway reads it at, from the config: a Modbus device's `host`, a BACnet device's fixed `address`
   * without its port. Absent for a BACnet device found by broadcast and for a simulator. Devices that fail together
   * on one host point at that host (its power, its network link) rather than at a switch on the way.
   */
  host: Schema.optionalKey(Schema.String),
  /** How many points the config gives it, also when `points` is left out (`/api/status?points=none`). */
  pointCount: Schema.Number,
  points: Schema.Array(PointStatus)
})
export type DeviceStatus = typeof DeviceStatus.Type

/** A device counts as late once this many poll intervals pass without a read, and never sooner than `LATE_MIN_MS`. */
const LATE_INTERVALS = 3
const LATE_MIN_MS = 15_000

/**
 * Whether an `ok` device is late at `now`: no read for a few poll intervals although the gateway has not marked it
 * failing (a stalled cycle, before it passes its deadline). The status page and `ot-gateway status` share it.
 */
export const isDeviceLate = (device: DeviceStatus, now: number) =>
  device.status === "ok" &&
  (device.lastSuccess === undefined || now - device.lastSuccess > lateAfterMs(device.pollIntervalMs))

/** How long a read may be missing before it counts as late: a few poll intervals, and never under 15 s. */
export const lateAfterMs = (pollIntervalMs: number) => Math.max(LATE_INTERVALS * pollIntervalMs, LATE_MIN_MS)

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
  /**
   * Messages the gateway published on this topic since it started: every one it handed on, also while the broker was
   * down (then into the buffer, or not sent).
   */
  count: Schema.Number,
  /**
   * Of those, and of ones the buffer kept from before a restart, how many reached the broker: QoS 1 acknowledged by
   * it, QoS 0 written to its connection. Absent from a gateway before v0.13, which did not count it: how many reached
   * the broker is then not known.
   */
  delivered: Schema.optionalKey(Schema.Number),
  /**
   * Of `count`, retained messages (health, `$meta`) not sent because the broker was away. They are never buffered:
   * the gateway sends the latest again when it reconnects, so nothing is missing. Absent from an older gateway.
   */
  notSent: Schema.optionalKey(Schema.Number),
  /**
   * Of `count`, messages not sent and kept nowhere: a value without a buffer or one the buffer could not store, a
   * command result, or a message the broker refused. Absent from an older gateway.
   *
   * The rest, `count - delivered - notSent - lost`, was taken on and has not reached the broker yet: it waits in the
   * buffer (or was dropped by it, counted in the status's `buffer.droppedBy`), or is on its way right now.
   */
  lost: Schema.optionalKey(Schema.Number)
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
  /**
   * Unix ms since when the gateway has had no broker connection, while not `connected`: when the connection was
   * lost, or the gateway's start when it has not connected yet and a dial has failed.
   */
  disconnectedSince: Schema.optionalKey(Schema.Number),
  /** Why, in one line, while not `connected`: the lost connection's or the latest failed dial's reason. */
  lastError: Schema.optionalKey(Schema.String),
  /**
   * Since the gateway started: successful connects (the first one and every reconnect), and dials that failed
   * (unreachable, timed out) or that the broker refused (bad credentials, say). A broker that stays down adds a
   * failed dial every 15 s at most; a connection that is lost and comes back adds one to `connects` only.
   */
  connects: Schema.Number,
  failedConnects: Schema.Number,
  /**
   * Point values the gateway sent on since it started: to the broker, or into the buffer while the broker was away.
   * Values only, and not "reached the broker": `/api/messages` counts that per topic (`delivered`), `$meta` and
   * health included. `publishFailures`: publishes that failed with nothing keeping the message: health and `$meta`
   * while the broker was away (retained, not buffered: the latest goes out again on reconnect), values without a
   * buffer or that it could not store, and messages the broker refused. Not a loss count: a failed polling cycle or
   * `$meta` batch counts once, and the retained ones are sent again; `/api/messages` has `notSent` and `lost` per
   * message.
   */
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

/**
 * How a flapping alarm point switched, from its last 16 changes: on for `onMs` and off for `offMs` on average,
 * raised `raised` times over the last `overMs`. An average is absent when no such stretch ended yet.
 */
export const AlarmPattern = Schema.Struct({
  onMs: Schema.optionalKey(Schema.Number),
  offMs: Schema.optionalKey(Schema.Number),
  raised: Schema.Number,
  overMs: Schema.Number
})
export type AlarmPattern = typeof AlarmPattern.Type

/**
 * An alarm point (`effectiveAlarmWhen`: one with `alarmWhen`, or semantics that say alarm) as the gateway sees it now.
 * `alarmWhen` is its effective polarity. `raised` counts how often its alarm became active
 * in the last `ALARM_WINDOW_MS` (15 min), so a contact that toggles shows up even while it happens to be off.
 */
export const AlarmStatus = Schema.Struct({
  device: Schema.String,
  point: Schema.String,
  alarmWhen: Schema.Literals(["on", "off"]),
  /** Whether the alarm is active; absent before the point's first read. */
  active: Schema.optionalKey(Schema.Boolean),
  /** Unix ms since when it has been as it is (active or not): its last change, or its first read. */
  since: Schema.optionalKey(Schema.Number),
  /** Times the alarm was raised in the last 15 minutes. */
  raised: Schema.Number,
  /** It changes too often to list each change in the events: they are counted until it is steady again. */
  flapping: Schema.Boolean,
  /** While it flaps: how long it stays on and off, how often it was raised. */
  pattern: Schema.optionalKey(AlarmPattern)
})
export type AlarmStatus = typeof AlarmStatus.Type

/** The window the alarm counts (`raised`) and the alarm events' rate limit look back over: 15 minutes. */
export const ALARM_WINDOW_MS = 15 * 60_000

const gatewayStatusFields = {
  site: Schema.String,
  building: Schema.String,
  id: Schema.String,
  /** Unix ms when the gateway started, and when this snapshot was taken. */
  since: Schema.Number,
  now: Schema.Number,
  /**
   * Unix ms when the running config started: the gateway's start, or a later save on the Settings tab. What the page
   * keeps of the config (`/api/config`, `/api/points`) is current while this stays the same.
   */
  configSince: Schema.Number,
  broker: BrokerStatus,
  /** Absent without a `buffer` in the config. */
  buffer: Schema.optionalKey(BufferStatus),
  /**
   * Absent until the host monitor's first sample, taken as the gateway starts. Its `version` is the gateway's: the CLI
   * reads it to tell an older gateway (`gatewayRelease`).
   */
  host: Schema.optionalKey(HostStatus),
  devices: Schema.Array(DeviceStatus),
  /** Every alarm point of the config (`effectiveAlarmWhen`), in config order, also with `points=none`, unless `alarms=none` is asked. */
  alarms: Schema.optionalKey(Schema.Array(AlarmStatus)),
  /** The most recent commands, newest first. */
  commands: Schema.Array(CommandStatus)
}

/**
 * The gateway's status. A gateway sends every field; one of the previous minor release (v0.12) sends no
 * `configSince`, which then reads as `since`: it could not change its config while running, so its config started
 * with it. The CLI reads gateways one release older (docs/operations.md); `apps/gateway/test/fixtures/v0.12.0` keeps
 * their answers.
 */
export const GatewayStatus = Schema.Struct({
  ...gatewayStatusFields,
  configSince: Schema.optionalKey(Schema.Number)
}).pipe(
  Schema.decodeTo(Schema.toType(Schema.Struct(gatewayStatusFields)), {
    decode: SchemaGetter.transform((status) => ({ ...status, configSince: status.configSince ?? status.since })),
    encode: SchemaGetter.passthroughSupertype()
  })
)
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
  droppedTopics: Schema.Number,
  /**
   * Present in an answer for a window (`/api/messages/window`): the counts then run from `from` to `to` (Unix ms)
   * instead of since the gateway started, and only topics with a message published or delivered in it are listed.
   */
  window: Schema.optionalKey(Schema.Struct({ from: Schema.Number, to: Schema.Number }))
})
export type Messages = typeof Messages.Type

/** What a topic carries: a point's value, its `$meta`, the gateway's health, a command's result, or something else. */
export type TopicKind = "value" | "metadata" | "health" | "command result" | "other"

/** The kind of a full topic (`site/building/device/point`, `…/$meta`, `…/$gateway/<id>/health`, `…/$set/result`). */
export const topicKind = (topic: string): TopicKind => {
  const parts = topic.split("/")
  if (parts[2] === "$gateway" && parts[4] === "health") return "health"
  if (parts.length === 4) return "value"
  if (parts.length === 5 && parts[4] === "$meta") return "metadata"
  if (parts.length === 6 && parts[4] === "$set" && parts[5] === "result") return "command result"
  return "other"
}

/** Messages of a list of topics added up: by kind, all of them, and what became of them. */
export interface MessageTotals {
  readonly values: number
  readonly meta: number
  readonly health: number
  /** Command results and any other topic. */
  readonly other: number
  readonly all: number
  /** Reached the broker; undefined when a topic's count of it is not known (a gateway before v0.13). */
  readonly delivered: number | undefined
  /** Taken on, not at the broker yet: in the buffer (or dropped by it), or on its way. 0 when not known. */
  readonly waiting: number
  /** Retained messages not sent while the broker was away; the latest goes out again on reconnect. */
  readonly notSent: number
  /** Not sent and kept nowhere. */
  readonly lost: number
}

/**
 * What became of one topic's messages that did not reach the broker (`MessageStatus`'s fields, filled in). Without
 * `delivered` (a gateway before v0.13) nothing is known to be waiting.
 */
export const messageShortfall = (message: MessageStatus) => {
  const notSent = message.notSent ?? 0
  const lost = message.lost ?? 0
  // Rows the buffer kept from before a restart can make `delivered` more than this run published.
  const waiting = message.delivered === undefined ? 0 : Math.max(0, message.count - message.delivered - notSent - lost)
  return { waiting, notSent, lost }
}

/** The totals of `messages` (`count` and `delivered` per topic), for `ot-gateway messages` and the Messages tab. */
export const messageTotals = (messages: ReadonlyArray<MessageStatus>): MessageTotals => {
  let values = 0
  let meta = 0
  let health = 0
  let other = 0
  let delivered: number | undefined = 0
  let waiting = 0
  let notSent = 0
  let lost = 0
  for (const message of messages) {
    const kind = topicKind(message.topic)
    if (kind === "value") values += message.count
    else if (kind === "metadata") meta += message.count
    else if (kind === "health") health += message.count
    else other += message.count
    delivered = delivered === undefined || message.delivered === undefined ? undefined : delivered + message.delivered
    const shortfall = messageShortfall(message)
    waiting += shortfall.waiting
    notSent += shortfall.notSent
    lost += shortfall.lost
  }
  return { values, meta, health, other, all: values + meta + health + other, delivered, waiting, notSent, lost }
}

/**
 * What did not reach the broker, in words, for `ot-gateway messages` and the Messages tab alike: `["12 waiting in
 * the buffer", "5 not sent while the broker was away: retained, not buffered, the latest goes out on reconnect"]`.
 * Empty when everything arrived. `buffer` is the status's buffer, absent without one: waiting messages are then
 * waiting for the broker, and once the buffer dropped any, a waiting one may be among them. `format` writes a count.
 */
export const shortfallWords = (
  shortfall: { readonly waiting: number; readonly notSent: number; readonly lost: number },
  buffer: { readonly dropped: number } | undefined,
  format: (count: number) => string = String
): ReadonlyArray<string> => [
  ...(shortfall.waiting > 0
    ? [
        buffer === undefined
          ? `${format(shortfall.waiting)} waiting for the broker`
          : buffer.dropped > 0
            ? `${format(shortfall.waiting)} waiting in the buffer or dropped by it`
            : `${format(shortfall.waiting)} waiting in the buffer`
      ]
    : []),
  ...(shortfall.notSent > 0
    ? [
        `${format(shortfall.notSent)} not sent while the broker was away: retained, not buffered, the latest goes out on reconnect`
      ]
    : []),
  ...(shortfall.lost > 0 ? [`${format(shortfall.lost)} lost: not sent, not buffered`] : [])
]

/**
 * How far back `/api/messages/window` can count: the gateway keeps a count per topic per minute for the last hour,
 * one small ring (about half a kilobyte) per topic it already keeps.
 */
export const MESSAGE_WINDOW_MINUTES = 60

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
  /**
   * How the gateway gets its values, as configured: `polled every 5 s`, or for a BACnet present value with `cov` on,
   * `on change of value where the device supports it, polled every 5 s otherwise`. Absent from a gateway before v0.13.
   */
  read: Schema.optionalKey(Schema.String),
  /**
   * Whether the gateway asks the device to send it on change of value (BACnet COV with `cov` on, a present value):
   * an old read is then the current value while the device answers, not a stale one. `read` says the same in words.
   * A gateway before v0.13 does not say: then `false`, so a stretch without reads shows as a gap rather than hiding one.
   */
  cov: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** How its values go out: `every read`, `on change ≥ 0.5`, `aggregate every 15 min`. */
  publish: Schema.String,
  limits: Schema.optionalKey(Schema.Struct({ min: Schema.Number, max: Schema.Number })),
  scaling: Schema.optionalKey(Schema.Struct({ factor: Schema.Number, offset: Schema.Number })),
  brick: Schema.optionalKey(Schema.String),
  haystack: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * The config's `alarmWhen`, as written: on (true, not 0) or off (false, 0). Whether the point is an alarm also
   * depends on `brick` and `haystack`: ask `effectiveAlarmWhen`.
   */
  alarmWhen: Schema.optionalKey(Schema.Literals(["on", "off"]))
})
export type PointInfo = typeof PointInfo.Type

/** Every configured point, in config order: device by device. */
export const PointCatalog = Schema.Struct({ points: Schema.Array(PointInfo) })
export type PointCatalog = typeof PointCatalog.Type

/**
 * One bucket of a point's history: what its reads in `[t, t + stepMs)` were. Booleans count as 0 and 1. `first`
 * and `last` (Unix ms) are when its first and last read came, so a gap between buckets is known to the
 * millisecond: from the `last` of the bucket before it to the `first` of the bucket after it. Absent from gateways
 * before they were added, and from per-minute rollups written before then.
 */
export const HistoryBucket = Schema.Struct({
  t: Schema.Number,
  min: Schema.Number,
  max: Schema.Number,
  avg: Schema.Number,
  count: Schema.Number,
  first: Schema.optionalKey(Schema.Number),
  last: Schema.optionalKey(Schema.Number)
})
export type HistoryBucket = typeof HistoryBucket.Type

/** A read whose value differs from the read before it: when a switch or an alarm changed. */
export const HistoryChange = Schema.Struct({ t: Schema.Number, value: Schema.Number })
export type HistoryChange = typeof HistoryChange.Type

/** How many changes a history answer lists at most; `truncated` says there were more. */
export const HISTORY_CHANGES_MAX = 200

/**
 * A point's history between `from` and `to` (Unix ms), in buckets of `stepMs`, oldest first; buckets without a
 * read are left out. Buckets start on whole multiples of `stepMs` (minute buckets on whole minutes), so `from` can
 * be up to a step before the `from` asked for. `resolution` says where it came from: every read (buckets under a minute, or a range of an
 * hour or less, that starts within the last day) or per-minute rollups (everything else). `changes`, when asked
 * for and the range starts within the last day: the first read and every read that changed the value, oldest
 * first, at most `HISTORY_CHANGES_MAX`. `live`: the answer holds the reads the gateway has not written to its file
 * yet, so it is complete up to `to` (gateways before it lagged up to 30 s, the interval of their writes).
 */
export const HistorySeries = Schema.Struct({
  device: Schema.String,
  point: Schema.String,
  from: Schema.Number,
  to: Schema.Number,
  stepMs: Schema.Number,
  resolution: Schema.Literals(["read", "minute"]),
  live: Schema.optionalKey(Schema.Boolean),
  buckets: Schema.Array(HistoryBucket),
  changes: Schema.optionalKey(Schema.Struct({ list: Schema.Array(HistoryChange), truncated: Schema.Boolean }))
})
export type HistorySeries = typeof HistorySeries.Type

/** A stretch between two reads shorter than this is never a gap, whatever the poll interval. */
export const READ_GAP_MIN_MS = 30_000

/** How many poll intervals two reads may be apart before the stretch between them is a gap. */
export const READ_GAP_INTERVALS = 3

/**
 * How long a point read every `pollIntervalMs` may go between two reads before the stretch is a gap: a few missed
 * polls, and never under `READ_GAP_MIN_MS`, so a slow read or one retry is no gap.
 */
export const readGapMs = (pollIntervalMs: number) => Math.max(READ_GAP_INTERVALS * pollIntervalMs, READ_GAP_MIN_MS)

/** A stretch between the reads of two buckets: `[from, to)`, and `before`, the `t` of the bucket after it. */
export interface ReadGap {
  readonly from: number
  readonly to: number
  readonly before: number
}

/**
 * The gaps between buckets that both have reads, which a count of empty buckets cannot see: a 93 s outage across a
 * minute boundary leaves both minutes with reads. Two buckets at most `apartMs` apart (from `t` to `t`; wider pairs
 * are the caller's empty-bucket gaps) whose reads are more than `minGapMs` apart, from the `last` of the one to the
 * `first` of the other, give `[last, first)`. Buckets without read times (older gateways and rollups) give none. A
 * gap inside one bucket stays unseen: a bucket keeps only its first and last read.
 */
export const readGaps = (
  buckets: ReadonlyArray<HistoryBucket>,
  options: { readonly apartMs: number; readonly minGapMs: number }
): ReadonlyArray<ReadGap> => {
  const gaps: Array<ReadGap> = []
  for (let index = 1; index < buckets.length; index++) {
    const previous = buckets[index - 1]
    const next = buckets[index]
    if (previous === undefined || next === undefined || next.t - previous.t > options.apartMs) continue
    if (previous.last === undefined || next.first === undefined) continue
    if (next.first - previous.last > options.minGapMs)
      gaps.push({ from: previous.last, to: next.first, before: next.t })
  }
  return gaps
}

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

/**
 * What every event has: `id` counts up from 1 since the gateway started (a page asks `after` the last it has),
 * `at` is Unix ms on the gateway's wall clock. Durations (`downMs`) are measured on a clock NTP does not step.
 */
const eventFields = { id: Schema.Number, at: Schema.Number }

/** The gateway process started (also after a restart by Docker or systemd: the ring starts empty). */
export const GatewayStartedEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("gateway-started"),
  version: Schema.String,
  devices: Schema.Number,
  /**
   * How the run before ended, when the gateway can tell (it keeps `ot-gateway-run.json` next to its outbox or
   * history): `started` Unix ms, and `stopped` after a clean stop (SIGTERM, Ctrl-C). Without `stopped` it ended
   * some other way: a crash, the power pulled, the kernel's OOM killer.
   */
  previousRun: Schema.optionalKey(Schema.Struct({ started: Schema.Number, stopped: Schema.optionalKey(Schema.Number) }))
})

/**
 * A device that read fine, or had not read yet, failed: `reason` is the class, `error` the driver's words.
 * `answeredBefore`: the device read fine earlier in this run, so its config worked. `lastReadAt`: Unix ms of its
 * last good polling cycle: the data stopped there, before `at`, when the gateway gave up on it.
 */
export const DeviceFailingEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("device-failing"),
  device: Schema.String,
  reason: Schema.String,
  error: Schema.String,
  answeredBefore: Schema.optionalKey(Schema.Boolean),
  lastReadAt: Schema.optionalKey(Schema.Number)
})

/**
 * A failing device read again, after `downMs` of failures, counted from when the gateway marked it failing
 * (`failingSince`, Unix ms). The outage as the data shows it runs from `lastReadAt` (its last good read before, Unix
 * ms) to `at`: `noDataMs` long, the span `ot-gateway history` shows too. These three are absent for a device that
 * had not read yet, and from gateways before they were added.
 */
export const DeviceRecoveredEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("device-recovered"),
  device: Schema.String,
  downMs: Schema.Number,
  lastReadAt: Schema.optionalKey(Schema.Number),
  failingSince: Schema.optionalKey(Schema.Number),
  noDataMs: Schema.optionalKey(Schema.Number)
})

/** The gateway lost its broker connection, or could not get one at start. Redials that fail too are not events. */
export const BrokerDisconnectedEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("broker-disconnected"),
  error: Schema.String
})

/**
 * The gateway connected to its broker. After an outage, `downMs` says how long it lasted, `retries` how many dials
 * failed during it (absent from older gateways) and `buffered` how many messages waited in the store-and-forward
 * buffer at the moment of the reconnect (absent without a buffer). Values read while the backlog goes out queue
 * behind it, so more can reach the broker from the buffer than `buffered` says: `buffer-drained` has that number.
 */
export const BrokerConnectedEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("broker-connected"),
  downMs: Schema.optionalKey(Schema.Number),
  retries: Schema.optionalKey(Schema.Number),
  buffered: Schema.optionalKey(Schema.Number)
})

/**
 * Every message the buffer kept during an outage reached the broker. `delivered` counts the messages that went from
 * the buffer to the broker since the broker came back: `buffered`, the ones waiting at the reconnect (as in
 * `broker-connected`), plus `queued`, the ones stored behind them meanwhile, less any the buffer dropped. Counted
 * from the reconnect, or from the last time it drained when it filled again on the same connection (`buffered` 0).
 * `buffered` and `queued` are absent from an older gateway.
 */
export const BufferDrainedEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("buffer-drained"),
  delivered: Schema.optionalKey(Schema.Number),
  buffered: Schema.optionalKey(Schema.Number),
  queued: Schema.optionalKey(Schema.Number)
})

/**
 * How a drained buffer's count adds up, from a `buffer-drained` event: the messages waiting at the reconnect, the
 * ones queued behind them, and the ones the buffer dropped meanwhile (overflow, refused, unreadable). Undefined when
 * the event has no such numbers or nothing waited at the reconnect, where `delivered` says it all.
 */
export const drainedParts = (event: {
  readonly delivered?: number
  readonly buffered?: number
  readonly queued?: number
}) => {
  if (event.delivered === undefined || event.buffered === undefined || event.queued === undefined) return undefined
  if (event.buffered === 0) return undefined
  return {
    buffered: event.buffered,
    queued: event.queued,
    dropped: Math.max(0, event.buffered + event.queued - event.delivered)
  }
}

/**
 * A config saved from the status page was applied without a restart: `summary` says what changed in a line
 * ("broker changed; device boiler added").
 */
export const ConfigAppliedEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("config-applied"),
  summary: Schema.String
})

/** A config saved from the status page did not start: `error` says why; the previous config runs again. */
export const ConfigApplyFailedEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("config-apply-failed"),
  error: Schema.String
})

/**
 * Another gateway is online in this building and publishes into this gateway's topics: it runs devices of the same
 * ids (`devices`), or (`sameId`) it has this gateway's own id. Their values mix on the broker.
 */
export const GatewayConflictEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("gateway-conflict"),
  gateway: Schema.String,
  devices: Schema.Array(Schema.String),
  sameId: Schema.Boolean
})

/**
 * An alarm point's alarm became active (its value turned on, or off for `alarmWhen: off`), or was active at its
 * first read (`first`), or at the first read after its device failed and answered again (`afterOutage`). The
 * latter is no new trip, since when it tripped is not known: it does not count in `raised` or in a flapping pattern.
 */
export const AlarmRaisedEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("alarm-raised"),
  device: Schema.String,
  point: Schema.String,
  value: Schema.Union([Schema.Number, Schema.Boolean]),
  first: Schema.optionalKey(Schema.Boolean),
  afterOutage: Schema.optionalKey(Schema.Boolean),
  /** With `afterOutage`: how long its state was unknown, from its last read before the outage to this one. */
  unknownMs: Schema.optionalKey(Schema.Number)
})

/**
 * An active alarm cleared, after `activeMs` (measured on a clock NTP does not step). `afterOutage`: it was found
 * off at the first read after its device failed and answered again, so when it cleared is not known.
 */
export const AlarmClearedEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("alarm-cleared"),
  device: Schema.String,
  point: Schema.String,
  value: Schema.Union([Schema.Number, Schema.Boolean]),
  activeMs: Schema.Number,
  afterOutage: Schema.optionalKey(Schema.Boolean),
  /** With `afterOutage`: how long its state was unknown, from its last read before the outage to this one. */
  unknownMs: Schema.optionalKey(Schema.Number)
})

/**
 * An alarm point changes too often to list each change: it was raised `raised` times in the last 15 minutes. Its
 * changes are counted, not listed, until it has kept still for `ALARM_SETTLE_MS`; then `alarm-settled` says how it
 * ended.
 */
export const AlarmFlappingEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("alarm-flapping"),
  device: Schema.String,
  point: Schema.String,
  raised: Schema.Number,
  /** How it switched up to now: on and off on average, how often over how long. */
  pattern: Schema.optionalKey(AlarmPattern)
})

/**
 * A flapping alarm point kept still for `ALARM_SETTLE_MS`: `active` is how it stays, since `since` (Unix ms), after
 * `unlisted` changes that were counted and not listed. Its changes are listed again from here.
 */
export const AlarmSettledEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("alarm-settled"),
  device: Schema.String,
  point: Schema.String,
  active: Schema.Boolean,
  since: Schema.Number,
  unlisted: Schema.Number,
  /** How it switched while it flapped, up to its last change. */
  pattern: Schema.optionalKey(AlarmPattern)
})

/** How long a flapping alarm point must keep still before `alarm-settled`, and its changes are listed again. */
export const ALARM_SETTLE_MS = 5 * 60_000

/** A transition worth knowing about later: what broke, since when, and when it came back. Never one per read. */
export const GatewayEvent = Schema.Union([
  GatewayStartedEvent,
  DeviceFailingEvent,
  DeviceRecoveredEvent,
  BrokerDisconnectedEvent,
  BrokerConnectedEvent,
  BufferDrainedEvent,
  ConfigAppliedEvent,
  ConfigApplyFailedEvent,
  GatewayConflictEvent,
  AlarmRaisedEvent,
  AlarmClearedEvent,
  AlarmFlappingEvent,
  AlarmSettledEvent
])
export type GatewayEvent = typeof GatewayEvent.Type

/**
 * An energy counter (a point in Wh, kWh, MWh or J, `isEnergyUnit`) went back from `from` to `to`, in its `unit`: a
 * meter that was reset or replaced, or another device answering at its address. The value is still published: this
 * is a warning, not a filter.
 */
export const CounterWentBackEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("counter-went-back"),
  device: Schema.String,
  point: Schema.String,
  unit: Schema.optionalKey(Schema.String),
  from: Schema.Number,
  to: Schema.Number
})

/**
 * An energy counter rose from `from` to `to` in `elapsedMs`, more than `COUNTER_RATE_FACTOR` times faster than the
 * fastest it rose over the last hour (`usualPerHour`, in its unit per hour), and by more than a minimum step: a meter
 * reset or replaced, or another device answering at its address. The value is still published. Without
 * `usualPerHour`, the gateway did not know the counter's pace yet (it had just started): the rise was more than
 * `COUNTER_EARLY_SHARE` of the reading itself within the hour, which no meter's reading does after its first day.
 */
export const CounterJumpedEvent = Schema.Struct({
  ...eventFields,
  type: Schema.Literal("counter-jumped"),
  device: Schema.String,
  point: Schema.String,
  unit: Schema.optionalKey(Schema.String),
  from: Schema.Number,
  to: Schema.Number,
  elapsedMs: Schema.Number,
  usualPerHour: Schema.optionalKey(Schema.Number)
})

/** How many times faster than its fastest rise of the last hour an energy counter may rise before it is a jump. */
export const COUNTER_RATE_FACTOR = 10

/** Before its pace is known, the share of its own reading an energy counter may rise by before it is a jump. */
export const COUNTER_EARLY_SHARE = 0.1

/**
 * How much a jump without a known pace rose, against the reading before it: "50 % of its reading", "1.1× its reading",
 * "12 % of its reading". The CLI and the status page say it alike.
 */
export const counterShareText = (from: number, to: number) => {
  const share = (to - from) / Math.abs(from)
  if (!Number.isFinite(share)) return "more than its whole reading"
  return share >= 1 ? `${Number(share.toFixed(1))}× its reading` : `${Math.round(share * 100)} % of its reading`
}

/**
 * What an alarm found changed after an outage was in between: "unknown during the 1 min
 * 33 s without data", or "unknown while its device had no data" from a gateway that does not say how long.
 */
export const unknownStateText = (unknownMs: number | undefined) =>
  unknownMs === undefined
    ? "unknown while its device had no data"
    : `unknown during the ${preciseDuration(unknownMs)} without data`

/**
 * An event about a point's values rather than the gateway: an energy counter that went back or jumped. Kept apart
 * from `GatewayEvent` (in `EventLog.valueEvents`), so clients that know only those keep decoding the answer.
 */
export const ValueEvent = Schema.Union([CounterWentBackEvent, CounterJumpedEvent])
export type ValueEvent = typeof ValueEvent.Type

/**
 * The gateway's recent events, oldest first. The gateway keeps the latest `capacity` in memory, since it started;
 * `dropped` counts the older ones it let go, so a gap is visible.
 */
export const EventLog = Schema.Struct({
  /** Unix ms on the gateway's clock when the answer was made, to read `at` against ("5 min ago") on any machine. */
  now: Schema.Number,
  events: Schema.Array(GatewayEvent),
  /**
   * The value events of the same ring, oldest first and filtered the same way: they share the ids and the capacity
   * with `events`. Absent from gateways before they were added.
   */
  valueEvents: Schema.optionalKey(Schema.Array(ValueEvent)),
  capacity: Schema.Number,
  dropped: Schema.Number
})
export type EventLog = typeof EventLog.Type

export class StatusGroup extends HttpApiGroup.make("status")
  .add(
    HttpApiEndpoint.get("status", "/api/status", {
      query: {
        /** `none` leaves each device's `points` empty: health without every value, for a page that pages them. */
        points: Schema.optional(Schema.Literals(["all", "none"])),
        /** `none` leaves out `alarms`: for the status page, which reads alarm values from `/api/values`. */
        alarms: Schema.optional(Schema.Literals(["all", "none"]))
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
  .add(
    HttpApiEndpoint.get("events", "/api/events", {
      query: {
        /** Unix ms: only events at or after it. */
        since: Schema.optional(Schema.FiniteFromString),
        /**
         * An event id: only the events after it, for a page that polls for what is new. An id the gateway has not
         * given yet means it restarted (its ids start over at 1): then every event it keeps.
         */
        after: Schema.optional(Schema.FiniteFromString)
      },
      success: EventLog
    })
  )
  .add(HttpApiEndpoint.get("messages", "/api/messages", { success: Messages }))
  .add(
    HttpApiEndpoint.get("messagesWindow", "/api/messages/window", {
      query: {
        /**
         * Unix ms: count from then to now, in whole minutes (the minute it falls in counts whole), at most
         * `MESSAGE_WINDOW_MINUTES` back; an earlier one is cut to that, and `window.from` says where it starts.
         */
        since: Schema.FiniteFromString
      },
      success: Messages
    })
  )
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
        buckets: Schema.optional(Schema.FiniteFromString),
        /** `true`: also list when the value changed, from every read (a switch's or an alarm's times). */
        changes: Schema.optional(Schema.Literals(["true", "false"]))
      },
      success: HistorySeries,
      error: [HistoryUnavailable, HistoryQueryInvalid]
    })
  ) {}

export class OtGatewayApi extends HttpApi.make("ot-gateway")
  .add(StatusGroup)
  .add(ConfigEditGroup)
  .add(SetupGroup)
  .add(LogsGroup) {}
