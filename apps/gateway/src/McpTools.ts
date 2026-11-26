/**
 * The tools `ot-gateway mcp` offers: each one a CLI command with `--json`, so a tool's result is the JSON that
 * command prints and its guards are the command's own (`write` goes through the gateway's command guard, as
 * `ot-gateway write` does). A tool is a name, what an agent reads about it, its arguments as a Schema, and the
 * command line they make. To offer a new command, add one `defineTool` entry to `mcpTools`.
 *
 * Arguments are decoded here, at the boundary: unknown keys are refused, and no argument can become a flag. A
 * flag's value is passed as `--name=value`, and a positional that starts with `-` is refused, so `{"config":
 * "--points-list=/etc/passwd"}` is a mistake, not a file written.
 *
 * Commands that ask questions (`init`), run until stopped (`run`, `demo`, `simulate`), or write to stdout
 * directly (`points template`, `points from-ede`) are not offered.
 */
import { Effect, type JsonSchema, Schema } from "effect"
import { contractMessageNames } from "./ContractReport.ts"
import { probeTables } from "./Probe.ts"

/** What an agent may assume about a tool (MCP `ToolAnnotations`). */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
  readonly openWorldHint: boolean
}

/** Arguments a tool refused: unknown keys, a wrong type, a value out of range. */
export class InvalidToolArguments extends Schema.TaggedError<InvalidToolArguments>()("InvalidToolArguments", {
  message: Schema.String
}) {}

/** A tool as the server lists and calls it. */
export interface McpTool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: unknown
  readonly annotations: ToolAnnotations
  /** The CLI arguments (without `--json`) for the arguments an agent sent, decoded first. */
  readonly argv: (input: unknown) => Effect.Effect<ReadonlyArray<string>, InvalidToolArguments>
}

/** Reads nothing outside this machine's files and changes nothing. */
const local: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}
/** Asks the broker, the gateway or devices, and changes nothing. */
const asks: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }

/**
 * A tool from its arguments' fields: the JSON Schema listed to agents and the decoder are made from the same
 * Schema, so they cannot disagree.
 */
export const defineTool = <
  const Fields extends Readonly<Record<string, Schema.Top & { readonly DecodingServices: never }>>
>(spec: {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly input: Fields
  readonly annotations: ToolAnnotations
  readonly argv: (input: Schema.Struct<Fields>["Type"]) => ReadonlyArray<string | undefined | false>
}): McpTool => {
  const schema = Schema.Struct(spec.input)
  const decode = Schema.decodeUnknownEffect(schema)
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: objectSchema(Schema.toJsonSchemaDocument(schema).schema),
    annotations: spec.annotations,
    argv: (input) =>
      decode(input ?? {}, { onExcessProperty: "error", errors: "all" }).pipe(
        Effect.map((decoded) => spec.argv(decoded).filter((arg): arg is string => typeof arg === "string")),
        Effect.mapError((error) => new InvalidToolArguments({ message: error.message }))
      )
  }
}

/**
 * A tool's input schema as MCP wants it: always an object (a struct with no fields generates "not null"), and no
 * keys but its own, as the decoder refuses them.
 */
const objectSchema = (generated: JsonSchema.JsonSchema) => ({
  type: "object",
  properties: {},
  ...(generated["type"] === "object" ? generated : {}),
  additionalProperties: false
})

/** `--name=value`, or nothing when the value is left out (or a boolean flag is false). */
export const flag = (name: string, value: string | number | boolean | undefined): string | undefined =>
  value === undefined || value === false ? undefined : value === true ? `--${name}` : `--${name}=${value}`

const notAFlag = Schema.isPattern(/^[^-]/, { message: "must not start with -" })

const text = (description: string) => Schema.String.check(notAFlag).annotate({ description })
const optionalText = (description: string) => Schema.optionalKey(text(description))
const flagText = (description: string) => Schema.optionalKey(Schema.String.annotate({ description }))
const count = (description: string, minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum })).annotate({ description })

const configArgument = optionalText("Path of the gateway's JSON config (default ./ot-gateway.json)")
const urlArgument = flagText("Ask the status page at this address instead of the one the config gives")
const pointsArgument = (what: string) =>
  optionalText(`device/point, a device for all its points, or several of either comma-separated; ${what}`)

/**
 * A value for `write`: a number in the point's unit, true or false for a switch, null to release a BACnet priority
 * slot, or the CLI's words for them (on, off).
 */
const WriteValue = Schema.Union([Schema.Finite, Schema.Boolean, Schema.Null, Schema.String.check(notAFlag)]).annotate({
  description:
    "A number in the point's unit, true or false (on/off) for a switch, null to release a BACnet priority slot"
})

const writeValueArgument = (value: number | boolean | null | string) => (value === null ? "null" : String(value))

