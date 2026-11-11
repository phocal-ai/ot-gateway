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
 *   ot-gateway broker [config]      which MQTT the config's broker speaks, what it allows, a round trip
 *   ot-gateway publish <topic> [payload]  one message to the config's broker (empty and --retain clears)
 *   ot-gateway status [config]      the running gateway's status, one line per device (exit 1 when failing)
 *   ot-gateway events [config]      what changed lately: devices failing and recovering, the broker lost and back
 *   ot-gateway history <device/point> [config]  what a point did lately, from the gateway's history
 *   ot-gateway messages [device/point] [config]  what the gateway published per topic since it started
 *
 * A config is a positional argument after the others, as `ot-gateway.json` in this folder when left out. `publish`
 * is the exception, since its positionals are the topic and the payload: it takes `--config`, and refuses a payload
 * that is the path of a JSON file, which is a config meant for `--config` (with `--retain` it would otherwise stay
 * on the broker). `messages` takes `--config` too, as it did first.
 *
 * The forms from before the subcommands keep working, because the systemd unit, the image and scripts use
 * them: `ot-gateway path.json` runs, `--check path.json` checks and `--discover path.json` discovers.
 */
import { covPointIds, type Device, type GatewayConfig, mqttPasswordWarning } from "@ot-gateway/core"
import { Config, Console, Effect, FileSystem, Option, References } from "effect"
import { Argument, CliOutput, Command, Flag } from "effect/cli"
import { acceptsConnections, pickPublicBroker, randomDemoSite, runDemo } from "./Demo.ts"
import { discover, DiscoverError, discoverToPointsList, type PointsListWritten } from "./Discover.ts"
import { describeTranslation, edeToPointsList } from "./Ede.ts"
import { defaultConfigPath, describeUnits, importPointsList } from "./Import.ts"
import { writeFolderFiles } from "./Folder.ts"
import { initNext, initTarget, isInteractive, nextSteps, runInit, sshSession } from "./Init.ts"
import { invocation } from "./Invocation.ts"
import { describePointsListSchema, pointsListSchema, pointsListTemplate } from "./PointsSchema.ts"
import { eventsReport, fetchStatusFor, parseSince, statusOutcome } from "./StatusReport.ts"
import { DEFAULT_STATUS_URL, resolveTarget } from "./GatewayTarget.ts"
import { historyReport, parseSelection } from "./HistoryReport.ts"
import { messagesReport } from "./MessagesReport.ts"
import { watch } from "./Watch.ts"
import {
  BrokerCommandError,
  type BrokerReport,
  checkBroker,
  formatBrokerReport,
  formatPublished,
  publishOnce,
  roundTripFailure
} from "./Broker.ts"
import { runGateway } from "./Gateway.ts"
import { liveHostSources } from "./Host.ts"
import { ConfigFileError, configFileSource, loadConfig } from "./LoadConfig.ts"
import { closestMatch } from "./Suggest.ts"
import {
  describeProfile,
  describeProfileFormat,
  libraryProfiles,
  profileJsonSchema,
  resolveProfile
} from "./Profile.ts"
import { telemetryLayer } from "./Telemetry.ts"
import { failureLine, printJson } from "./Output.ts"
import { readVersion } from "./Version.ts"

const optionalEnv = (name: string) => Config.String(name).pipe(Config.option, Config.map(Option.getOrUndefined))

/** Whether the CLI runs over SSH, and as whom: init's next steps then add the tunnel to the status page. */
const sshEnvironment = Config.all({
  SSH_CONNECTION: optionalEnv("SSH_CONNECTION"),
  SSH_CLIENT: optionalEnv("SSH_CLIENT"),
  USER: optionalEnv("USER"),
  LOGNAME: optionalEnv("LOGNAME")
})

/**
 * How a device's points are read, as configured: polled every `pollIntervalMs`, or for a BACnet device with `cov`,
 * by change of value with polling as the fallback. Configuration intent: whether the device sends change-of-value
 * notifications only the running gateway finds out, and they may come more often than the poll interval.
 */
export const readingLabel = (device: Device) => {
  const cov = covPointIds(device).length
  const polled = `every ${device.pollIntervalMs} ms`
  if (cov === 0) return polled
  const which = cov === device.points.length ? "COV" : `${cov} by COV`
  return `${which} where the device supports it, polled ${polled} otherwise`
}

/** What `check` prints: the gateway the config describes, one line per device, and what start-up would warn about. */
export const describeConfig = (config: GatewayConfig) => {
  const passwordWarning = mqttPasswordWarning(config.mqtt)
  return [
    `config ok: ${config.site}/${config.building}, gateway ${config.id}, broker ${config.mqtt.url}`,
    ...(passwordWarning === undefined ? [] : [`  warning: ${passwordWarning}`]),
    config.buffer === undefined
      ? "  no buffer: values read while the broker is down are lost"
      : `  buffer ${config.buffer.path}`,
    ...(config.history === undefined
      ? []
      : [`  history ${config.history.path}, per-minute values for ${config.history.retentionDays} days`]),
    ...config.devices.map((device) => {
      const where =
        device.protocol === "modbus-tcp"
          ? `${device.host}:${device.port} unit ${device.unitId}`
          : device.protocol === "bacnet-ip"
            ? `device ${device.deviceInstance}${device.address === undefined ? " (discovered)" : ` at ${device.address}`}`
            : "simulated"
      const writable = device.points.filter((point) => point.writable).length
      const alarms = alarmPointIds(device).length
      const reading = readingLabel(device)
      return `  ${device.id}: ${device.protocol} ${where}, ${device.points.length} point(s)${writable > 0 ? `, ${writable} writable` : ""}${alarms > 0 ? `, ${alarms} alarm(s)` : ""}${covPointIds(device).length > 0 ? ": " : ", "}${reading}`
    })
  ].join("\n")
}

