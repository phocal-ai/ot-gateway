/**
 * The MQTT contract (VISION.md, principle 3: the broker is the product): every topic the gateway publishes or
 * subscribes to, and the shape of every payload on it, as Effect Schemas. They are the one source: the JSON Schemas
 * a consumer reads (`contractJsonSchemas`) are generated from them, and the tests decode what the gateway really
 * publishes with them, strictly (`decodeContractMessage`), so a field the gateway starts sending without a schema
 * fails CI instead of reaching a consumer unannounced.
 *
 * Two readings of one schema:
 *
 * - **Consumers** get open objects (`additionalProperties: true`) for everything the gateway sends: a field added
 *   in a later minor version must not break a consumer that validates against an earlier one.
 * - **The gateway's own tests** decode with `onExcessProperty: "error"`: everything sent is in the schema.
 *
 * The command payload is the exception: it is input, and the command guard refuses anything but `{"value": …}`, so
 * its published schema is closed too.
 *
 * The rules for changing any of this are in `docs/mqtt-contract.md` ("Versioning").
 */
import { Exit, Schema } from "effect"
import { AlarmWhen, Semantics, Slug } from "./Point.ts"
import { Publish } from "./Publish.ts"

/**
 * The contract's version: `major.minor`. A minor version only adds (an optional field, a reason, a topic a
 * consumer may ignore); anything else is a major version. Not the gateway's release version: most releases change
 * no topic or payload at all.
 */
export const contractVersion = "1.0"

/** Where the JSON Schemas are checked in, from the repository's root: one folder per major version. */
export const contractSchemaDirectory = `docs/mqtt-contract/v${contractVersion.split(".")[0]}`

// ---------------------------------------------------------------------------------------------------------------
// Building blocks

/** A wall-clock time on the gateway: Unix milliseconds. */
const UnixMillis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  description:
    "Unix time in milliseconds, from the gateway's wall clock. A gateway without a real-time clock can be wrong until NTP sets it."
})

/** What a point reads as, after scaling. */
const PointValue = Schema.Union([Schema.Finite, Schema.Boolean]).annotate({
  description:
    "A finite number in engineering units (after scaling), or true or false for a binary point. A multi-state point publishes its state as a whole number from 1. Never NaN, Infinity or a string: a reading that is not a finite number is not published."
})

const Unit = Schema.String.annotate({
  description: "QUDT unit identifier, e.g. unit:DEG_C, as the point's config says."
})

const DriverReason = Schema.Literals([
  "timeout",
  "connection",
  "protocol",
  "invalid-response",
  "configuration",
  "not-implemented"
])

// ---------------------------------------------------------------------------------------------------------------
// Values: `site/building/device/point`

export const SampleValuePayload = Schema.Struct({
  value: PointValue,
  unit: Schema.optionalKey(Unit),
  ts: UnixMillis.annotate({
    description:
      "When the device was read (Unix ms). Not when the message was sent: a value buffered through a broker outage arrives late with the time it was read."
  })
}).annotate({
  title: "Value",
  description: "A point's value, in publish modes sample and change: one read. Published with QoS 1, not retained."
})
export type SampleValuePayload = typeof SampleValuePayload.Type

export const AggregateValuePayload = Schema.Struct({
  value: PointValue.annotate({
    description:
      "The time-weighted average, so a consumer that only reads value gets a sensible number. For a binary point, the last value."
  }),
  min: Schema.optionalKey(
    Schema.Finite.annotate({ description: "The lowest read in the window. Numeric points only." })
  ),
  max: Schema.optionalKey(
    Schema.Finite.annotate({ description: "The highest read in the window. Numeric points only." })
  ),
  avg: Schema.Finite.annotate({
    description:
      "Time-weighted average over the time the device answered. For a binary point, the share of that time it was true, from 0 to 1."
  }),
  last: PointValue.annotate({ description: "The last value read in, or carried into, the window." }),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "Reads in the window. 0 when the value held unchanged through it."
  }),
  from: UnixMillis.annotate({
    description: "Start of the window (Unix ms); later than to minus the interval when partial."
  }),
  to: UnixMillis.annotate({
    description: "End of the window (Unix ms), aligned to the clock: a multiple of the interval."
  }),
  ts: UnixMillis.annotate({ description: "Equal to to." }),
  partial: Schema.optionalKey(
    Schema.Literal(true).annotate({
      description: "The gateway started inside the window, so it covers only from from."
    })
  ),
  unit: Schema.optionalKey(Unit)
}).annotate({
  title: "Aggregate value",
  description:
    "A point's value in publish mode aggregate: one message per clock-aligned window. Published with QoS 1, not retained."
})
export type AggregateValuePayload = typeof AggregateValuePayload.Type

