/**
 * The `ot-gateway` command line, on `effect/cli`:
 *
 *   ot-gateway demo                 the gateway with a test broker and simulated devices, in one process
 *   ot-gateway init [config]        answer a few questions, get a config (config defaults to ot-gateway.json)
 *   ot-gateway run [config]         run the gateway (config defaults to ot-gateway.json)
 *   ot-gateway check [config]       validate a config without connecting to anything
 *   ot-gateway discover [config]    find BACnet devices and print a draft of their config
 *   ot-gateway import <list> [config]  add the devices of a points list (CSV) to the config
 *   ot-gateway watch [config]       print what arrives at the config's broker
 *   ot-gateway status [--url]       the running gateway's status, one line per device
 *
 * The forms from before the subcommands keep working, because the systemd unit, the image and scripts use
 * them: `ot-gateway path.json` runs, `--check path.json` checks and `--discover path.json` discovers.
 */
import { type GatewayConfig, mqttPasswordWarning } from "@ot-gateway/core"
import { Config, Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { acceptsConnections, pickPublicBroker, randomDemoSite, runDemo } from "./Demo.ts"
import { discover } from "./Discover.ts"
import { importPointsList } from "./Import.ts"
import { writeFolderFiles } from "./Folder.ts"
import { nextSteps, runInit } from "./Init.ts"
import { statusReport } from "./StatusReport.ts"
import { watch } from "./Watch.ts"
import { runGateway } from "./Gateway.ts"
import { liveHostSources } from "./Host.ts"
import { loadConfig } from "./LoadConfig.ts"
import { telemetryLayer } from "./Telemetry.ts"
import { readVersion } from "./Version.ts"

/** What `check` prints: the gateway the config describes, one line per device, and what start-up would warn about. */
export const describeConfig = (config: GatewayConfig) => {
  const passwordWarning = mqttPasswordWarning(config.mqtt)
  return [
    `config ok: ${config.site}/${config.building}, gateway ${config.id}, broker ${config.mqtt.url}`,
    ...(passwordWarning === undefined ? [] : [`  warning: ${passwordWarning}`]),
    config.buffer === undefined
      ? "  no buffer: values read while the broker is down are lost"
      : `  buffer ${config.buffer.path}`,
    ...config.devices.map((device) => {
      const where =
        device.protocol === "modbus-tcp"
          ? `${device.host}:${device.port} unit ${device.unitId}`
          : device.protocol === "bacnet-ip"
            ? `device ${device.deviceInstance}${device.address === undefined ? " (discovered)" : ` at ${device.address}`}`
            : "simulated"
      const writable = device.points.filter((point) => point.writable).length
      return `  ${device.id}: ${device.protocol} ${where}, ${device.points.length} point(s)${writable > 0 ? `, ${writable} writable` : ""}, every ${device.pollIntervalMs} ms`
    })
  ].join("\n")
}

/** The gateway for `config`, with host monitoring and telemetry, until it is stopped. */
const runConfigured = Effect.fn("runConfigured")(function* (config: GatewayConfig) {
  const version = yield* readVersion
  yield* Effect.scoped(Effect.flatMap(liveHostSources, (host) => runGateway(config, { host, version }))).pipe(
    Effect.provide(telemetryLayer(config, version))
  )
})

const configPath = Argument.String("config").pipe(
  Argument.withDescription("Path of the gateway's JSON config"),
  Argument.withDefault("ot-gateway.json")
)

const run = Command.make("run", { config: configPath }, ({ config }) =>
  Effect.flatMap(loadConfig(config), runConfigured)
).pipe(
  Command.withDescription("Run the gateway: poll the devices in the config and publish to its broker"),
  Command.withExamples([{ command: "ot-gateway run /etc/ot-gateway/gateway.json", description: "Run a config" }])
)

const check = Command.make("check", { config: configPath }, ({ config }) =>
  Effect.flatMap(loadConfig(config), (decoded) => Console.log(describeConfig(decoded)))
).pipe(Command.withDescription("Validate a config without connecting to anything; lists every mistake with its path"))

const discoverCommand = Command.make("discover", { config: configPath }, ({ config }) =>
  Effect.flatMap(loadConfig(config), discover)
).pipe(
  Command.withDescription(
    "Find BACnet devices through the config's bacnet settings and print a draft of their devices entries, read-only"
  )
)

const demo = Command.make(
  "demo",
  {
    listen: Flag.String("listen").pipe(
      Flag.withDescription("Address of the status page: 127.0.0.1, or 0.0.0.0 to reach it through a published port"),
      Flag.withFallbackConfig(Config.String("OT_GATEWAY_DEMO_LISTEN")),
      Flag.withDefault("127.0.0.1")
    ),
    public: Flag.Boolean("public").pipe(
      Flag.withDescription(
        "Publish the simulated data to a public test broker (broker.hivemq.com, …), to watch it from any MQTT client"
      ),
      Flag.withDefault(false)
    )
  },
  (flags) =>
    Effect.gen(function* () {
      const remote = flags.public
        ? { broker: yield* pickPublicBroker(acceptsConnections), site: yield* randomDemoSite }
        : undefined
      yield* runDemo({ listen: flags.listen, public: remote }, runConfigured)
    }).pipe(Effect.scoped)
).pipe(
  Command.withDescription("See it work: the gateway with a test MQTT broker and simulated devices, in one process"),
  Command.withExamples([
    { command: "ot-gateway demo", description: "Run the demo; the status page is at http://localhost:8080" },
    { command: "ot-gateway demo --public", description: "The same, published to a public test broker" }
  ])
)

const init = Command.make("init", { config: configPath }, ({ config }) =>
  Effect.gen(function* () {
    const written = yield* runInit(config)
    if (written === undefined) return yield* Console.log(`kept ${config} as it is`)
    const folder = yield* writeFolderFiles(config, written)
    yield* Console.log(describeConfig(written))
    yield* Console.log(nextSteps(config, written, { ...folder, written: [config, ...folder.written] }))
  }).pipe(Effect.catchTag("QuitError", () => Console.error("init cancelled, nothing written")))
).pipe(
  Command.withDescription("Answer a few questions (site, broker, devices) and get a config that check accepts"),
  Command.withExamples([{ command: "ot-gateway init", description: "Write ot-gateway.json in this directory" }])
)

const importCommand = Command.make(
  "import",
  {
    list: Argument.String("points-list").pipe(
      Argument.withDescription("A CSV with a device and a point column, one row per point")
    ),
    config: configPath,
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the devices instead of adding them to the config"),
      Flag.withDefault(false)
    )
  },
  ({ list, config, dryRun }) =>
    Effect.gen(function* () {
      const { added, config: written } = yield* importPointsList(list, config, { dryRun })
      if (written === undefined) return
      const points = added.reduce((total, device) => total + device.points.length, 0)
      yield* Console.log(`added ${added.length} device(s) with ${points} point(s) to ${config}, none writable`)
      yield* Console.log(describeConfig(written))
    })
).pipe(
  Command.withDescription(
    "Add the devices of a points list (CSV: device, point, host, register, type, unit, …) to the config"
  ),
  Command.withExamples([
    { command: "ot-gateway import points.csv", description: "Add them to ot-gateway.json" },
    { command: "ot-gateway import points.csv --dry-run", description: "Only print them" }
  ])
)