/** What `check --json` prints for a valid config: the same as `describeConfig`, for scripts and agents. */
export const configSummary = (config: GatewayConfig) => {
  const passwordWarning = mqttPasswordWarning(config.mqtt)
  return {
    ok: true as const,
    site: config.site,
    building: config.building,
    gateway: config.id,
    broker: config.mqtt.url,
    buffer: config.buffer?.path ?? null,
    history: config.history?.path ?? null,
    warnings: [
      ...(passwordWarning === undefined ? [] : [passwordWarning]),
      ...(config.buffer === undefined ? ["no buffer: values read while the broker is down are lost"] : [])
    ],
    devices: config.devices.map(deviceSummary)
  }
}

/** The points of a device marked as alarms (`alarmWhen`), in config order. */
const alarmPointIds = (device: Device) =>
  device.points.flatMap((point) => (point.alarmWhen === undefined ? [] : [point.id]))

/**
 * One device in `check --json` and `import --json`: `alarmPoints` are the points marked as alarms (`alarmWhen`, a
 * points list's `alarm` column), `covPoints` are the points asked for by change of value (BACnet
 * present values with `cov` on), polled every `pollIntervalMs` while the device does not notify; the rest are polled.
 */
export const deviceSummary = (device: Device) => ({
  id: device.id,
  protocol: device.protocol,
  points: device.points.length,
  writable: device.points.filter((point) => point.writable).length,
  pollIntervalMs: device.pollIntervalMs,
  covPoints: covPointIds(device),
  alarmPoints: alarmPointIds(device),
  reading: readingLabel(device)
})

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print the result as JSON, for scripts and agents; a failure too, as {ok: false, error}"),
  Flag.withDefault(false)
)

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** With --json, a failure is JSON on stdout as well; it still fails, so the exit code stays 1. */
const jsonFailure =
  (json: boolean, fields: Readonly<Record<string, unknown>> = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    json
      ? effect.pipe(Effect.tapError((error) => printJson({ ok: false, ...fields, error: errorText(error) })))
      : effect

const dryRunFlag = (description: string) =>
  Flag.Boolean("dry-run").pipe(Flag.withDescription(description), Flag.withDefault(false))

/**
 * The gateway for `config`, with host monitoring and telemetry, until it is stopped. With the file it came from,
 * the status page can edit it.
 */
const runConfigured = Effect.fn("runConfigured")(function* (config: GatewayConfig, path?: string) {
  const version = yield* readVersion
  const configFile = path === undefined ? undefined : yield* configFileSource(path)
  return yield* Effect.scoped(
    Effect.flatMap(liveHostSources, (host) =>
      runGateway(config, { host, version, ...(configFile === undefined ? {} : { configFile }) })
    )
  ).pipe(Effect.provide(telemetryLayer(config, version)))
})

const configPath = Argument.String("config").pipe(
  Argument.withDescription("Path of the gateway's JSON config"),
  Argument.withDefault("ot-gateway.json")
)

const run = Command.make("run", { config: configPath }, ({ config }) =>
  loadConfig(config).pipe(
    // `ot-gateway chek` reaches run as a config path (the form from before subcommands): name the command meant.
    Effect.catchTag("ConfigFileError", (error) => {
      const meant = config.includes(".") || config.includes("/") ? undefined : closestMatch(config, subcommands)
      return Effect.fail(
        meant === undefined
          ? error
          : new ConfigFileError({
              path: config,
              message: `${config} is not a command; did you mean ot-gateway ${meant}?`
            })
      )
    }),
    Effect.flatMap((loaded) => runConfigured(loaded, config))
  )
).pipe(
  Command.withDescription("Run the gateway: poll the devices in the config and publish to its broker"),
  Command.withExamples([{ command: "ot-gateway run /etc/ot-gateway/gateway.json", description: "Run a config" }])
)

const check = Command.make("check", { config: configPath, json: jsonFlag }, ({ config, json }) =>
  loadConfig(config).pipe(
    Effect.flatMap((decoded) => (json ? printJson(configSummary(decoded)) : Console.log(describeConfig(decoded)))),
    jsonFailure(json, { path: config })
  )
).pipe(Command.withDescription("Validate a config without connecting to anything; lists every mistake with its path"))

/** What `discover --points-list` prints on stdout: with --json its outcome; without, stderr has said it already. */
export const pointsListOutcome = (json: boolean) => (written: PointsListWritten) =>
  json ? printJson({ ok: true, ...written }) : Effect.void

const discoverCommand = Command.make(
  "discover",
  {
    config: configPath,
    pointsList: Flag.String("points-list").pipe(
      Flag.withDescription("Write the devices found as a points list (CSV) to this file, to trim and import"),
      Flag.optional
    ),
    append: Flag.Boolean("append").pipe(
      Flag.withDescription(
        "Add to the --points-list file when it exists (its columns, separator and rows kept; rows it has are skipped)"
      ),
      Flag.withDefault(false)
    ),
    address: Flag.String("address").pipe(
      Flag.withDescription(
        "Ask only the device at this ip or ip:port, instead of a broadcast: one on another subnet or another port"
      ),
      Flag.optional
    ),
    json: jsonFlag
  },
  // The draft is JSON already; --json makes a failure JSON too, and what --points-list wrote.
  ({ config, pointsList, append, address, json }) =>
    Effect.gen(function* () {
      if (append && Option.isNone(pointsList)) {
        return yield* new DiscoverError({ message: "--append adds to the file --points-list names; give both" })
      }
      const decoded = yield* loadConfig(config)
      const options = {
        address: Option.getOrUndefined(address),
        append,
        configPath: config,
        command: yield* invocation
      }
      return Option.isSome(pointsList)
        ? yield* Effect.flatMap(
            discoverToPointsList(decoded, pointsList.value, undefined, options),
            pointsListOutcome(json)
          )
        : yield* discover(decoded, undefined, options)
    }).pipe(jsonFailure(json, { path: config }))
).pipe(
  Command.withDescription(
    "Find BACnet devices through the config's bacnet settings and print a draft of their devices entries, read-only"
  ),
  Command.withExamples([
    { command: "ot-gateway discover", description: "Print the draft as JSON, in the config's shape" },
    { command: "ot-gateway discover --points-list points.csv", description: "Write it as a points list to trim" },
    {
      command: "ot-gateway discover --points-list points.csv --append",
      description: "Add it to a points list you have, rows it has already skipped"
    },
    {
      command: "ot-gateway discover --address 10.20.3.40:47809",
      description: "Ask one device whose address a device list gives"
    }
  ])
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
    }).pipe(
      Effect.scoped,
      // Nothing has run yet: one plain line, like a one-shot command's answer, not a log line.
      Effect.catchTag("DemoPortInUse", (error) =>
        Console.error(failureLine(error.message)).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1))))
      )
    )
).pipe(
  Command.withDescription("See it work: the gateway with a test MQTT broker and simulated devices, in one process"),
  Command.withExamples([
    { command: "ot-gateway demo", description: "Run the demo; the status page is at http://localhost:8080" },
    { command: "ot-gateway demo --public", description: "The same, published to a public test broker" }
  ])
)

const optionalFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional, Flag.map(Option.getOrUndefined))

const init = Command.make(
  "init",
  {
    directory: Argument.String("directory").pipe(
      Argument.withDescription("The gateway's folder, created if missing (. for this one); asked for when left out"),
      Argument.optional,
      Argument.map(Option.getOrUndefined)
    ),
    site: optionalFlag("site", "The site, the first topic segment (a slug: site-1)"),
    building: optionalFlag("building", "The building, the second topic segment"),
    broker: optionalFlag("broker", "The MQTT broker URL, mqtts:// for TLS"),
    username: optionalFlag("username", "The broker username"),
    passwordEnv: optionalFlag("password-env", "The env variable for the broker password (default MQTT_PASSWORD)"),
    devices: Flag.Literals("devices", ["simulated", "discover", "none"]).pipe(
      Flag.withDescription("Where the devices come from: a simulated one, BACnet discovery, or none yet"),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
    points: optionalFlag("points", "A points list (CSV) to take the devices from"),
    broadcast: optionalFlag("broadcast", "The broadcast address for BACnet discovery, when there are several networks"),
    yes: Flag.Boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Ask nothing: the defaults for whatever no flag gives (the same without a terminal)"),
      Flag.withDefault(false)
    ),
    force: Flag.Boolean("force").pipe(Flag.withDescription("Replace an existing config"), Flag.withDefault(false)),
    history: Flag.Boolean("history").pipe(
      Flag.withDescription(
        "Keep every read on the gateway for the status page's charts and /api/history (on; --no-history leaves it out)"
      ),
      Flag.withDefault(true)
    ),
    dryRun: dryRunFlag("Work out the config and the files, print them, and write nothing"),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Ask nothing and print the result as JSON (a failure too), for scripts and agents"),
      Flag.withDefault(false)
    )
  },
  ({ directory, json, ...given }) =>
    Effect.gen(function* () {
      // Without a terminal (an AI agent, a script, CI) there is nobody to answer: ask nothing, as with --yes.
      const interactive = !json && isInteractive(given.yes, process.stdin.isTTY)
      if (!given.yes && !json && !interactive) {
        yield* Console.error(
          "no terminal, so init asks nothing: the flags answer and the defaults fill the rest (--help lists the flags)"
        )
      }
      const flags = { ...given, yes: !interactive }
      const config = yield* initTarget(directory, flags.yes)
      const written = yield* runInit(config, flags)
      if (written === undefined) return yield* Console.log(`kept ${config} as it is`)
      const folder = yield* writeFolderFiles(config, written, { dryRun: flags.dryRun })
      const files = { ...folder, written: [config, ...folder.written] }
      const context = {
        ssh: sshSession(yield* sshEnvironment),
        platform: process.platform,
        cwd: process.cwd(),
        command: yield* invocation
      }
      if (json) {
        const { notes, next, url, page } = initNext(config, written, files, context)
        return yield* printJson({
          ...configSummary(written),
          dryRun: flags.dryRun,
          path: config,
          files: { [flags.dryRun ? "wouldWrite" : "written"]: files.written, kept: files.kept },
          ...(folder.noCompose === undefined ? {} : { noCompose: folder.noCompose }),
          ...(flags.dryRun ? { config: written } : {}),
          notes,
          next,
          url,
          page
        })
      }
      if (flags.dryRun) {
        yield* Console.log(`${JSON.stringify(written, null, 2)}\n`)
        yield* Console.log(describeConfig(written))
        return yield* Console.log(
          [`dry run, nothing written. It would write:`, ...files.written.map((file) => `  ${file}`)].join("\n")
        )
      }
      yield* Console.log(describeConfig(written))
      yield* Console.log(nextSteps(config, written, files, context))
    }).pipe(
      jsonFailure(json),
      Effect.catchTag("QuitError", () =>
        Console.error("init cancelled, nothing written").pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1))))
      )
    )
).pipe(
  Command.withDescription(
    "Answer a few questions (site, broker, devices) and get the gateway's folder: ot-gateway.json, compose.yaml, ot-gateway.env"
  ),
  Command.withExamples([
    {
      command: "ot-gateway init site-1",
      description: "Make the folder site-1 and write the gateway's files in it"
    },
    { command: "ot-gateway init .", description: "Write them in this folder" },
    {
      command: "ot-gateway init site-1 --yes --site site-1 --broker mqtts://broker.example:8883 --points points.csv",
      description: "The same without questions, for scripts and agents"
    },
    { command: "ot-gateway init site-1 --json --dry-run --site site-1", description: "Only show it, as JSON" }
  ])
)