/** What a value topic carries; the point's `$meta` says which (`publish.mode`). */
export const ValuePayload = Schema.Union([AggregateValuePayload, SampleValuePayload]).annotate({
  title: "Value message",
  description:
    "The payload on site/building/device/point. Its point's $meta says which form: publish.mode aggregate sends the aggregate form, sample and change the plain one."
})
export type ValuePayload = typeof ValuePayload.Type

// ---------------------------------------------------------------------------------------------------------------
// Metadata: `site/building/device/point/$meta`

export const MetaPayload = Schema.Struct({
  name: Schema.String.annotate({ description: "The point's name, for people." }),
  unit: Schema.optionalKey(Unit),
  writable: Schema.Boolean.annotate({ description: "Whether the point takes commands on its $set topic." }),
  publish: Publish.annotate({ description: "How the point's values go out: sample, aggregate or change." }),
  cov: Schema.optionalKey(
    Schema.Literal(true).annotate({
      description: "The point is read by BACnet change of value: values come when the device reports a change."
    })
  ),
  semantics: Schema.optionalKey(Semantics),
  alarmWhen: Schema.optionalKey(
    AlarmWhen.annotate({ description: "The point is an alarm, active when its value is on (true, not 0) or off." })
  ),
  gateway: Schema.optionalKey(
    Slug.annotate({
      description: "The id of the gateway that publishes the point. Absent from releases before it was added."
    })
  )
}).annotate({
  title: "Point metadata",
  description:
    "A point's description on site/building/device/point/$meta. Published retained with QoS 1 when the gateway starts; an empty retained message clears it when the point leaves the config."
})
export type MetaPayload = typeof MetaPayload.Type

// ---------------------------------------------------------------------------------------------------------------
// Health: `site/building/$gateway/<id>/health`

export const DeviceHealthPayload = Schema.Struct({
  status: Schema.Literals(["starting", "ok", "failing"]).annotate({
    description: "starting until the device's first cycle ends, then whether its last read worked."
  }),
  lastSuccess: Schema.optionalKey(UnixMillis.annotate({ description: "The last successful read (Unix ms)." })),
  reason: Schema.optionalKey(
    Schema.Union([DriverReason, Schema.Literals(["cycle-timeout", "crashed"])]).annotate({
      description: "Why the device is failing, while failing."
    })
  ),
  failingSince: Schema.optionalKey(
    UnixMillis.annotate({ description: "The first failure of the current run (Unix ms), while failing." })
  )
}).annotate({ title: "Device health" })
export type DeviceHealthPayload = typeof DeviceHealthPayload.Type

export const HostHealthPayload = Schema.Struct({
  memoryBytes: Schema.Finite.annotate({ description: "Resident memory of the gateway process, in bytes." }),
  eventLoopLagMs: Schema.Finite.annotate({
    description: "The longest the event loop was late in the last minute, in ms."
  }),
  clockSteps: Schema.Int.annotate({
    description: "Wall-clock steps (NTP setting the time) since the gateway started."
  }),
  temperatureC: Schema.optionalKey(
    Schema.Finite.annotate({ description: "CPU temperature, where the host has a thermal zone." })
  ),
  throttled: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Power or thermal conditions a Raspberry Pi reported in about the last minute; empty when none."
    })
  ),
  throttledWatched: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "The conditions the Pi lets the gateway see." })
  ),
  diskFreeBytes: Schema.optionalKey(
    Schema.Finite.annotate({ description: "Free space on the buffer's filesystem, in bytes." })
  )
}).annotate({ title: "Host health" })
export type HostHealthPayload = typeof HostHealthPayload.Type

