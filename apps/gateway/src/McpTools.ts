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
 * Commands that run until stopped (`run`, `demo`, `simulate`) are not offered, and neither is `secret set`: a
 * secret is typed by the user into the command, so it never passes through an agent's conversation. Of `publish`
 * only clearing a retained message is one (`clear_retained`): a message of an agent's own on the gateway's
 * topics could pass for a value.
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
  /** The command's arguments, or why this input names none. */
  readonly argv: (
    input: Schema.Struct<Fields>["Type"]
  ) => ReadonlyArray<string | undefined | false> | InvalidToolArguments
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
        Effect.mapError((error) => new InvalidToolArguments({ message: error.message })),
        Effect.flatMap((decoded) => {
          const argv = spec.argv(decoded)
          return argv instanceof InvalidToolArguments
            ? Effect.fail(argv)
            : Effect.succeed(argv.filter((arg): arg is string => typeof arg === "string"))
        })
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

/** Why `given` does not name one source: exactly one of its keys is to be there. */
const oneOf = (given: Readonly<Record<string, unknown>>): InvalidToolArguments | undefined => {
  const named = Object.keys(given).filter((key) => given[key] !== undefined)
  const keys = Object.keys(given).join(", ")
  return named.length === 1
    ? undefined
    : new InvalidToolArguments({
        message: named.length === 0 ? `give one of ${keys}` : `give one of ${keys}, not ${named.join(" and ")} together`
      })
}

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
      "Find the BACnet devices on the LAN by broadcast (no address needed; on the machine's only network it asks there) through the config's BACnet settings, the defaults when there is no config yet. Returns found, one overview entry per device (id, name, instance, address, points, objectTypes) to show the user before choosing, devices, their draft config entries, and next. Read-only: discover_save saves the ones the user picks",
    input: {
      config: configArgument,
      address: flagText("Ask only the device at this ip or ip:port instead of a broadcast"),
      wait: Schema.optionalKey(count("Listen for answers at least this many seconds (default 3)", 1, 30))
    },
    annotations: asks,
    argv: ({ config, address, wait }) => ["discover", config, flag("address", address), flag("wait", wait)]
  }),
  defineTool({
    name: "discover_save",
    title: "Save discovered BACnet devices",
    description:
      "Discover again and save the BACnet devices the user chose into the config (which init writes first): all, or ids or instances as discover's found lists them, comma-separated. None is writable. A name that matches no device fails and saves nothing. dryRun defaults to true: only say what would be saved. Returns added, extended (points added to a device the config has), points, devices and next",
    input: {
      save: text("all, or device ids or instances separated by commas: boiler,ahu-1 or 1001,1002"),
      config: configArgument,
      address: flagText("Ask only the device at this ip or ip:port instead of a broadcast"),
      wait: Schema.optionalKey(count("Listen for answers at least this many seconds (default 3)", 1, 30)),
      dryRun: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Only say what would be saved, write nothing (default true)" })
      )
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    argv: ({ save, config, address, wait, dryRun }) => [
      "discover",
      config,
      flag("save", save),
      flag("address", address),
      flag("wait", wait),
      flag("dry-run", dryRun ?? true)
    ]
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
      "Check a points list and, with dryRun false, add its devices to the config (none writable). The list is a file (pointsList), its text (text: CSV, JSON rows or a BACnet EDE file) or rows (objects with the columns points_schema lists), so no file has to be written first. dryRun defaults to true: only check and return the devices",
    input: {
      pointsList: optionalText("Path of the points list, when it is a file"),
      text: Schema.optionalKey(
        Schema.String.annotate({ description: "The list itself instead of a file: CSV, JSON rows or EDE text" })
      ),
      rows: Schema.optionalKey(
        Schema.Array(Schema.Record(Schema.String, Schema.Json)).annotate({
          description: "The list as rows instead of a file: one object per point, keyed by column"
        })
      ),
      config: configArgument,
      dryRun: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Only check and return the devices (default true)" })
      )
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    argv: ({ pointsList, text: given, rows, config, dryRun }) => {
      const mistake = oneOf({ pointsList, text: given, rows })
      if (mistake !== undefined) return mistake
      const inline = rows === undefined ? given : JSON.stringify(rows)
      return [
        "import",
        inline === undefined ? pointsList : "-",
        config,
        flag("text", inline),
        flag("dry-run", dryRun ?? true)
      ]
    }
  }),
  defineTool({
    name: "points_template",
    title: "Points list template",
    description:
      "A points list with example rows to fill in, as CSV text (csv): every column, or only one protocol's. Writes no file",
    input: {
      protocol: Schema.optionalKey(
        Schema.Literals(["modbus", "bacnet"]).annotate({ description: "Only this protocol's rows and columns" })
      )
    },
    annotations: local,
    argv: ({ protocol }) => ["points", "template", flag("protocol", protocol)]
  }),
  defineTool({
    name: "points_from_ede",
    title: "Translate a BACnet EDE file",
    description:
      "A BACnet EDE file (the CSV export of BACnet engineering tools) as a points list: csv, with how many devices and points it has and what was skipped (schedules, trend logs). Give the file (edeFile) or its text. Writes no file; import reads EDE directly too",
    input: {
      edeFile: optionalText("Path of the EDE file"),
      text: Schema.optionalKey(Schema.String.annotate({ description: "The EDE file's text instead of a path" }))
    },
    annotations: local,
    argv: ({ edeFile, text: given }) =>
      oneOf({ edeFile, text: given }) ?? [
        "points",
        "from-ede",
        given === undefined ? edeFile : "-",
        flag("text", given)
      ]
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
    title: "Export points as CSV",
    description:
      "The config's points as a CSV (or JSON) list, returned or written to a file on this machine (output: ~/Downloads/bacnet-points.csv). Use it for \"give me the BACnet points as a CSV\": protocol bacnet or modbus keeps one protocol; columns all gives every column with the MQTT topic, writable, min and max, columns common every point of every protocol with only what they share (name, protocol, unit, writable, limits, topic), import (default) the columns import reads, so the list follows edits made in the config. notCarried names what an import list cannot say (writable points, semantics, a register's bit). An existing file is kept unless force",
    input: {
      config: configArgument,
      format: Schema.optionalKey(
        Schema.Literals(["csv", "json"]).annotate({ description: "csv (default: rows and the csv text) or json" })
      ),
      protocol: Schema.optionalKey(
        Schema.Literals(["bacnet", "modbus"]).annotate({ description: "Only the BACnet or only the Modbus devices" })
      ),
      columns: Schema.optionalKey(
        Schema.Literals(["import", "all", "common"]).annotate({
          description:
            "import (default): the columns import reads; all: every column, defaults and topic, writable, min, max too; common: only what every protocol has, not for import"
        })
      ),
      output: optionalText(
        "A file to write the list to, ~ for the home folder (~/Downloads/points.csv); its folder must exist. Without it the list is only returned"
      ),
      force: Schema.optionalKey(Schema.Boolean.annotate({ description: "Write over a file at output that is there" }))
    },
    // With force it writes over the file output names, which may be anything the user has.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    argv: ({ config, format, protocol, columns, output, force }) => [
      "points",
      "export",
      config,
      flag("format", format),
      flag("protocol", protocol),
      flag("columns", columns),
      flag("output", output),
      flag("force", force)
    ]
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
      "Put the previous config back: the file and its .bak (what the last save replaced) change places, so calling it again brings the change back. changes names what comes back with it, a point that takes commands again too (writes allowed). dryRun defaults to true: only return changes and next",
    input: {
      config: configArgument,
      dryRun: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Only return what would change (default true)" })
      )
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    argv: ({ config, dryRun }) => ["config", "undo", flag("config", config), flag("dry-run", dryRun ?? true)]
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
    name: "report_draft",
    title: "Draft a bug report",
    description:
      "Write up a bug in ot-gateway itself (not a wiring, address or config problem of the site) as a public issue text, in a file. Files nothing. Site, device and point names, addresses and secrets are replaced by placeholders and the versions are added. Returns the text, existing issues with the same fingerprint (existing) and what to settle first (warnings: a newer release is out, the code is one explain covers). Show the user the text and ask before report_send",
    input: {
      title: Schema.String.annotate({ description: "The bug in one line, as the issue's title" }),
      what: Schema.String.annotate({
        description: "What happened: the lines of output that show the failure, not the whole log"
      }),
      expected: flagText("What should have happened instead"),
      steps: flagText("The commands that lead to it, in order, so that someone else can see it too"),
      ruledOut: flagText("What was checked and is not the cause: wiring, addresses, the config, an older release"),
      command: flagText("The command or tool that failed, as it was run"),
      code: flagText("The code it returned, when it returned one"),
      error: flagText("The error's message, one line"),
      model: flagText("The device's vendor, model and firmware, when the bug is about a device"),
      device: flagText("The config's device the bug is about, by its id: its protocol is added"),
      config: configArgument
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    argv: ({ title, what, expected, steps, ruledOut, command, code, error, model, device, config }) => [
      "report",
      "draft",
      flag("config", config),
      flag("title", title),
      flag("what", what),
      flag("expected", expected),
      flag("steps", steps),
      flag("ruled-out", ruledOut),
      flag("command", command),
      flag("code", code),
      flag("error", error),
      flag("model", model),
      flag("device", device)
    ]
  }),
  defineTool({
    name: "report_send",
    title: "File a bug report",
    description:
      "File a draft of report_draft as a public issue on GitHub. Only with confirmed true does anything leave the machine, and only after the user has read the draft's text and said yes to filing it: with the GitHub CLI (gh) signed in it is filed under the user's account, otherwise the result is a link (url) for the user to open, with the text filled in. Without confirmed it returns what it would file and where. to: the number of an issue that reports the same bug (report_draft's existing), to add a comment there instead",
    input: {
      draft: text("The draft's path, as report_draft returned it (path)"),
      config: flagText("Path of the gateway's JSON config (default ./ot-gateway.json)"),
      to: Schema.optionalKey(count("An issue that reports the same bug: add a comment there", 1, 10_000_000)),
      confirmed: Schema.optionalKey(
        Schema.Boolean.annotate({
          description: "The user has read the text and agreed to file it publicly (default false: file nothing)"
        })
      ),
      link: Schema.optionalKey(
        Schema.Boolean.annotate({
          description: "Return the link to the filled-in issue form instead of filing with gh"
        })
      )
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    argv: ({ draft, config, to, confirmed, link }) => [
      "report",
      "send",
      draft,
      flag("config", config),
      flag("to", to),
      flag("yes", confirmed),
      flag("link", link)
    ]
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
    name: "setup_guide",
    title: "The setup guide",
    description:
      "The steps to take a user from nothing to a gateway publishing their devices' values: what to check, what to ask, the order, and the rules (never write to a device, no secrets in the config). Read it first when setting up a gateway; its otg <command> lines are this server's tools. Returns text: the guide as Markdown, starting with which tool each of its commands is",
    input: {},
    annotations: local,
    argv: () => ["guide", "setup", "--mcp"]
  }),
  defineTool({
    name: "init",
    title: "Write a gateway's folder",
    description:
      "Write a gateway's folder without asking anything: ot-gateway.json, ot-gateway.env (the broker password's line empty: the user fills it with ot-gateway secret set broker-password) and, on Linux, compose.yaml (on macOS and Windows, whose Docker Desktop reaches no device on the LAN, the gateway runs with start instead). To pick BACnet devices with the user: devices none here, then discover, then discover_save. Give site and broker, and devices or points; without them a run that writes (dryRun false) fails with missing, or pass yes for the defaults (a simulated device, a broker on localhost). dryRun defaults to true: work it out and return it, write nothing; a dry run fills what is not given with those defaults, so what it returns is not yet what the user chose. Returns the config, the files and next",
    input: {
      directory: optionalText("The gateway's folder, created if missing (default .)"),
      site: optionalText("The site, the first topic segment (a slug: site-1)"),
      building: optionalText("The building, the second topic segment"),
      broker: optionalText("The MQTT broker URL, mqtts:// for TLS"),
      username: optionalText("The broker username; its password never goes here"),
      passwordEnv: optionalText("The env variable the broker password is read from (default MQTT_PASSWORD)"),
      devices: Schema.optionalKey(
        Schema.Literals(["simulated", "discover", "none"]).annotate({
          description: "Where the devices come from: a simulated one, BACnet discovery, or none yet"
        })
      ),
      points: optionalText("Path of a points list (CSV or JSON) to take the devices from"),
      broadcast: optionalText("The broadcast address for BACnet discovery, when there are several networks"),
      statusPort: Schema.optionalKey(count("The status page's port (default 8080)", 1, 65_535)),
      history: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Keep every read for the status page's charts (default true)" })
      ),
      yes: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Take the defaults for whatever is not given, instead of failing" })
      ),
      force: Schema.optionalKey(Schema.Boolean.annotate({ description: "Replace a config that is there" })),
      dryRun: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Work it out and return it, write nothing (default true)" })
      )
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    argv: (input) => [
      "init",
      input.directory ?? ".",
      flag("site", input.site),
      flag("building", input.building),
      flag("broker", input.broker),
      flag("username", input.username),
      flag("password-env", input.passwordEnv),
      flag("devices", input.devices),
      flag("points", input.points),
      flag("broadcast", input.broadcast),
      flag("status-port", input.statusPort),
      flag("no-history", input.history === false),
      flag("yes", input.yes),
      flag("force", input.force),
      flag("dry-run", input.dryRun ?? true)
    ]
  }),
  defineTool({
    name: "clear_retained",
    title: "Clear a retained message",
    description:
      "Clear the retained message the broker keeps on one topic (an empty retained message there), as the gateway's user: what diff asks for after a device or point left or was renamed (its stale lists the topics). It sends nothing else: publishing a message of your own is not a tool, and a command to a device goes through write",
    input: { topic: text("The topic, without wildcards, as diff's stale lists it"), config: configArgument },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    argv: ({ topic, config }) => ["publish", topic, flag("config", config), "--retain"]
  }),
  defineTool({
    name: "secret_list",
    title: "Which secrets are set",
    description:
      "Which secrets the config needs (the broker password, the status page's edit token) and which ot-gateway.env has, by name only, never a value; missing lists the ones the gateway needs and lacks, and next the command the user runs to set each. There is no tool that sets a secret: the user types it into ot-gateway secret set, so it never passes through this conversation",
    input: { config: configArgument },
    annotations: local,
    argv: ({ config }) => ["secret", "list", flag("config", config)]
  }),
  defineTool({
    name: "up",
    title: "Start the gateway",
    description:
      "Start the gateway of the config's folder with Docker Compose (writes compose.yaml when the folder has none) and wait until every point has a value. Linux with Docker only: on macOS use start. isError with code, hint and next when values do not flow",
    input: { config: configArgument, timeout: Schema.optionalKey(waitSeconds) },
    annotations: deploys,
    argv: ({ config, timeout }) => ["up", config, flag("timeout", timeout)]
  }),
  defineTool({
    name: "start",
    title: "Start the gateway in the background",
    description:
      "Start the gateway of the config's folder as a background process on this machine and wait until every point has a value: the way on macOS, where Docker Desktop reaches no device on the LAN. It runs until stop, a crash or a reboot. Returns pid, url and values; isError with code (already-running, gateway-exited, device-failing, values-missing), hint and next when values do not flow",
    input: { config: configArgument, timeout: Schema.optionalKey(waitSeconds) },
    annotations: deploys,
    argv: ({ config, timeout }) => ["start", config, flag("timeout", timeout)]
  }),
  defineTool({
    name: "stop",
    title: "Stop the background gateway",
    description:
      "Stop the gateway that start runs in the background for the config's folder: no values are read or published until it is started again. stopped is false when none ran",
    input: { config: configArgument },
    annotations: { ...deploys, destructiveHint: true },
    argv: ({ config }) => ["stop", config]
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
