/**
 * Gateway configuration. One JSON document describes the whole gateway, so it
 * can live in a file, in a database, or be edited by a web app.
 */
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect"
import { BacnetPoint, ModbusPoint, SimulatedPoint, Slug } from "./Point.ts"
import { Publish, publishOf, windowIntervalMs } from "./Publish.ts"

const pollIntervalMs = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 100, maximum: 86_400_000 })),
  Schema.withDecodingDefaultKey(Effect.succeed(5_000))
)

/**
 * Ids are topic segments, so two devices (or two points of one device) with
 * the same id would publish to the same topic. Each duplicate is reported at
 * its own path, naming the id.
 */
const uniqueIds = (what: "device" | "point") =>
  Schema.makeFilter<ReadonlyArray<{ readonly id: string }>>((items) => {
    const seen = new Set<string>()
    const duplicates: Array<Schema.FilterIssue> = []
    items.forEach((item, index) => {
      if (seen.has(item.id)) duplicates.push({ path: [index, "id"], issue: `duplicate ${what} id "${item.id}"` })
      seen.add(item.id)
    })
    return duplicates
  })

/** `deadband` is the short form of change mode, so a point that also has `publish` would say two things. */
const oneWayToPublish = Schema.makeFilter<ReadonlyArray<{ readonly deadband?: number; readonly publish?: Publish }>>(
  (points) =>
    points.flatMap((point, index) =>
      point.deadband !== undefined && point.publish !== undefined
        ? [
            {
              path: [index, "deadband"],
              issue: 'set the deadband inside publish ({ "mode": "change", "deadband": … }), not next to it'
            }
          ]
        : []
    )
)

/** A device's points: at least one, with unique ids. */
const pointsOf = <
  S extends Schema.Top & {
    readonly Type: { readonly id: string; readonly deadband?: number; readonly publish?: Publish }
  }
>(
  point: S
) => Schema.Array(point).pipe(Schema.check(Schema.isMinLength(1), uniqueIds("point"), oneWayToPublish))

/** How the device's points go out, unless a point says otherwise (default: every read). */
const devicePublish = Schema.optionalKey(Publish)

/**
 * A window shorter than the poll interval would close without a read in it, or send one value several times:
 * every publish interval, the device's and each point's, is at least the poll interval.
 */
const publishNotFasterThanPolling = Schema.makeFilter<{
  readonly pollIntervalMs: number
  readonly publish?: Publish
  readonly points: ReadonlyArray<{ readonly deadband?: number; readonly publish?: Publish }>
}>((device) => {
  const tooFast = (publish: Publish | undefined) => {
    const interval = publish === undefined ? undefined : windowIntervalMs(publish)
    return interval !== undefined && interval < device.pollIntervalMs
  }
  const issue = `is shorter than the device's pollIntervalMs (${device.pollIntervalMs}); read more often or send less often`
  return [
    ...(tooFast(device.publish) ? [{ path: ["publish", "intervalMs"], issue }] : []),
    ...device.points.flatMap((point, index) =>
      point.publish !== undefined && tooFast(publishOf(device.publish, point))
        ? [{ path: ["points", index, "publish", "intervalMs"], issue }]
        : []
    )
  ]
})

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
export const defaultCycleTimeoutMs = (intervalMs: number): number => Math.max(2 * intervalMs, intervalMs + 30_000)

/** A device's cycle deadline: its `cycleTimeoutMs`, or the default for its poll interval. */
export const cycleTimeoutMs = (device: { readonly pollIntervalMs: number; readonly cycleTimeoutMs?: number }) =>
  device.cycleTimeoutMs ?? defaultCycleTimeoutMs(device.pollIntervalMs)

export const ModbusDevice = Schema.Struct({
  protocol: Schema.Literal("modbus-tcp"),
  id: Slug,
  host: Schema.NonEmptyString,
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
  publish: devicePublish,
  /**
   * Minimum pause between the end of one request and the start of the next
   * on this device's connection (default 0). Slow Modbus gateways and serial
   * bridges drop requests that arrive back to back; 50 to 200 ms helps.
   */
  requestGapMs: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /** Most registers one read asks for (default 125, the protocol's limit); some devices refuse longer reads. */
  maxRegistersPerRead: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 125 })),
    Schema.withDecodingDefaultKey(Effect.succeed(125))
  ),
  /** Most coils or discrete inputs one read asks for (default 2000, the protocol's limit). */
  maxBitsPerRead: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 2_000 })),
    Schema.withDecodingDefaultKey(Effect.succeed(2_000))
  ),
  points: pointsOf(ModbusPoint)
}).check(publishNotFasterThanPolling)
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
  publish: devicePublish,
  points: pointsOf(BacnetPoint)
}).check(
  publishNotFasterThanPolling,
  // Found by broadcast, a device is wherever an I-Am says it is, and anyone on the LAN can send one.
  // Reads from the wrong host are wrong values; writes to it are commands to someone else's equipment.
  Schema.makeFilter(
    (device) =>
      device.address !== undefined ||
      !device.points.some((point) => point.writable) || {
        path: ["address"],
        issue: "a device with writable points needs a fixed address, so a spoofed I-Am cannot redirect its writes"
      }
  )
)
export type BacnetDevice = typeof BacnetDevice.Type