export const OnlineHealthPayload = Schema.Struct({
  status: Schema.Literal("online"),
  contract: Schema.String.annotate({
    description: "The version of this contract the gateway speaks, major.minor: a consumer checks the major."
  }),
  since: UnixMillis.annotate({ description: "When the gateway started (Unix ms)." }),
  ts: UnixMillis.annotate({
    description: "When this message was written (Unix ms): it advances with every heartbeat."
  }),
  devices: Schema.Record(Slug, DeviceHealthPayload).annotate({ description: "Every configured device, by id." }),
  host: Schema.optionalKey(HostHealthPayload)
}).annotate({ title: "Gateway online" })
export type OnlineHealthPayload = typeof OnlineHealthPayload.Type

export const OfflineHealthPayload = Schema.Struct({
  status: Schema.Literal("offline"),
  reason: Schema.Literals(["shutdown", "connection-lost"]).annotate({
    description: "shutdown when the gateway stopped cleanly; connection-lost from the MQTT last will."
  })
}).annotate({ title: "Gateway offline" })
export type OfflineHealthPayload = typeof OfflineHealthPayload.Type

export const HealthPayload = Schema.Union([OnlineHealthPayload, OfflineHealthPayload]).annotate({
  title: "Gateway health",
  description:
    "The payload on site/building/$gateway/<id>/health, retained with QoS 1: online on connect, after a device's status changes and on every heartbeat (health.intervalMs), offline on a clean stop or as the last will."
})
export type HealthPayload = typeof HealthPayload.Type

// ---------------------------------------------------------------------------------------------------------------
// Commands: `site/building/device/point/$set` and `…/$set/result`

export const CommandPayload = Schema.Struct({
  value: Schema.Union([Schema.Finite, Schema.Boolean, Schema.Null]).annotate({
    description:
      "The value to write, in engineering units: true or false for a binary point, a whole number from 1 for a multi-state one, a number within the point's limits otherwise. null releases a BACnet point's priority slot."
  })
}).annotate({
  title: "Command",
  description:
    'Sent to site/building/device/point/$set, live (never retained), to a point whose $meta says writable. Exactly {"value": …}: anything else is rejected as invalid-payload. MQTT 5 correlation data is echoed on the result, and a message expiry shortens how long the command may wait.'
})
export type CommandPayload = typeof CommandPayload.Type

const RejectReason = Schema.Literals([
  "retained",
  "expired",
  "unknown-point",
  "not-writable",
  "invalid-payload",
  "wrong-type",
  "out-of-range"
])

const ResultTs = UnixMillis.annotate({ description: "When the gateway decided (Unix ms)." })

export const CommandWrittenPayload = Schema.Struct({
  status: Schema.Literal("written"),
  value: Schema.Union([Schema.Finite, Schema.Boolean, Schema.Null]).annotate({
    description: "The value written, as sent."
  }),
  ts: ResultTs
}).annotate({ title: "Command written", description: "The device accepted the write." })

export const CommandRejectedPayload = Schema.Struct({
  status: Schema.Literal("rejected"),
  reason: RejectReason,
  message: Schema.String.annotate({ description: "Why, in one line, for people." }),
  ts: ResultTs
}).annotate({ title: "Command rejected", description: "The gateway refused the command; no device saw it." })

export const CommandFailedPayload = Schema.Struct({
  status: Schema.Literal("failed"),
  reason: Schema.Union([DriverReason, Schema.Literal("device-unavailable")]).annotate({
    description: "timeout means the device did not answer in time and may still have applied the write."
  }),
  message: Schema.String.annotate({ description: "What went wrong, in one line, for people." }),
  ts: ResultTs
}).annotate({ title: "Command failed", description: "The command passed every check, but the write did not succeed." })

