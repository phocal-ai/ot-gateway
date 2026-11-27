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
 *
 * `points_allow_commands` is the one tool that makes a point writable: one point, named, a dry run unless told
 * otherwise, and marked destructive so a client asks its user first.
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

/** Changes what runs on this machine (Docker), and asks the gateway afterwards. */
const deploys: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
}

const waitSeconds = count("Seconds to wait until every point has a value (default 120)", 1, 3600)

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

/** Which broker a `gateways` tool asks, and how long it waits for retained messages. */
const fleetInput = {
  broker: optionalText("The broker, mqtt://host:1883 or mqtts://host:8883; the config's broker when left out"),
  username: optionalText("The broker login; its password is read from OT_GATEWAY_BROKER_PASSWORD"),
  config: optionalText("The config whose broker to ask when there is no broker (default ./ot-gateway.json)"),
  wait: Schema.optionalKey(count("Seconds to wait for the broker's retained messages (default 2)", 1, 60))
}

const fleetArgv = (input: {
  readonly broker?: string
  readonly username?: string
  readonly config?: string
  readonly wait?: number
}) => [
  flag("broker", input.broker),
  flag("username", input.username),
  flag("config", input.config),
  flag("wait", input.wait)
]

const gatewayName = text("The gateway as site/building/id (from gateways_list), or its id alone when no other has it")

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
    name: "gateways_list",
    title: "List the gateways on a broker",
    description:
      "Every gateway whose retained health the broker keeps, across sites and buildings: name (site/building/id), online or offline (and why), when it started, its last heartbeat, and each device's status. Needs only a broker (broker, or the config's)",
    input: fleetInput,
    annotations: asks,
    argv: (input) => ["gateways", "list", ...fleetArgv(input)]
  }),
  defineTool({
    name: "gateways_status",
    title: "One gateway's health from the broker",
    description:
      "One gateway's retained health: each device's status, why a failing one fails and since when, and its machine (memory, disk, temperature). isError when it is offline (code gateway-offline) or a device fails (gateway-unhealthy)",
    input: { gateway: gatewayName, ...fleetInput },
    annotations: asks,
    argv: ({ gateway, ...input }) => ["gateways", "status", gateway, ...fleetArgv(input)]
  }),
  defineTool({
    name: "gateways_points",
    title: "One gateway's points from the broker",
    description:
      "One gateway's points from their retained $meta: topic, device, point, name, unit, writable. The topic is where its values arrive; a writable point takes commands with the write tool in the gateway's folder",
    input: { gateway: gatewayName, ...fleetInput },
    annotations: asks,
    argv: ({ gateway, ...input }) => ["gateways", "points", gateway, ...fleetArgv(input)]
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
    name: "discover_modbus",
    title: "Find Modbus TCP devices",
    description:
      "Find Modbus TCP devices and their unit ids on a range of addresses (192.168.1.0/24, 192.168.1.10-40, an address; at most a /22), read-only (one register read per unit) and rate-limited. Returns each unit with its draft points list row, the addresses that answered without a unit with a hint (a Modbus gateway: ask again with unitIds 1-247), and next. Scan only a range the user named or confirmed",
    input: {
      range: text("The addresses to ask: an address, host:port, a network, first-last, or several comma-separated"),
      port: Schema.optionalKey(count("The TCP port where the range gives none (default 502)", 1, 65_535)),
      unitIds: optionalText("The unit ids to ask on each address, as 1, 1,2,5 or 1-247 (default 1, then 255 and 0)"),
      rate: Schema.optionalKey(count("At most this many requests a second across the scan (default 20)", 1, 200))
    },
    annotations: asks,
    argv: ({ range, port, unitIds, rate }) => [
      "discover",
      "modbus",
      range,
      flag("port", port),
      flag("unit-ids", unitIds),
      flag("rate", rate)
    ]
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
    name: "points_allow_commands",
    title: "Let a point take commands",
    description:
      "Make one point writable in the config: it then takes commands on its $set topic, a number only within min and max. Use it only when the user asked for this point by name, and with the limits the user gave: never guess limits, ask. Nothing is sent to the device; the running gateway takes it with restart. dryRun defaults to true: only check and return what would change (point, source, setTopic, limits, changed, next)",
    input: {
      point: text("One point as device/point, as in the config: heat-pump/setpoint"),
      min: Schema.optionalKey(
        Schema.Finite.annotate({
          description:
            "The lowest value a command may set, in the point's unit; with max for a number, neither for a switch"
        })
      ),
      max: Schema.optionalKey(Schema.Finite.annotate({ description: "The highest value a command may set" })),
      config: configArgument,
      dryRun: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Only check and return what would change (default true)" })
      )
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    argv: ({ point, min, max, config, dryRun }) => [
      "points",
      "allow-commands",
      point,
      config,
      flag("min", min),
      flag("max", max),
      flag("dry-run", dryRun ?? true)
    ]
  }),
  defineTool({
    name: "points_read_only",
    title: "Make a point read-only",
    description:
      "Make one point read-only again in the config (writable and its limits taken out): the gateway refuses commands on it after restart. Returns point, source, changed and next",
    input: {
      point: text("One point as device/point, as in the config: heat-pump/setpoint"),
      config: configArgument,
      dryRun: Schema.optionalKey(Schema.Boolean.annotate({ description: "Only check and return what would change" }))
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    argv: ({ point, config, dryRun }) => ["points", "read-only", point, config, flag("dry-run", dryRun)]
  }),
  defineTool({
    name: "config_get",
    title: "Read a config key",
    description:
      "A key's value in the config, or the whole config without key: value (as the file has it), set (whether the file has it) and effective (what the gateway runs with, defaults filled in). The config holds no secret",
    input: {
      key: optionalText(
        "The key by its path, dots between, devices and points by id: mqtt.url, devices.heat-pump.pollIntervalMs"
      ),
      config: configArgument
    },
    annotations: local,
    argv: ({ key, config }) => ["config", "get", key, flag("config", config)]
  }),
  defineTool({
    name: "config_set",
    title: "Set a config key",
    description:
      "Set one key of the config (value), or take it out so its default applies (unset: true), checked with the gateway's schema before the file is written; the previous file is kept and config_undo puts it back. It never makes a point writable (points_allow_commands does). dryRun defaults to true: only check and return before, after, effective, changes and next. The running gateway takes a saved change with restart",
    input: {
      key: text(
        "The key by its path, dots between, devices and points by id: mqtt.url, devices.heat-pump.points.setpoint.unit"
      ),
      value: Schema.optionalKey(
        Schema.Json.annotate({
          description: "The value, as JSON: a text, a number, true or false, an object or a list"
        })
      ),
      unset: Schema.optionalKey(Schema.Boolean.annotate({ description: "Take the key out instead of setting it" })),
      config: configArgument,
      dryRun: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Only check and return what would change (default true)" })
      )
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    argv: ({ key, value, unset, config, dryRun }) =>
      unset === true
        ? ["config", "unset", key, flag("config", config), flag("dry-run", dryRun ?? true)]
        : [
            "config",
            "set",
            key,
            // Always as JSON, so the text "5000" stays a text and is not read as a number; left out, the command asks for it.
            flag("value", value === undefined ? undefined : JSON.stringify(value)),
            flag("config", config),
            flag("dry-run", dryRun ?? true)
          ]
  }),
  defineTool({
    name: "config_remove",
    title: "Remove a device or point",
    description:
      "Take a device, or one point of a device (device/point), out of the config. Its topics go silent after restart, and diff names the retained messages left on the broker. dryRun defaults to true: only check and return what would change",
    input: {
      target: text("A device, or one of its points as device/point: heat-pump, heat-pump/return-temp"),
      config: configArgument,
      dryRun: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Only check and return what would change (default true)" })
      )
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    argv: ({ target, config, dryRun }) => [
      "config",
      "remove",
      target,
      flag("config", config),
      flag("dry-run", dryRun ?? true)
    ]
  }),
  defineTool({
    name: "config_undo",
    title: "Put the previous config back",
    description:
      "Put the previous config back: the file and its .bak (what the last save replaced) change places, so calling it again brings the change back. Returns changes and next",
    input: {
      config: configArgument,
      dryRun: Schema.optionalKey(Schema.Boolean.annotate({ description: "Only return what would change" }))
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    argv: ({ config, dryRun }) => ["config", "undo", flag("config", config), flag("dry-run", dryRun)]
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
    name: "explain",
    title: "Explain a code",
    description:
      "What a code means, what to do and the command to run next: any code a tool returned (its code, a doctor finding, a device's reason, a write result). Without code, every code",
    input: { code: optionalText("A code as a tool returned it: broker-unreachable, timeout, out-of-range") },
    annotations: local,
    argv: ({ code }) => ["explain", code]
  }),
  defineTool({
    name: "support",
    title: "Support bundle",
    description:
      "One redacted Markdown report for an issue: versions and host, the config, which settings variables are set, and the running gateway's status, last 24 hours of events and log lines. Returns it as text with what each section holds; writes no file",
    input: { config: configArgument, url: urlArgument },
    annotations: asks,
    argv: ({ config, url }) => ["support", flag("config", config), flag("url", url), "--output=-"]
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
  }),
  defineTool({
    name: "up",
    title: "Start the gateway",
    description:
      "Start the gateway of the config's folder with Docker Compose (writes compose.yaml when the folder has none) and wait until every point has a value. Linux with Docker only. isError with code, hint and next when values do not flow",
    input: { config: configArgument, timeout: Schema.optionalKey(waitSeconds) },
    annotations: deploys,
    argv: ({ config, timeout }) => ["up", config, flag("timeout", timeout)]
  }),
  defineTool({
    name: "restart",
    title: "Restart the gateway",
    description:
      "Recreate the gateway's container (it reads the config and ot-gateway.env again) and wait until every point has a value. Values stop for the seconds of the restart",
    input: { config: configArgument, timeout: Schema.optionalKey(waitSeconds) },
    annotations: { ...deploys, destructiveHint: true },
    argv: ({ config, timeout }) => ["restart", config, flag("timeout", timeout)]
  }),
  defineTool({
    name: "down",
    title: "Stop the gateway",
    description:
      "Stop the gateway of the config's folder (docker compose down): no values are read or published until it is started again. The outbox and history stay",
    input: { config: configArgument },
    annotations: { ...deploys, destructiveHint: true },
    argv: ({ config }) => ["down", config]
  }),
  defineTool({
    name: "upgrade",
    title: "Upgrade the gateway",
    description:
      "Move the gateway of the config's folder to the newest release (or to): pull it, check the config with it, switch compose.yaml's tag, wait until values flow again, and go back to the old release when they do not (code upgrade-rolled-back). check: only say whether a newer release is out",
    input: {
      config: configArgument,
      check: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Only say whether a newer release is out; change nothing" })
      ),
      to: Schema.optionalKey(
        Schema.String.check(
          Schema.isPattern(/^[\w][\w.-]{0,127}$/, { message: "a release tag such as v0.16.0" })
        ).annotate({ description: "The release to move to (v0.16.0), an older one too; the newest when left out" })
      ),
      timeout: Schema.optionalKey(waitSeconds)
    },
    annotations: { ...deploys, destructiveHint: true },
    argv: ({ config, check, to, timeout }) => [
      "upgrade",
      config,
      flag("check", check),
      flag("to", to),
      flag("timeout", timeout)
    ]
  })
]

/** Each tool's name once: two with one name would leave one of them out of reach. */
export const toolNamesUnique = (tools: ReadonlyArray<McpTool>) =>
  new Set(tools.map((tool) => tool.name)).size === tools.length