export const mcpTools: ReadonlyArray<McpTool> = [
  defineTool({
    name: "check",
    title: "Check a config",
    description:
      "Validate a gateway config without connecting to anything. Returns the gateway it describes, or every mistake with its path (issues), and next: what to run after it",
    input: { config: configArgument },
    annotations: local,
    argv: ({ config }) => ["check", config]
  }),
  defineTool({
    name: "doctor",
    title: "Run every check",
    description:
      "Every check in order: the config, the broker (a round trip), the running gateway, each device (read-only), the BACnet/IP port, the disk and the clock. Returns findings [{check, status, subject, message, code, hint, next}]; start here when something is wrong",
    input: { config: configArgument },
    annotations: asks,
    argv: ({ config }) => ["doctor", config]
  }),
  defineTool({
    name: "broker",
    title: "Check the broker",
    description:
      "Connect to the config's MQTT broker: the MQTT version it speaks, what it allows, and a message there and back",
    input: { config: configArgument },
    annotations: asks,
    argv: ({ config }) => ["broker", config]
  }),
  defineTool({
    name: "status",
    title: "Gateway status",
    description:
      "The running gateway's status from its status page: its broker, buffer and each device, with hints for a failing one. isError when a device is failing or the broker is not connected",
    input: {
      config: configArgument,
      url: urlArgument,
      failOnAlarm: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Also an error while an alarm is active" })
      )
    },
    annotations: asks,
    argv: ({ config, url, failOnAlarm }) => [
      "status",
      flag("config", config),
      flag("url", url),
      flag("fail-on-alarm", failOnAlarm)
    ]
  }),
  defineTool({
    name: "events",
    title: "Recent events",
    description:
      "What changed lately in the running gateway, oldest first: devices failing and recovering, the broker lost and back, the buffer drained",
    input: {
      config: configArgument,
      url: urlArgument,
      since: flagText("How far back: 30s, 10m, 2h, 1d or all (default 1h)")
    },
    annotations: asks,
    argv: ({ config, url, since }) => ["events", flag("config", config), flag("url", url), flag("since", since)]
  }),
  defineTool({
    name: "logs",
    title: "Recent log lines",
    description:
      "The running gateway's recent log lines from memory, oldest first: the warnings and errors behind status and events. Secrets are redacted",
    input: {
      config: configArgument,
      url: urlArgument,
      level: Schema.optionalKey(
        Schema.Literals(["info", "warn", "error"]).annotate({ description: "The least severe level (default info)" })
      ),
      since: flagText("How far back: 30s, 10m, 2h, 1d or all (default 1h)")
    },
    annotations: asks,
    argv: ({ config, url, level, since }) => [
      "logs",
      flag("config", config),
      flag("url", url),
      flag("level", level),
      flag("since", since)
    ]
  }),
  defineTool({
    name: "history",
    title: "Point history",
    description:
      "What points did lately, from the running gateway's history: per bucket the average, minimum, maximum and reads, and the gaps",
    input: {
      points: text(
        "device/point, a device for all its points, or several of either comma-separated: energy-meter/active-power"
      ),
      config: configArgument,
      url: urlArgument,
      since: flagText("How far back: 30s, 10m, 2h or 1d (default 10m)"),
      buckets: Schema.optionalKey(count("About how many buckets the range is cut into (default 10)", 1, 2000))
    },
    annotations: asks,
    argv: ({ points, config, url, since, buckets }) => [
      "history",
      points,
      flag("config", config),
      flag("url", url),
      flag("since", since),
      flag("buckets", buckets)
    ]
  }),
  defineTool({
    name: "messages",
    title: "Messages per topic",
    description:
      "How many messages the running gateway published per topic since it started (or in the last since, up to an hour), how many reached the broker, and the last one",
    input: {
      points: pointsArgument("every topic when left out"),
      config: configArgument,
      url: urlArgument,
      since: flagText("Count only the last 30s, 10m or up to 60m")
    },
    annotations: asks,
    argv: ({ points, config, url, since }) => [
      "messages",
      points,
      flag("config", config),
      flag("url", url),
      flag("since", since)
    ]
  }),
  defineTool({
    name: "read",
    title: "Read points once",
    description:
      "Read every configured point (or the ones named) once through the gateway's drivers, without a running gateway or a broker. Read-only. isError when a point was not read",
    input: {
      points: pointsArgument("every point when left out"),
      config: configArgument,
      timeout: Schema.optionalKey(count("Seconds each device may take (default 10)", 1, 600))
    },
    annotations: asks,
    argv: ({ points, config, timeout }) => ["read", points, flag("config", config), flag("timeout", timeout)]
  }),
  defineTool({
    name: "write",
    title: "Write a point",
    description:
      "Write a point through the running gateway, as a consumer would: a command on its $set topic, checked by the gateway's command guard (writable points only, within their limits), then its result. isError when not written, with code, hint and written (false, true or unknown)",
    input: {
      point: text("device/point, as in the config: demo-room/temperature-setpoint"),
      value: WriteValue,
      config: configArgument,
      timeout: Schema.optionalKey(count("Seconds to wait for the gateway's result (default 25)", 1, 300))
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    argv: ({ point, value, config, timeout }) => [
      "write",
      point,
      writeValueArgument(value),
      flag("config", config),
      flag("timeout", timeout)
    ]
  }),
  defineTool({
    name: "watch",
    title: "Watch the broker",
    description:
      "What arrives at the config's broker under its site and building for a few seconds, one JSON object per message and line, ending with a summary",
    input: {
      seconds: count("How long to watch", 1, 300),
      config: configArgument,
      topic: flagText("A topic filter instead of site/building/#"),
      check: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Only the messages off the MQTT contract, with what is wrong" })
      ),
      untilValues: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Stop once every configured point sent a value" })
      )
    },
    annotations: asks,
    argv: ({ seconds, config, topic, check, untilValues }) => [
      "watch",
      config,
      flag("seconds", seconds),
      flag("topic", topic),
      flag("check", check),
      flag("until-values", untilValues)
    ]
  }),
  defineTool({
    name: "discover",
    title: "Find BACnet devices",
    description:
      "Find BACnet devices through the config's BACnet settings (the defaults when there is no config yet) and return a draft of their devices entries. Read-only",
    input: {
      config: configArgument,
      address: flagText("Ask only the device at this ip or ip:port instead of a broadcast")
    },
    annotations: asks,
    argv: ({ config, address }) => ["discover", config, flag("address", address)]
  }),
  defineTool({
    name: "probe",
    title: "Probe Modbus registers",
    description:
      "Read Modbus TCP registers once (read-only) and return every type and byte order they read as, with a points list row",
    input: {
      host: text("host or host:port of the Modbus TCP device"),
      register: count(
        "The first register's 0-based address, as the points list's register column: a datasheet's 40101 is usually holding register 100",
        0,
        65_535
      ),
      unitId: Schema.optionalKey(count("The Modbus unit id (default 1)", 0, 255)),
      table: Schema.optionalKey(
        Schema.Literals(probeTables).annotate({ description: "The register table (default holding)" })
      ),
      count: Schema.optionalKey(count("How many registers to read", 1, 125))
    },
    annotations: asks,
    argv: ({ host, register, unitId, table, count: registers }) => [
      "probe",
      host,
      String(register),
      flag("unit-id", unitId),
      flag("table", table),
      flag("count", registers)
    ]
  }),
  defineTool({
    name: "import",
    title: "Import a points list",
    description:
      "Check a points list (CSV or JSON) and, with dryRun false, add its devices to the config (none writable). dryRun defaults to true: only check and return the devices",
    input: {
      pointsList: text("Path of the points list"),
      config: configArgument,
      dryRun: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Only check and return the devices (default true)" })
      )
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    argv: ({ pointsList, config, dryRun }) => ["import", pointsList, config, flag("dry-run", dryRun ?? true)]
  }),
  defineTool({
    name: "points_schema",
    title: "Points list columns",
    description: "The points list's columns, rules and allowed values, for writing one",
    input: {
      brief: Schema.optionalKey(Schema.Boolean.annotate({ description: "Each column in short, without aliases" }))
    },
    annotations: local,
    argv: ({ brief }) => ["points", "schema", flag("brief", brief)]
  }),
  defineTool({
    name: "points_export",
    title: "Export a points list",
    description:
      "The config's devices as a points list again (rows, the columns import reads), so the list follows edits made in the config or on the status page; notCarried names what a list cannot say (writable points, semantics, a register's bit). Writes no file",
    input: {
      config: configArgument,
      format: Schema.optionalKey(
        Schema.Literals(["csv", "json"]).annotate({ description: "csv (default: rows and the csv text) or json" })
      )
    },
    annotations: local,
    argv: ({ config, format }) => ["points", "export", config, flag("format", format)]
  }),
  defineTool({
    name: "diff",
    title: "What a config change does",
    description:
      "What a config change does on the broker before it is applied, against the running gateway (or against an older config file): topics added, removed and moved (renames), points that take commands now, $meta and settings that change, and stale retained messages with the command that clears each (next)",
    input: {
      config: configArgument,
      against: flagText(
        "Compare with this config file instead of the running gateway (ot-gateway.json.bak: before the last save)"
      ),
      url: urlArgument
    },
    annotations: asks,
    argv: ({ config, against, url }) => ["diff", config, flag("against", against), flag("url", url)]
  }),
  defineTool({
    name: "contract",
    title: "MQTT contract",
    description:
      "The MQTT contract: every topic the gateway publishes or listens on and its payload as a JSON Schema, or one message's schema",
    input: {
      message: Schema.optionalKey(
        Schema.Literals(contractMessageNames).annotate({ description: "One message's JSON Schema only" })
      )
    },
    annotations: local,
    argv: ({ message }) => ["contract", message]
  }),
  defineTool({
    name: "profiles_list",
    title: "Device profiles",
    description: "The device profiles a points list can name in its profile column",
    input: {},
    annotations: local,
    argv: () => ["profiles", "list"]
  }),
  defineTool({
    name: "profiles_show",
    title: "One device profile",
    description: "One profile's points: names, registers, types and units",
    input: { profile: text("A profile id, or a path ending in .json") },
    annotations: local,
    argv: ({ profile }) => ["profiles", "show", profile]
  })
]

/** Each tool's name once: two with one name would leave one of them out of reach. */
export const toolNamesUnique = (tools: ReadonlyArray<McpTool>) =>
  new Set(tools.map((tool) => tool.name)).size === tools.length