const watchCommand = Command.make(
  "watch",
  {
    config: configPath,
    topic: Flag.String("topic").pipe(
      Flag.withDescription("A topic filter instead of site/building/# (# for everything on the broker)"),
      Flag.optional
    )
  },
  ({ config, topic }) =>
    Effect.flatMap(loadConfig(config), (decoded) => watch(decoded, { topic: Option.getOrUndefined(topic) }))
).pipe(
  Command.withDescription("Print what arrives at the config's broker under its site and building, as it arrives"),
  Command.withExamples([
    { command: "ot-gateway watch", description: "Watch the broker in ot-gateway.json" },
    { command: "ot-gateway watch --topic 'my-site/main/ahu-1/#'", description: "Only one device" }
  ])
)

const status = Command.make(
  "status",
  {
    url: Flag.String("url").pipe(
      Flag.withDescription("Where the gateway's status page is"),
      Flag.withDefault("http://127.0.0.1:8080")
    )
  },
  ({ url }) => statusReport(url)
).pipe(Command.withDescription("The running gateway's status: its broker, buffer and one line per device"))

export const cli = Command.make("ot-gateway").pipe(
  Command.withDescription("OT Gateway: Modbus TCP and BACnet/IP in, MQTT 5 out, safe commands back"),
  Command.withSubcommands([demo, init, run, check, discoverCommand, importCommand, watchCommand, status])
)

const subcommands = new Set(["demo", "init", "run", "check", "discover", "import", "watch", "status"])

/**
 * The arguments for `cli`, with the forms from before the subcommands translated: no arguments or a config path
 * is `run`, and `--check` or `--discover` anywhere is that subcommand.
 */
export const toCliArgs = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [first] = argv
  if (first !== undefined && (subcommands.has(first) || (first.startsWith("-") && !legacyFlags.has(first)))) {
    return argv
  }
  for (const flag of legacyFlags) {
    if (argv.includes(flag)) return [flag.slice(2), ...argv.filter((arg) => arg !== flag)]
  }
  return ["run", ...argv]
}

const legacyFlags = new Set(["--check", "--discover"])

/** The version as `--version` gets it: the CLI prints `v` before it, and a release tag already starts with one. */
export const cliVersion = (version: string) => version.replace(/^v(?=\d)/, "")

/** Runs the command line for `argv` (without node and the script). */
export const runCli = (argv: ReadonlyArray<string>) =>
  Effect.flatMap(readVersion, (version) => Command.runWith(cli, { version: cliVersion(version) })(toCliArgs(argv)))