export const SimulatorDevice = Schema.Struct({
  protocol: Schema.Literal("simulator"),
  id: Slug,
  pollIntervalMs,
  cycleTimeoutMs: cycleTimeoutMsField,
  publish: devicePublish,
  points: pointsOf(SimulatedPoint)
}).check(publishNotFasterThanPolling)
export type SimulatorDevice = typeof SimulatorDevice.Type

export const Device = Schema.Union([ModbusDevice, BacnetDevice, SimulatorDevice])
export type Device = typeof Device.Type

/** Strings in the MQTT CONNECT packet are length-prefixed: keep them well inside the 65,535-byte limit. */
const ConnectString = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1_024)))

export const MqttSettings = Schema.Struct({
  /**
   * `mqtts://host:port` (TLS) or `mqtt://host:port`, without credentials (they
   * would be printed and logged with it). Whitespace around it is refused
   * rather than trimmed, so the URL that is checked is the one that is used.
   */
  url: Schema.NonEmptyString.pipe(
    Schema.check(
      Schema.makeFilter((url) => url.trim() === url || "must not start or end with whitespace"),
      Schema.makeFilter((url) => {
        const parsed = URL.parse(url)
        if (parsed === null) return "must be a URL, such as mqtts://broker.local:8883"
        if (parsed.protocol !== "mqtt:" && parsed.protocol !== "mqtts:") return "must start with mqtts:// or mqtt://"
        if (parsed.hostname === "") return "must name the broker's host, such as mqtts://broker.local:8883"
        return (
          (parsed.username === "" && parsed.password === "") ||
          "must not contain credentials; use mqtt.username and mqtt.passwordEnv"
        )
      })
    )
  ),
  clientId: Schema.optionalKey(ConnectString),
  username: Schema.optionalKey(ConnectString),
  /** Name of the environment variable holding the password. Never inline secrets. */
  passwordEnv: Schema.optionalKey(Schema.String)
})
export type MqttSettings = typeof MqttSettings.Type

const loopbackIpv4 = new RegExp(`^127(\\.${octet}){3}$`)

/**
 * Hosts on this machine: `localhost`, 127.0.0.0/8 and `::1`. `URL` leaves the
 * host of an `mqtt:` URL as written (case included), except IPv6, which it
 * normalizes and keeps in brackets. Any other host is treated as remote.
 */
const isLoopbackHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase()
  return host === "localhost" || host === "[::1]" || loopbackIpv4.test(host)
}

/**
 * The warning for a broker password that is sent without TLS: `passwordEnv`
 * set and an `mqtt://` URL to a host that is not this machine. MQTT carries
 * the password in the CONNECT packet, so only `mqtts://` keeps it encrypted
 * on the network. `undefined` when there is nothing to warn about.
 */
export const mqttPasswordWarning = (settings: MqttSettings): string | undefined => {
  if (settings.passwordEnv === undefined) return undefined
  const url = URL.parse(settings.url)
  if (url === null || url.protocol !== "mqtt:" || isLoopbackHost(url.hostname)) return undefined
  return "the MQTT password is sent unencrypted over mqtt://; use mqtts:// to encrypt it"
}

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