const importCommand = Command.make(
  "import",
  {
    list: Argument.String("points-list").pipe(
      Argument.withDescription("A CSV with a device and a point column, one row per point")
    ),
    // Optional rather than defaulted: a dry run that names no config may check the list on its own.
    config: Argument.String("config").pipe(
      Argument.withDescription(
        `Path of the gateway's JSON config (default ${defaultConfigPath}); it must exist, ot-gateway init writes one`
      ),
      Argument.optional,
      Argument.map(Option.getOrUndefined)
    ),
    dryRun: dryRunFlag(
      "Check the list and print its devices instead of adding them; without a config named or here, on their own"
    ),
    json: jsonFlag
  },
  ({ list, config, dryRun, json }) =>
    Effect.gen(function* () {
      const {
        added,
        decoded,
        config: written,
        against,
        units
      } = yield* importPointsList(list, config, {
        dryRun,
        command: yield* invocation
      })
      const points = added.reduce((total, device) => total + device.points.length, 0)
      const alone = `no ${defaultConfigPath} here, so the devices were checked on their own; name a config to check them against it`
      if (json) {
        return yield* printJson({
          ok: true,
          dryRun,
          path: against ?? null,
          ...(against === undefined ? { note: alone } : {}),
          points,
          units,
          devices: added,
          summary: decoded.map(deviceSummary)
        })
      }
      if (against === undefined) yield* Console.error(alone)
      // A dry run prints the devices as JSON on stdout, so the units go to stderr there.
      const unitLines = describeUnits(units)
      if (written === undefined) {
        if (unitLines.length > 0) yield* Console.error(unitLines.join("\n"))
        return yield* printJson({ devices: added })
      }
      yield* Console.log(`added ${added.length} device(s) with ${points} point(s) to ${against}, none writable`)
      if (unitLines.length > 0) yield* Console.log(unitLines.join("\n"))
      yield* Console.log(describeConfig(written))
    }).pipe(jsonFailure(json, { path: config ?? defaultConfigPath }))
).pipe(
  Command.withDescription(
    "Add the devices of a points list (CSV: device, point, host, register, type, unit, …) to the config"
  ),
  Command.withExamples([
    { command: "ot-gateway import points.csv", description: "Add them to ot-gateway.json" },
    { command: "ot-gateway import points.csv site-1/ot-gateway.json", description: "Add them to another config" },
    { command: "ot-gateway import points.csv --dry-run", description: "Only check and print them" }
  ])
)

const schemaCommand = Command.make("schema", { json: jsonFlag }, ({ json }) =>
  json ? printJson(pointsListSchema()) : Console.log(describePointsListSchema())
).pipe(Command.withDescription("The points list's columns, rules and allowed values"))

const templateCommand = Command.make("template", {}, () =>
  Effect.sync(() => process.stdout.write(pointsListTemplate()))
).pipe(
  Command.withDescription("A points list with every column and example rows, as CSV on stdout"),
  Command.withExamples([{ command: "ot-gateway points template > points.csv", description: "Start a list to fill in" }])
)

const fromEdeCommand = Command.make(
  "from-ede",
  { file: Argument.String("ede-file").pipe(Argument.withDescription("A BACnet EDE file (CSV, semicolons)")) },
  ({ file }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const translation = yield* edeToPointsList(yield* fs.readFileString(file))
      yield* Console.error(describeTranslation(file, translation))
      yield* Effect.sync(() => process.stdout.write(translation.list))
    })
).pipe(
  Command.withDescription("A BACnet EDE file as a points list on stdout, to trim before import (import reads EDE too)"),
  Command.withExamples([
    { command: "ot-gateway points from-ede building.csv > points.csv", description: "Translate it, then trim it" }
  ])
)

