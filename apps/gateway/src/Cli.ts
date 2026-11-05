/**
 * The `ot-gateway` command line, on `effect/cli`:
 *
 *   ot-gateway demo                 the gateway with a test broker and simulated devices, in one process
 *   ot-gateway run [config]         run the gateway (config defaults to ot-gateway.json)
 *   ot-gateway check [config]       validate a config without connecting to anything
 *   ot-gateway discover [config]    find BACnet devices and print a draft of their config
 *
 * The forms from before the subcommands keep working, because the systemd unit, the image and scripts use
 * them: `ot-gateway path.json` runs, `--check path.json` checks and `--discover path.json` discovers.
 */
import { type GatewayConfig, mqttPasswordWarning } from "@ot-gateway/core"
import { Config, Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { runDemo } from "./Demo.ts"
import { discover } from "./Discover.ts"
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
    )
  },
  ({ listen }) => Effect.scoped(runDemo({ listen }, runConfigured))
).pipe(
  Command.withDescription("See it work: the gateway with a test MQTT broker and simulated devices, in one process"),
  Command.withExamples([
    { command: "ot-gateway demo", description: "Run the demo; the status page is at http://localhost:8080" }
  ])
)

export const cli = Command.make("ot-gateway").pipe(
  Command.withDescription("OT Gateway: Modbus TCP and BACnet/IP in, MQTT 5 out, safe commands back"),
  Command.withSubcommands([demo, run, check, discoverCommand])
)

const subcommands = new Set(["demo", "run", "check", "discover"])

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

/** Runs the command line for `argv` (without node and the script). */
export const runCli = (argv: ReadonlyArray<string>) =>
  Effect.flatMap(readVersion, (version) => Command.runWith(cli, { version })(toCliArgs(argv)))