/** The on-device history of every read: raw for the last day, per minute for `retentionDays`. */
export const HistorySettings = Schema.Struct({
  /** SQLite file of the history; its own file, apart from the outbox. */
  path: Schema.String,
  /** Days of per-minute minimum, maximum and average kept (default 7). */
  retentionDays: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
    Schema.withDecodingDefaultKey(Effect.succeed(7))
  )
})
export type HistorySettings = typeof HistorySettings.Type

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
  /**
   * The BBMD on the gateway's subnet (Annex J.4), port 47808 unless given.
   * Only it may forward BACnet messages from other subnets to the gateway
   * (Forwarded-NPDU); without it, forwarded messages count only when they
   * come from the device they name. Anyone on the LAN can forge one, so a
   * forwarded answer or COV notification from any other host is dropped.
   */
  bbmdAddress: Schema.optionalKey(Ipv4Endpoint),
  /** How long to wait for an answer before resending (default 3 s). */
  requestTimeoutMs: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 100, maximum: 60_000 })),
    Schema.withDecodingDefaultKey(Effect.succeed(3_000))
  ),
  /** How often a request is resent after a timeout (default 2). */
  retries: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
    Schema.withDecodingDefaultKey(Effect.succeed(2))
  ),
  /**
   * Lifetime requested for change-of-value subscriptions (default 300 s,
   * clause 13.14.1.1.4). Each one is renewed at half its lifetime, so a
   * device that restarts and forgets its subscriptions is pushing again
   * within that half. Shorter lifetimes mean more renewal traffic.
   */
  covLifetimeSeconds: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 10, maximum: 86_400 })),
    Schema.withDecodingDefaultKey(Effect.succeed(300))
  )
})
export type BacnetSettings = typeof BacnetSettings.Type

/**
 * The local status page and its read-only API (`GET /api/status`). Off unless
 * the block is present. It listens on this machine only by default; set
 * `bindAddress` to `0.0.0.0` to open it to the LAN. It never takes commands.
 */
export const StatusSettings = Schema.Struct({
  bindAddress: Ipv4Address.pipe(Schema.withDecodingDefaultKey(Effect.succeed("127.0.0.1"))),
  port: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
    Schema.withDecodingDefaultKey(Effect.succeed(8080))
  ),
  /** The built web app (`apps/web/out`, the default). Without it only the API is served. */
  webRoot: Schema.optionalKey(Schema.NonEmptyString)
})
export type StatusSettings = typeof StatusSettings.Type

/**
 * Public test brokers: anyone can subscribe to every topic on them, and publish to any. They are for seeing the
 * gateway work (`ot-gateway demo --public`), so a config that names one may only have devices on this machine,
 * which are simulated; a device in a building would publish its data to the internet and take commands from it.
 */
export const publicTestBrokers: ReadonlySet<string> = new Set([
  "test.mosquitto.org",
  "broker.hivemq.com",
  "broker.emqx.io",
  "mqtt.eclipseprojects.io"
])

const onThisMachine = (host: string) => host === "localhost" || host === "::1" || loopbackIpv4.test(host)

const isOnThisMachine = (device: Device) =>
  device.protocol === "simulator" ||
  (device.protocol === "modbus-tcp"
    ? onThisMachine(device.host)
    : device.address !== undefined && onThisMachine(device.address.split(":")[0] ?? ""))

const publicBrokerOnlyForLocalDevices = Schema.makeFilter<{
  readonly mqtt: { readonly url: string }
  readonly devices: ReadonlyArray<Device>
}>((config) => {
  const host = URL.parse(config.mqtt.url)?.hostname.toLowerCase()
  if (host === undefined || !publicTestBrokers.has(host)) return []
  return config.devices.flatMap((device, index) =>
    isOnThisMachine(device)
      ? []
      : [
          {
            path: ["devices", index],
            issue: `${host} is a public test broker: anyone can read and write there, so it only takes simulated devices on this machine. Use your own broker for "${device.id}".`
          }
        ]
  )
})

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
  history: Schema.optionalKey(HistorySettings),
  status: Schema.optionalKey(StatusSettings),
  bacnet: BacnetSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  devices: Schema.Array(Device).pipe(Schema.check(uniqueIds("device")))
}).pipe(Schema.check(publicBrokerOnlyForLocalDevices))
export type GatewayConfig = typeof GatewayConfig.Type

/**
 * JSON text to a value. Unlike `Schema.fromJsonString`, a syntax error keeps
 * `JSON.parse`'s message, which says where it is (position, line and column).
 */
const JsonText = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Unknown,
    SchemaTransformation.transformEffect({
      decode: (text: string) =>
        Effect.try({
          try: (): unknown => JSON.parse(text),
          catch: (error) =>
            new SchemaIssue.InvalidValue({
              message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`
            })
        }),
      encode: (value: unknown) => Effect.succeed(JSON.stringify(value))
    })
  )
)

/**
 * Decode and validate a config from a JSON string. A key the schema does not
 * know fails decoding, so a typo (`intervall`) is reported instead of
 * silently falling back to the default. Every problem is reported at once,
 * each with its path, so a config with three mistakes takes one fix, not three.
 */
export const parseConfig = Schema.decodeUnknownEffect(JsonText.pipe(Schema.decodeTo(GatewayConfig)), {
  onExcessProperty: "error",
  errors: "all"
})