const profilesList = Command.make("list", { json: jsonFlag }, ({ json }) =>
  Effect.gen(function* () {
    const profiles = yield* libraryProfiles()
    if (json) {
      return yield* printJson(
        profiles.map(({ id, vendor, model, verified, points }) => ({
          id,
          vendor,
          model,
          verified,
          points: points.length
        }))
      )
    }
    const width = Math.max(...profiles.map((profile) => profile.id.length)) + 2
    yield* Console.log(
      profiles
        .map(
          (profile) =>
            `${profile.id.padEnd(width)}${profile.vendor} ${profile.model}, ${profile.points.length} points${profile.verified ? "" : ", from its register map (not yet checked on a device)"}`
        )
        .join("\n")
    )
  }).pipe(jsonFailure(json))
).pipe(Command.withDescription("The device profiles a points list can name in its profile column"))

const profilesShow = Command.make(
  "show",
  {
    profile: Argument.String("profile").pipe(Argument.withDescription("A profile id, or a path ending in .json")),
    json: jsonFlag
  },
  ({ profile, json }) =>
    Effect.gen(function* () {
      const found = yield* resolveProfile(profile, { relativeTo: process.cwd() })
      if (json) return yield* printJson(found)
      yield* Console.log(describeProfile(found))
    }).pipe(jsonFailure(json))
).pipe(
  Command.withDescription("One profile's points: names, registers, types and units"),
  // `get`, as other CLIs name reading one thing.
  Command.withAlias("get"),
  Command.withExamples([{ command: "ot-gateway profiles show eastron-sdm630", description: "The SDM630's points" }])
)

const profilesSchema = Command.make("schema", { json: jsonFlag }, ({ json }) =>
  json ? printJson(profileJsonSchema()) : Console.log(describeProfileFormat())
).pipe(Command.withDescription("The profile format, to write one from a register map"))

const profiles = Command.make("profiles").pipe(
  Command.withDescription("Device profiles: a Modbus model's registers, named once and reused by points lists"),
  Command.withSubcommands([profilesList, profilesShow, profilesSchema])
)

const points = Command.make("points").pipe(
  Command.withDescription("The points list, the CSV that import and init read: its schema and a template"),
  Command.withSubcommands([schemaCommand, templateCommand, fromEdeCommand])
)

const watchCommand = Command.make(
  "watch",
  {
    config: configPath,
    topic: Flag.String("topic").pipe(
      Flag.withDescription("A topic filter instead of site/building/# (# for everything on the broker)"),
      Flag.optional
    ),
    seconds: Flag.Int("seconds").pipe(
      Flag.withDescription("Stop after this many seconds instead of at Ctrl-C, for scripts and agents"),
      Flag.filter(
        (seconds) => seconds >= 1,
        (seconds) => `--seconds takes 1 or more, not ${seconds}`
      ),
      Flag.optional
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("One JSON object per message and line (NDJSON): at, topic, retained, payload"),
      Flag.withDefault(false)
    )
  },
  ({ config, topic, seconds, json }) =>
    Effect.flatMap(loadConfig(config), (decoded) =>
      watch(decoded, { topic: Option.getOrUndefined(topic), seconds: Option.getOrUndefined(seconds), json })
    ).pipe(jsonFailure(json, { path: config }))
).pipe(
  Command.withDescription("Print what arrives at the config's broker under its site and building, as it arrives"),
  Command.withExamples([
    { command: "ot-gateway watch", description: "Watch the broker in ot-gateway.json" },
    { command: "ot-gateway watch --topic 'site-1/building-a/heat-pump/#'", description: "Only one device" },
    { command: "ot-gateway watch --seconds 10", description: "Ten seconds of it, then stop" },
    { command: "ot-gateway watch --seconds 10 --json", description: "The same as JSON lines, for scripts and agents" }
  ])
)

/**
 * `broker`'s report, as JSON or text, then a failure when its message did not come back, so the exit code is 1.
 * The failure comes after the output and outside `jsonFailure`, so the report is printed once and is the JSON.
 */
export const brokerOutcome = (json: boolean) =>
  Effect.fnUntraced(function* (report: BrokerReport) {
    yield* json ? printJson(report) : Console.log(formatBrokerReport(report))
    if (!report.ok) return yield* roundTripFailure(report)
  })

const brokerCommand = Command.make("broker", { config: configPath, json: jsonFlag }, ({ config, json }) =>
  loadConfig(config).pipe(
    Effect.flatMap(checkBroker),
    jsonFailure(json, { path: config }),
    Effect.flatMap(brokerOutcome(json))
  )
).pipe(
  Command.withDescription(
    "Connect to the config's broker: the MQTT it speaks (5 or 3.1.1), what it allows, and a message there and back"
  ),
  Command.withExamples([
    { command: "ot-gateway broker", description: "Check the broker in ot-gateway.json" },
    { command: "ot-gateway broker /etc/ot-gateway/gateway.json --json", description: "Another config, as JSON" }
  ])
)

/**
 * `publish <topic> config.json` reads the path as the payload, the config being a flag here: a payload that names
 * an existing `.json` file is refused, naming `--config`, before anything is sent.
 */