export const CommandResultPayload = Schema.Union([
  CommandWrittenPayload,
  CommandRejectedPayload,
  CommandFailedPayload
]).annotate({
  title: "Command result",
  description:
    "One per command whose topic can name a point, on site/building/device/point/$set/result with the command's correlation data. QoS 1, not retained, and never buffered: delivered now or not at all."
})
export type CommandResultPayload = typeof CommandResultPayload.Type

// ---------------------------------------------------------------------------------------------------------------
// Topics

/** The messages of the contract, by name. */
export const contractMessages = {
  value: ValuePayload,
  meta: MetaPayload,
  health: HealthPayload,
  command: CommandPayload,
  "command-result": CommandResultPayload
} as const
export type ContractMessage = keyof typeof contractMessages

export interface ContractTopic {
  readonly message: ContractMessage
  /** The topic, with `{level}` for each variable level (all of them slugs). */
  readonly pattern: string
  /** `publish`: the gateway sends it. `subscribe`: the gateway listens for it. */
  readonly direction: "publish" | "subscribe"
  readonly retained: boolean
  readonly qos: 0 | 1
}

/** Every topic of the contract. */
export const contractTopics: ReadonlyArray<ContractTopic> = [
  { message: "value", pattern: "{site}/{building}/{device}/{point}", direction: "publish", retained: false, qos: 1 },
  {
    message: "meta",
    pattern: "{site}/{building}/{device}/{point}/$meta",
    direction: "publish",
    retained: true,
    qos: 1
  },
  {
    message: "health",
    pattern: "{site}/{building}/$gateway/{gateway}/health",
    direction: "publish",
    retained: true,
    qos: 1
  },
  {
    message: "command",
    pattern: "{site}/{building}/{device}/{point}/$set",
    direction: "subscribe",
    retained: false,
    qos: 1
  },
  {
    message: "command-result",
    pattern: "{site}/{building}/{device}/{point}/$set/result",
    direction: "publish",
    retained: false,
    qos: 1
  }
]

/**
 * Which contract message a topic carries, or undefined for a topic outside the contract (the broker check's
 * `$gateway/<id>/check/…`, anything another client publishes).
 */
export const contractMessageOf = (topic: string): ContractMessage | undefined => {
  const levels = topic.split("/")
  if (levels.length === 4) return levels[2] === "$gateway" ? undefined : "value"
  if (levels.length === 5 && levels[2] === "$gateway") return levels[4] === "health" ? "health" : undefined
  if (levels.length === 5 && levels[4] === "$meta") return "meta"
  if (levels.length === 5 && levels[4] === "$set") return "command"
  if (levels.length === 6 && levels[4] === "$set" && levels[5] === "result") return "command-result"
  return undefined
}

/**
 * Decodes one message strictly, as the gateway's own tests check what it publishes: unknown fields are errors. An
 * empty retained `$meta` (a cleared point) is valid and decodes to undefined.
 */
export const decodeContractMessage = (
  message: ContractMessage,
  payload: string
): Exit.Exit<unknown, Schema.SchemaError> =>
  message === "meta" && payload === ""
    ? Exit.void
    : Schema.decodeUnknownExit(Schema.fromJsonString(contractMessages[message]), { onExcessProperty: "error" })(payload)

// ---------------------------------------------------------------------------------------------------------------
// JSON Schema

/** The contract's JSON Schemas, one document per message, as `ot-gateway contract --json` would print them. */
export const contractJsonSchemas = (): Record<ContractMessage, Record<string, unknown>> => {
  const document = (message: ContractMessage) => {
    const generated = Schema.toJsonSchemaDocument(contractMessages[message], {
      // Input is closed (the guard refuses anything else); output stays open for later minor versions.
      onExcessProperty: message === "command" ? "error" : "ignore"
    })
    return {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `ot-gateway/mqtt-contract/${contractVersion}/${message}`,
      ...generated.schema,
      "x-ot-gateway-contract": contractVersion,
      ...(Object.keys(generated.definitions).length === 0 ? {} : { $defs: generated.definitions })
    }
  }
  return {
    value: document("value"),
    meta: document("meta"),
    health: document("health"),
    command: document("command"),
    "command-result": document("command-result")
  }
}