export const refuseConfigAsPayload = Effect.fnUntraced(function* (payload: string) {
  const trimmed = payload.trim()
  if (!trimmed.toLowerCase().endsWith(".json") || /[\s{}"]/.test(trimmed)) return
  const fs = yield* FileSystem.FileSystem
  const isFile = yield* fs.stat(trimmed).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.catchTag("PlatformError", () => Effect.succeed(false))
  )
  if (!isFile) return
  return yield* new BrokerCommandError({
    message: `${trimmed} is a file, not a message: publish takes the config as --config ${trimmed} (ot-gateway publish <topic> [payload] --config ${trimmed}). Nothing was sent.`
  })
})

/**
 * `messages [points] [config]`: the config positional after the points, or the only positional when it ends in
 * `.json`, or `--config`; two different ones are a mistake.
 */
export const messagesArguments = (
  pointsText: string | undefined,
  positional: string | undefined,
  flag: string | undefined
): { readonly points?: string; readonly config?: string } | { readonly error: string } => {
  const pointsIsConfig =
    positional === undefined && pointsText !== undefined && pointsText.toLowerCase().endsWith(".json")
  const config = pointsIsConfig ? pointsText : positional
  const selection = pointsIsConfig ? undefined : pointsText
  if (config !== undefined && flag !== undefined && config !== flag) {
    return { error: `two configs: ${config} and --config ${flag}; name one` }
  }
  const chosen = config ?? flag
  return {
    ...(selection === undefined ? {} : { points: selection }),
    ...(chosen === undefined ? {} : { config: chosen })
  }
}

const publishCommand = Command.make(
  "publish",
  {
    topic: Argument.String("topic").pipe(Argument.withDescription("The topic, without wildcards")),
    payload: Argument.String("payload").pipe(
      Argument.withDescription("The message; empty when left out"),
      Argument.withDefault("")
    ),
    config: Flag.String("config").pipe(
      Flag.withDescription("Path of the gateway's JSON config"),
      Flag.withDefault("ot-gateway.json")
    ),
    retain: Flag.Boolean("retain").pipe(
      Flag.withDescription(
        "Ask the broker to keep it for later subscribers; an empty retained message clears the topic"
      ),
      Flag.withDefault(false)
    ),
    qos: Flag.ChoiceWithValue("qos", [
      ["0", 0],
      ["1", 1]
    ] as const).pipe(
      Flag.withDescription("0 sends and forgets, 1 waits until the broker confirmed it"),
      Flag.withDefault(1 as const)
    ),
    json: jsonFlag
  },
  ({ topic, payload, config, retain, qos, json }) =>
    refuseConfigAsPayload(payload).pipe(
      Effect.andThen(loadConfig(config)),
      Effect.flatMap((decoded) => publishOnce(decoded, topic, payload, { retain, qos })),
      Effect.flatMap((result) => (json ? printJson(result) : Console.log(formatPublished(result)))),
      jsonFailure(json, { topic })
    )
).pipe(
  Command.withDescription("Send one message to the config's broker, as the gateway's user"),
  Command.withExamples([
    { command: "ot-gateway publish my-site/main/test hello", description: "A message, QoS 1" },
    {
      command: "ot-gateway publish 'my-site/main/old-device/temp/$meta' --retain",
      description: "Clear a retained message the broker keeps for a device that is gone"
    }
  ])
)

const urlFlag = Flag.String("url").pipe(
  Flag.withDescription(
    `Ask the status page at this address instead of the one the config's status block gives (without a config: ${DEFAULT_STATUS_URL})`
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined)
)

/** The config of the gateway to ask, for status, events and history: optional, as `ot-gateway.json` is found. */
const targetConfig = Argument.String("config").pipe(
  Argument.withDescription(
    `Path of the gateway's JSON config (default ${defaultConfigPath} when it is in this folder): its status block says where to ask, its site, building and id which gateway should answer`
  ),
  Argument.optional,
  Argument.map(Option.getOrUndefined)
)

const secondsFlag = (description: string) =>
  Flag.Int("seconds").pipe(
    Flag.withDescription(description),
    Flag.filter(
      (seconds) => seconds >= 1,
      (seconds) => `--seconds takes 1 or more, not ${seconds}`
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  )

// The report is printed before the failure that sets the exit code, and outside `jsonFailure`, so `--json` prints
// one document: the status with `ok: false`.
const status = Command.make(
  "status",
  {
    config: targetConfig,
    url: urlFlag,
    json: jsonFlag,
    failOnAlarm: Flag.Boolean("fail-on-alarm").pipe(
      Flag.withDescription("Also exit with 1 while an alarm point is active, for scripts that act on alarms"),
      Flag.withDefault(false)
    )
  },
  ({ config, url, json, failOnAlarm }) =>
    resolveTarget({ config, url }).pipe(
      Effect.flatMap((target) => fetchStatusFor(target, { json })),
      jsonFailure(json, { url: url ?? null, path: config ?? null }),
      Effect.flatMap(({ status: report, recent }) => statusOutcome(json, { failOnAlarm })(report, recent))
    )
).pipe(
  Command.withDescription(
    "The running gateway's status: its name first, its broker, buffer and one line per device, with what to check first for a failing one. Exits with 1 when a device is failing or the broker is not connected, or when another gateway than the config's answers; an active alarm only with --fail-on-alarm"
  ),
  Command.withExamples([
    { command: "ot-gateway status", description: "The gateway of ot-gateway.json in this folder" },
    { command: "ot-gateway status site-1/ot-gateway.json", description: "The gateway of another config" },
    {
      command: "ot-gateway status --json",
      description: "Everything /api/status says, with ok, alarmsActive and hints"
    },
    { command: "ot-gateway status --fail-on-alarm", description: "Exit with 1 while an alarm is active, for scripts" },
    { command: "ot-gateway status --url http://10.0.0.20:8080", description: "A gateway elsewhere on the LAN" }
  ])
)

const sinceFlag = (fallback: string, all: boolean) =>
  Flag.String("since").pipe(
    Flag.withDescription(
      all
        ? "How far back: 30s, 10m, 2h, 1d, or all (the gateway keeps its latest 500 events)"
        : "How far back: 30s, 10m, 2h or 1d (reads are kept a day, per-minute values for retentionDays)"
    ),
    Flag.filter(
      (since) => parseSince(since) !== undefined && (all || since !== "all"),
      (since) => `--since takes 30s, 10m, 2h, 1d${all ? " or all" : ""}, not ${since}`
    ),
    Flag.withDefault(fallback)
  )

const eventsCommand = Command.make(
  "events",
  {
    config: targetConfig,
    url: urlFlag,
    since: sinceFlag("1h", true),
    follow: Flag.Boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("Then print each new event as it comes, until Ctrl-C (or --seconds)"),
      Flag.withDefault(false)
    ),
    seconds: secondsFlag("With --follow, stop after this many seconds instead of at Ctrl-C, for scripts and agents"),
    json: jsonFlag
  },
  ({ config, url, since, follow, seconds, json }) =>
    resolveTarget({ config, url }).pipe(
      Effect.flatMap((target) =>
        eventsReport(target, {
          since,
          sinceMs: parseSince(since) ?? Number.POSITIVE_INFINITY,
          json,
          follow: follow || seconds !== undefined,
          seconds
        })
      ),
      jsonFailure(json, { url: url ?? null, path: config ?? null })
    )
).pipe(
  Command.withDescription(
    "What changed lately in the running gateway, oldest first: devices failing and recovering, the broker lost and back, the buffer drained"
  ),
  Command.withExamples([
    { command: "ot-gateway events", description: "The last hour" },
    { command: "ot-gateway events --follow", description: "The last hour, then each new event as it comes" },
    { command: "ot-gateway events --since 10m --follow --seconds 60 --json", description: "A minute of it, NDJSON" },
    { command: "ot-gateway events --since all --json", description: "Everything it keeps, as JSON" }
  ])
)

const historyCommand = Command.make(
  "history",
  {
    points: Argument.String("points").pipe(
      Argument.withDescription(
        "device/point, a device for all its points, or several of either comma-separated: energy-meter/active-power"
      ),
      Argument.filter(
        (text) => parseSelection(text) !== undefined,
        () => "name a device/point, or a device"
      )
    ),
    config: targetConfig,
    url: urlFlag,
    since: sinceFlag("10m", false),
    buckets: Flag.Int("buckets").pipe(
      Flag.withDescription("About how many buckets the range is cut into (default 10, at most 2000)"),
      Flag.filter(
        (buckets) => buckets >= 1 && buckets <= 2000,
        (buckets) => `--buckets takes 1 to 2000, not ${buckets}`
      ),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
    json: jsonFlag
  },
  ({ points: selection, config, url, since, buckets, json }) =>
    resolveTarget({ config, url }).pipe(
      Effect.flatMap((target) =>
        historyReport(target, parseSelection(selection) ?? [], {
          since,
          sinceMs: parseSince(since) ?? 600_000,
          buckets,
          json
        })
      ),
      jsonFailure(json, { url: url ?? null, path: config ?? null })
    )
).pipe(
  Command.withDescription(
    "What points did lately, from the running gateway's history: per bucket the average with its unit, minimum, maximum and reads, and the gaps, in local time"
  ),
  Command.withExamples([
    { command: "ot-gateway history energy-meter/active-power", description: "The last 10 minutes, a line a minute" },
    { command: "ot-gateway history energy-meter --since 1h --buckets 4", description: "Every point of a device" },
    { command: "ot-gateway history energy-meter/active-power --json", description: "The series as JSON" }
  ])
)

const messagesCommand = Command.make(
  "messages",
  {
    points: Argument.String("points").pipe(
      Argument.withDescription(
        "device/point, a device for all its topics, or several of either comma-separated; every topic when left out"
      ),
      Argument.optional,
      Argument.map(Option.getOrUndefined)
    ),
    positionalConfig: targetConfig,
    config: Flag.String("config").pipe(
      Flag.withDescription(
        `Path of the gateway's JSON config, the same as naming it after the points (default ${defaultConfigPath} when it is in this folder)`
      ),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
    url: urlFlag,
    json: jsonFlag
  },
  ({ points: pointsArgument, positionalConfig, config: configFlag, url, json }) => {
    const chosen = messagesArguments(pointsArgument, positionalConfig, configFlag)
    const config = "error" in chosen ? undefined : chosen.config
    return Effect.gen(function* () {
      if ("error" in chosen) return yield* new BrokerCommandError({ message: chosen.error })
      const target = yield* resolveTarget({ config, url })
      const selection = chosen.points === undefined ? [] : (parseSelection(chosen.points) ?? [])
      return yield* messagesReport(target, selection, { json })
    }).pipe(jsonFailure(json, { url: url ?? null, path: config ?? null }))
  }
).pipe(
  Command.withDescription(
    "How many messages the running gateway published per topic since it started, how many reached the broker, and the last one"
  ),
  Command.withExamples([
    { command: "ot-gateway messages", description: "Every topic under the gateway's site and building" },
    { command: "ot-gateway messages energy-meter/active-power", description: "One point's value and $meta topics" },
    { command: "ot-gateway messages energy-meter --json", description: "A device's topics as JSON" },
    { command: "ot-gateway messages energy-meter site-1/ot-gateway.json", description: "The gateway of another config" }
  ])
)

/** The top of `--help`: what it is, then the short way through for agents, which read help first. */
export const rootDescription = [
  "OT Gateway: Modbus TCP and BACnet/IP in, MQTT 5 or 3.1.1 out, safe commands back",
  "",
  "  For AI agents: nothing asks without a terminal, and --json prints results and failures as JSON.",
  "    points schema --json             the points list's columns: translate any list or EDE file into it",
  "    profiles list --json             Modbus models a points list row takes the registers of by name",
  "    import <list> --dry-run --json   check a points list, row by row",
  "    init <folder> --dry-run --json   the folder init would write (with --site, --broker, --points <list>)",
  "    check --json                     every mistake in a config, with its path",
  "    broker --json                    the broker: MQTT version, limits, a round trip",
  "    status --json                    the running gateway, device by device, with what to check; exits 1 when something fails",
  "    events --since 1h --json         what broke, since when and why, and when it came back (--follow: as it happens)",
  "    history <device/point> --json    what a point did lately: min, max, average per bucket, and the gaps",
  "    messages [<device/point>] --json how many messages went out per topic since start, and reached the broker",
  "  status, events, history and messages ask the gateway of ./ot-gateway.json (or the config named) at its status port."
].join("\n")

export const cli = Command.make("ot-gateway").pipe(
  Command.withDescription(rootDescription),
  Command.withSubcommands([
    demo,
    init,
    run,
    check,
    discoverCommand,
    importCommand,
    points,
    profiles,
    watchCommand,
    brokerCommand,
    publishCommand,
    status,
    eventsCommand,
    historyCommand,
    messagesCommand
  ])
)

const subcommands = new Set([
  "demo",
  "init",
  "run",
  "check",
  "discover",
  "import",
  "points",
  "profiles",
  "watch",
  "broker",
  "publish",
  "status",
  "events",
  "history",
  "messages"
])

/**
 * The arguments for `cli`, with the forms from before the subcommands translated: no arguments or a config path
 * is `run`, and `--check` or `--discover` anywhere is that subcommand.
 */
export const toCliArgs = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [first] = argv
  if (first !== undefined && (subcommands.has(first) || (first.startsWith("-") && !legacyFlags.has(first)))) {
    return argv
  }
  // A word that is not a path (`ot-gateway stauts`) is a mistyped command, which the CLI reports, not a config.
  if (
    first !== undefined &&
    !legacyFlags.has(first) &&
    !looksLikePath(first) &&
    !argv.some((arg) => legacyFlags.has(arg))
  ) {
    return argv
  }
  for (const flag of legacyFlags) {
    if (argv.includes(flag)) return [flag.slice(2), ...argv.filter((arg) => arg !== flag)]
  }
  return ["run", ...argv]
}

const legacyFlags = new Set(["--check", "--discover"])

/** A config path as the forms before the subcommands took it: a file name with an extension, or a directory. */
const looksLikePath = (arg: string) => arg.includes("/") || arg.includes("\\") || arg.includes(".")

/**
 * What `--version` prints: a release as its tag (`ot-gateway v0.12.0`, with the `v` added to a bare number), and any
 * other build as it is (`ot-gateway dev`, `ot-gateway c78bb4e09-dirty`). The CLI's own formatter puts a `v` before
 * every version, which turns a local build into `vdev`.
 */
export const versionLine = (name: string, version: string) =>
  `${name} ${/^\d+\.\d/.test(version) ? `v${version}` : version}`

/** The CLI's output, with `--version` printed by `versionLine`; help and errors as the CLI prints them. */
const presenter: CliOutput.Presenter = {
  present: (event) =>
    event._tag === "Version"
      ? Console.log(versionLine(event.name, event.version))
      : CliOutput.defaultPresenter.present(event)
}

/** Runs the command line for `argv` (without node and the script). */
export const runCli = (argv: ReadonlyArray<string>) => {
  const args = toCliArgs(argv)
  const program = Effect.flatMap(readVersion, (version) => Command.runWith(cli, { version })(args)).pipe(
    Effect.provideService(CliOutput.Presenter, presenter)
  )
  // A one-shot command prints its result; the client's info lines (connected, subscribed) would bury it.
  // `--log-level info` brings them back, since the CLI's own setting is applied inside this one.
  return longRunning.has(args[0] ?? "") ? program : Effect.provideService(program, References.MinimumLogLevel, "Warn")
}

/** The commands that run until stopped and log what they do, as the gateway does. */
const longRunning = new Set(["run", "demo"])

/** Whether `argv` (without node and the script) runs until stopped, the forms from before the subcommands too. */
export const isLongRunning = (argv: ReadonlyArray<string>) => longRunning.has(toCliArgs(argv)[0] ?? "")
