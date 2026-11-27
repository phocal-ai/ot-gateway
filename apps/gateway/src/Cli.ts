/**
 * The `ot-gateway` command line, on `effect/cli`:
 *
 *   ot-gateway demo                 the gateway with a test broker and simulated devices, in one process
 *   ot-gateway init [config]        answer a few questions, get a config (config defaults to ot-gateway.json)
 *   ot-gateway run [config]         run the gateway (config defaults to ot-gateway.json)
 *   ot-gateway check [config]       validate a config without connecting to anything
 *   ot-gateway doctor [config]      every check in order (config, broker, gateway, devices, port, disk, clock), one list
 *   ot-gateway up [config]          start the folder's gateway with Docker Compose, wait until every point has a value
 *   ot-gateway down [config]        stop it (docker compose down)
 *   ot-gateway restart [config]     recreate its container, wait until every point has a value
 *   ot-gateway upgrade [config]     to the newest release, back again when values stop (--check: is one out)
 *   ot-gateway discover [config]    find BACnet devices and print a draft of their config
 *   ot-gateway discover modbus <range>  find Modbus TCP devices and unit ids on a range, read-only and rate-limited
 *   ot-gateway import <list> [config]  add the devices of a points list (CSV) to the config
 *   ot-gateway points export [config]  the config's devices as a points list again, for import (CSV or JSON)
 *   ot-gateway diff [config]        what the config changes on the broker against the running gateway (or --against a file)
 *   ot-gateway contract [message]   the MQTT contract: its topics and payloads (--json: the JSON Schemas)
 *   ot-gateway watch [config]       print what arrives at the config's broker (--check: what is off the contract)
 *   ot-gateway broker [config]      which MQTT the config's broker speaks, what it allows, a round trip
 *   ot-gateway publish <topic> [payload]  one message to the config's broker (empty and --retain clears)
 *   ot-gateway write <device/point> <value> [config]  a guarded command through the broker, and its result
 *   ot-gateway status [config]      the running gateway's status, one line per device (exit 1 when failing)
 *   ot-gateway events [config]      what changed lately: devices failing and recovering, the broker lost and back
 *   ot-gateway history <device/point> [config]  what a point did lately, from the gateway's history
 *   ot-gateway messages [device/point] [config]  what the gateway published per topic since it started (--since: the last minutes)
 *   ot-gateway logs [config]        the running gateway's recent log lines: warnings and errors, and info
 *   ot-gateway read [device[/point]] [config]  read every configured point (or the ones named) once, without a running gateway
 *   ot-gateway probe <host[:port]> <register>  read Modbus registers once and show every type and byte order they read as
 *   ot-gateway simulate bacnet      a simulated BACnet/IP device with three objects on the LAN, to try against
 *   ot-gateway mcp                  these commands as MCP tools over stdio, for agents without a shell (McpTools.ts)
 *
 * A config is a positional argument after the others, as `ot-gateway.json` in this folder when left out. `publish`
 * is the exception, since its positionals are the topic and the payload: it takes `--config`, and refuses a payload
 * that is the path of a JSON file, which is a config meant for `--config` (with `--retain` it would otherwise stay
 * on the broker). `status`, `events`, `history`, `messages` and `logs` take `--config` too, the same as the positional; without
 * either and without `./ot-gateway.json`, they say on stderr which address they ask instead.
 *
 * The forms from before the subcommands keep working, because the systemd unit, the image and scripts use
 * them: `ot-gateway path.json` runs, `--check path.json` checks and `--discover path.json` discovers.
 */
import { covPointIds, type Device, type GatewayConfig, mqttPasswordWarning } from "@ot-gateway/core"
import { Config, Console, Duration, Effect, FileSystem, Option, References, Result } from "effect"
import { Argument, CliOutput, Command, Flag, Prompt } from "effect/cli"
import { networkInterfaces } from "node:os"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { mergeDiscovered, writeMerged } from "./DiscoverSave.ts"
import { pointAlarmWhen } from "./Alarms.ts"
import { acceptsConnections, pickPublicBroker, randomDemoSite, runDemo } from "./Demo.ts"
import { simulateBacnet, SimulateError } from "./Simulate.ts"
import { doctorProblems, formatDoctor, runDoctor } from "./Doctor.ts"
import { dockerLayer, down, isDockerTag, nextLine, up, upgrade } from "./Deploy.ts"
import {
  discover,
  DiscoverError,
  discoverToPointsList,
  discoveryDefaults,
  LISTEN_SECONDS,
  type PointsListWritten
} from "./Discover.ts"
import { describeTranslation, edeToPointsList } from "./Ede.ts"
import {
  DEFAULT_RATE,
  foundUnits,
  formatScan,
  MAX_RATE,
  MODBUS_PORT,
  ModbusDiscoverError,
  modbusRangeHint,
  nothingFound,
  parseRange,
  parseUnitIds,
  scanJson,
  scanModbus,
  scanToPointsList
} from "./ModbusDiscover.ts"
import { clearCommands, diffConfigs, diffReport, diffTitle, formatDiff, sideOfConfig } from "./Diff.ts"
import { describeNotCarried, exportCsv, exportJson, exportPointsList } from "./PointsExport.ts"
import { defaultConfigPath, describeUnits, importPointsList } from "./Import.ts"
import { writeFolderFiles } from "./Folder.ts"
import {
  broadcastAddress,
  discoverInteractively,
  initNext,
  initSummary,
  initTarget,
  lanInterfaces,
  suggestedModbusRange,
  isInteractive,
  nextSteps,
  runInit,
  sshSession,
  startNowQuestion
} from "./Init.ts"
import { invocation } from "./Invocation.ts"
import {
  briefPointsListSchemaJson,
  describePointsListSchema,
  pointsListJsonSchema,
  pointsListSchema,
  pointsListTemplate
} from "./PointsSchema.ts"
import { eventsReport, fetchStatusFor, parseSince, statusOutcome } from "./StatusReport.ts"
import { chooseConfig, DEFAULT_STATUS_URL, resolveTarget } from "./GatewayTarget.ts"
import { historyReport, parseSelection } from "./HistoryReport.ts"
import { MESSAGE_WINDOW_MS, messagesReport } from "./MessagesReport.ts"
import { logsReport } from "./LogsReport.ts"
import { watch } from "./Watch.ts"
import { formatWritten, parseTarget, writePoint } from "./Write.ts"
import { contractJson, contractMessageNames, describeContract, describeContractMessage } from "./ContractReport.ts"
import {
  DEFAULT_READ_SECONDS,
  formatReadReport,
  incompleteMessage,
  parseReadSelection,
  readOnce,
  ReadIncomplete,
  selectDevices
} from "./ReadOnce.ts"
import { printJsonWithLocalTimes } from "./JsonTimes.ts"
import { defaultCount, formatProbeReport, parseEndpoint, probe, ProbeError, probeJson, probeTables } from "./Probe.ts"
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
import { ConfigFileError, configFileSource, loadConfig, loadFolderEnv } from "./LoadConfig.ts"
import { closestMatch } from "./Suggest.ts"
import {
  describeProfile,
  describeProfileFormat,
  libraryProfiles,
  profileJsonSchema,
  resolveProfile
} from "./Profile.ts"
import { telemetryLayer } from "./Telemetry.ts"
import {
  failureFields,
  failureLine,
  localTimeZone,
  printJson,
  printResult,
  shellArgument,
  stderrConsole,
  UsageMistake
} from "./Output.ts"
import { readVersion } from "./Version.ts"
import { inColumn, plainUi, spinning, terminalUi, type Ui } from "./Ui.ts"
import { codeJson, codes, codesTable, explainCode, formatCode, formatCodeList } from "./Codes.ts"
import { formatSupportSummary, supportBundle, supportFileName } from "./Support.ts"
import type { NodeServices } from "@effect/platform-node/NodeServices"
import { serveMcp } from "./Mcp.ts"
import { mcpTools } from "./McpTools.ts"

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

/**
 * A file the config names, as `check` shows it: under the working directory as `./name`, else as it is. In the
 * Docker wrapper the working directory is the user's folder mounted at /work, a path they never see.
 */
export const shownPath = (path: string, cwd: string) => {
  const inside = relative(cwd, path)
  const outside = inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)
  return inside !== "" && !outside ? `./${inside}` : path
}

/** What `check` prints: the gateway the config describes, one line per device, and what start-up would warn about. */
export const describeConfig = (config: GatewayConfig, cwd = process.cwd()) => {
  const passwordWarning = mqttPasswordWarning(config.mqtt)
  return [
    `config ok: ${config.site}/${config.building}, gateway ${config.id}, broker ${config.mqtt.url}`,
    ...(passwordWarning === undefined ? [] : [`  warning: ${passwordWarning}`]),
    config.buffer === undefined
      ? "  no buffer: values read while the broker is down are lost"
      : `  buffer ${shownPath(config.buffer.path, cwd)}`,
    ...(config.history === undefined
      ? []
      : [
          `  history ${shownPath(config.history.path, cwd)}, per-minute values for ${config.history.retentionDays} days`
        ]),
    config.status === undefined
      ? "  no status page"
      : config.status.bindAddress === "0.0.0.0"
        ? `  status page on port ${config.status.port} at every address of this machine (http://localhost:${config.status.port} here)`
        : `  status page http://${config.status.bindAddress}:${config.status.port}`,
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

/** The alarm points of a device (`alarmWhen`, or semantics that say alarm: `pointAlarmWhen`), in config order. */
const alarmPointIds = (device: Device) =>
  device.points.flatMap((point) => (pointAlarmWhen(point) === undefined ? [] : [point.id]))

/**
 * One device in `check --json` and `import --json`: `alarmPoints` are the alarm points (`alarmWhen`, a points list's
 * `alarm` column, or a Brick class `Alarm` or `*_Alarm` or the Haystack tag `alarm`), `covPoints` are the points asked for by change of value (BACnet
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

/**
 * With --json, a failure is JSON on stdout as well; it still fails, so the exit code stays 1. A command that prints
 * JSON lines (`watch`) passes `lines`, so its failure is one line too and the output stays NDJSON to the end.
 */
const jsonFailure =
  (json: boolean, fields: Readonly<Record<string, unknown>> = {}, options: { readonly lines?: boolean } = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    json
      ? effect.pipe(
          Effect.tapError((error) => {
            // The address a flag named stays as given; the error's (the config's status page) fills in a null.
            const { url, ...known } = failureFields(error)
            const asked = typeof fields["url"] === "string" ? {} : url === undefined ? {} : { url }
            const failure = { ok: false, ...fields, ...asked, error: errorText(error), ...known }
            return options.lines === true ? printResult(JSON.stringify(failure)) : printJson(failure)
          })
        )
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

const DEFAULT_CONFIG = "ot-gateway.json"

const configPath = Argument.String("config").pipe(
  Argument.withDescription("Path of the gateway's JSON config"),
  Argument.withDefault(DEFAULT_CONFIG)
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

/**
 * What to run after a valid `check --json`: init's next steps for the config's folder (the broker, the points,
 * starting it, the status page), without the check itself. Only in the JSON: the text stays what it was, as
 * install.sh and the image validate a staged config with it.
 */
const checkNext = Effect.fn("checkNext")(function* (path: string, config: GatewayConfig) {
  const fs = yield* FileSystem.FileSystem
  const folder = dirname(path)
  const present = yield* Effect.forEach(["compose.yaml", "ot-gateway.env", "points.csv"], (file) =>
    fs.exists(join(folder, file)).pipe(
      Effect.map((exists) => (exists ? [join(folder, file)] : [])),
      // Not knowing leaves the file out of the advice (run rather than Compose), which still works.
      Effect.catchTag("PlatformError", (error) =>
        Effect.as(Effect.logDebug(`check: could not look for ${file}`, error.message), [])
      )
    )
  )
  const kept = present.flat().filter((file) => !file.endsWith("points.csv"))
  const hasList = present.flat().some((file) => file.endsWith("points.csv"))
  const command = yield* invocation
  const context = { ssh: sshSession(yield* sshEnvironment), platform: process.platform, cwd: process.cwd(), command }
  const { next, url, page } = initNext(path, config, { written: [], kept }, context)
  // A points.csv there is the user's list: never suggest writing the template over it.
  return {
    next: next.filter(
      (step) => !step.command.startsWith(`${command} check`) && !(hasList && step.command.includes("points template"))
    ),
    url,
    page
  }
})

const check = Command.make("check", { config: configPath, json: jsonFlag }, ({ config, json }) =>
  Effect.gen(function* () {
    const decoded = yield* loadConfig(config)
    if (!json) return yield* Console.log(describeConfig(decoded))
    const { next, url, page } = yield* checkNext(config, decoded)
    yield* printJson({ ...configSummary(decoded), next, url, page })
  }).pipe(jsonFailure(json, { path: config }))
).pipe(
  Command.withDescription(
    "Validate a config without connecting to anything; lists every mistake with its path (--json: issues [{path, message}], and next, what to run after it)"
  )
)

/** What `discover --points-list` prints on stdout: with --json its outcome; without, stderr has said it already. */
export const pointsListOutcome = (json: boolean) => (written: PointsListWritten) =>
  json ? printJson({ ok: true, ...written }) : Effect.void

/**
 * The config `discover` asks with. No config yet is the usual first step, so with none in this folder it asks with
 * the BACnet/IP defaults and says so. A config named elsewhere that is not there, or one that is wrong, still fails:
 * a typo must not scan with other settings than the config's.
 */
const configForDiscovery = Effect.fn("configForDiscovery")(function* (path: string) {
  const loaded = yield* loadConfig(path).pipe(
    Effect.map(Option.some),
    Effect.catchTag("ConfigFileError", (error) =>
      error.code === "no-config" && path === DEFAULT_CONFIG ? Effect.succeedNone : Effect.fail(error)
    )
  )
  if (Option.isSome(loaded)) return { config: loaded.value, noConfig: false }
  yield* Console.error(`no ${path} here: asking with the BACnet/IP defaults (UDP 47808, broadcast 255.255.255.255)`)
  return { config: yield* discoveryDefaults, noConfig: true }
})

/** The scan's progress on stderr, at most every tenth of the addresses, so a /24 says where it is. */
const scanProgress = (done: number, total: number) =>
  total >= 20 && (done === total || done % Math.ceil(total / 10) === 0)
    ? Console.error(`  ${done}/${total} addresses asked`)
    : Effect.void

const modbusUsage = (message: string, hint: string) => new ModbusDiscoverError({ message, code: "usage", hint })

const discoverModbusCommand = Command.make(
  "modbus",
  {
    range: Argument.String("range").pipe(
      Argument.withDescription(
        "The addresses to ask: 192.168.1.20, 192.168.1.20:5020, 192.168.1.0/24, 192.168.1.10-40, or several with commas"
      )
    ),
    port: Flag.Int("port").pipe(
      Flag.withDescription(`The TCP port to ask on, where the range does not give one (${MODBUS_PORT}, Modbus TCP's)`),
      Flag.withDefault(MODBUS_PORT)
    ),
    unitIds: Flag.String("unit-ids").pipe(
      Flag.withDescription(
        "The unit ids to ask on each address, as 1, 1,2,5 or 1-247 (behind a Modbus gateway); by default 1, and 255 and 0 when 1 is silent"
      ),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
    rate: Flag.Int("rate").pipe(
      Flag.withDescription(`At most this many requests a second across the scan (1 to ${MAX_RATE})`),
      Flag.withDefault(DEFAULT_RATE)
    ),
    pointsList: Flag.String("points-list").pipe(
      Flag.withDescription("Write the units found as a points list (CSV) to this file, to fill in and import"),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
    append: Flag.Boolean("append").pipe(
      Flag.withDescription("Add to the --points-list file when it exists (rows it has are skipped)"),
      Flag.withDefault(false)
    ),
    json: jsonFlag
  },
  ({ range, port, unitIds, rate, pointsList, append, json }) =>
    Effect.gen(function* () {
      if (append && pointsList === undefined) {
        return yield* modbusUsage("--append adds to the file --points-list names", "give both")
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return yield* modbusUsage(`--port takes 1 to 65535, not ${port}`, `Modbus TCP is ${MODBUS_PORT}`)
      }
      if (!Number.isInteger(rate) || rate < 1 || rate > MAX_RATE) {
        return yield* modbusUsage(
          `--rate takes 1 to ${MAX_RATE}, not ${rate}`,
          `${DEFAULT_RATE} unless the network is slow`
        )
      }
      const targets = parseRange(range, port)
      if (Result.isFailure(targets)) return yield* modbusUsage(targets.failure, modbusRangeHint)
      const ids = unitIds === undefined ? undefined : parseUnitIds(unitIds)
      if (ids !== undefined && Result.isFailure(ids))
        return yield* modbusUsage(`--unit-ids ${ids.failure}`, "--unit-ids 1-247")
      const asked = ids === undefined ? undefined : ids.success
      const perAddress = asked === undefined ? "unit id 1 (255 and 0 where 1 is silent)" : `${asked.length} unit id(s)`
      yield* Console.error(
        `asking ${targets.success.length} address(es), ${perAddress} each, at most ${rate} requests a second; read-only`
      )
      const report = yield* scanModbus(
        { range, targets: targets.success, unitIds: asked, rate, askedPort: port },
        { onDone: scanProgress }
      )
      const command = yield* invocation
      if (pointsList !== undefined) {
        // A config in this folder takes the list with import; without one, init starts from it.
        const fs = yield* FileSystem.FileSystem
        const hasConfig = yield* fs.exists(DEFAULT_CONFIG)
        const { written, message } = yield* scanToPointsList(report, pointsList, {
          append,
          command,
          noConfig: !hasConfig,
          configPath: hasConfig ? DEFAULT_CONFIG : undefined
        })
        yield* Console.error(message)
        return yield* json
          ? printJson({ ...scanJson(report, { command }), points: written, next: written.next ?? null })
          : Effect.void
      }
      if (foundUnits(report).length === 0) return yield* nothingFound(report, { command })
      yield* json ? printJson(scanJson(report, { command })) : printResult(formatScan(report, { command }))
    }).pipe(jsonFailure(json, { range }))
).pipe(
  Command.withDescription(
    "Find Modbus TCP devices and their unit ids on a range of addresses, read-only (one register read per unit) and rate-limited, and draft their points list rows"
  ),
  Command.withExamples([
    { command: "ot-gateway discover modbus 192.168.1.0/24", description: "Every address of a /24 on port 502" },
    {
      command: "ot-gateway discover modbus 192.168.1.0/24 --points-list modbus.csv",
      description: "Write the units found as a points list to fill in"
    },
    {
      command: "ot-gateway discover modbus 192.168.1.60 --unit-ids 1-247",
      description: "The meters behind one Modbus gateway"
    }
  ])
)

/**
 * `discover` for a person at a terminal: what to look for (BACnet/IP on this network, the one picked when there are
 * several, a Modbus scan, one device by address, a points list), the points to read, what the save changes on the
 * broker when the config has devices already, the save (devices it has get the new points), then read once, start
 * or done.
 */
const discoverAndSave = Effect.fn("discoverAndSave")(function* (
  path: string,
  address: string | undefined,
  ui: Ui,
  wait: number | undefined
) {
  const fs = yield* FileSystem.FileSystem
  const cli = yield* invocation
  // The file as it is before any question: the save merges into it and refuses when it changed meanwhile.
  const fileText = yield* fs.readFileString(path)
  const config = yield* loadConfig(path)
  const lans = lanInterfaces(networkInterfaces())
  // The default broadcast reaches no device behind most routers' settings: ask on this machine's network instead.
  const unset = config.bacnet.broadcastAddress === "255.255.255.255"
  const broadcast = unset && address === undefined ? yield* broadcastAddress(lans, {}) : undefined
  const asked =
    broadcast === undefined ? config : { ...config, bacnet: { ...config.bacnet, broadcastAddress: broadcast } }
  const picked = yield* discoverInteractively(asked, () => suggestedModbusRange(lans), { address, wait })
  if (picked.length === 0) return yield* Console.log(ui.note(`nothing to save; ${path} is as it was`))
  const located = picked.every((device) => device.protocol !== "bacnet-ip" || "address" in device)
  const merged = yield* mergeDiscovered(path, fileText, picked, located ? undefined : broadcast)
  const argument = path === DEFAULT_CONFIG ? "" : ` ${shellArgument(path)}`
  // A config with devices already runs somewhere, perhaps: what the save changes on the broker, as diff shows it.
  if (config.devices.length > 0) {
    const diff = diffConfigs(sideOfConfig(merged.before), sideOfConfig(merged.config))
    yield* Console.log(
      `\n${ui.indent(formatDiff(diff, "What saving changes on the broker:", { command: cli, config: path === DEFAULT_CONFIG ? undefined : path }))}\n`
    )
  }
  const points = picked.reduce((total, device) => total + device.points.length, 0)
  const save = yield* Prompt.Confirm({
    message: `Save ${picked.length} device${picked.length === 1 ? "" : "s"} and ${points} point${points === 1 ? "" : "s"} to ${path}?`,
    initial: true
  })
  if (!save) return yield* Console.log(ui.note(`nothing saved; ${path} is as it was`))
  yield* writeMerged(path, fileText, merged)
  yield* Console.log(["", ...savedLines(merged.config, merged.added, merged.extended, ui), ""].join("\n"))
  return yield* afterSave(merged.config, path, argument, ui)
})

/**
 * What the save added, one line per device: how often it is read and how many points commands may write, from the
 * saved config (a points list or the simulated device brings its own), and how to make a setpoint writable.
 */
export const savedLines = (
  saved: GatewayConfig,
  added: ReadonlyArray<string>,
  extended: ReadonlyArray<string>,
  ui: Ui = plainUi
): ReadonlyArray<string> => {
  const describe = (id: string) => {
    const device = saved.devices.find((each) => each.id === id)
    if (device === undefined) return { text: "", writable: 0 }
    const writable = device.points.filter((point) => point.writable).length
    return {
      text: `read every ${device.pollIntervalMs / 1000} s, ${writable === 0 ? "none" : writable} writable`,
      writable
    }
  }
  const lines = [
    ...added.map((id) => ({ verb: `Added ${id}`, ...describe(id) })),
    ...extended.map((id) => ({ verb: `Added points to ${id}`, ...describe(id) }))
  ]
  const hint = lines.every((line) => line.writable === 0)
    ? [ui.note("setpoints become writable on the status page or in the config")]
    : []
  return [...lines.map((line) => ui.done(`${line.verb}: ${line.text}`)), ...hint]
}

/** What the end of discover offers: read every point once, start the gateway here, or stop. */
type AfterSave = "read" | "start" | "done"

/** Every point of `saved` read once, the report printed; a read that cannot start says why and returns to the menu. */
const readEveryPoint = Effect.fn("readEveryPoint")(
  function* (saved: GatewayConfig, ui: Ui) {
    const devices = yield* selectDevices(saved, [])
    const count = devices.reduce((sum, device) => sum + device.points.length, 0)
    // The report says what failed and why; the drivers' warnings would only repeat it.
    const report = yield* readOnce(saved, devices).pipe(
      Effect.provideService(References.MinimumLogLevel, "Error"),
      spinning(ui, `Reading ${count} point${count === 1 ? "" : "s"} once`)
    )
    yield* Console.log(`${ui.indent(formatReadReport(report))}\n`)
  },
  (effect, _saved, ui) =>
    Effect.catchTag(effect, "ReadError", (error) =>
      Console.error(`${ui.failed(error.message)}${error.hint === undefined ? "" : `\n${ui.note(error.hint)}`}\n`)
    )
)

/** After a save: read once (as often as wanted), start the gateway in this terminal, or the commands for later. */
const afterSave = Effect.fn("afterSave")(function* (saved: GatewayConfig, path: string, argument: string, ui: Ui) {
  const cli = yield* invocation
  const canStart = startNowQuestion(saved, process.env) !== undefined
  const choices: ReadonlyArray<Prompt.SelectChoice<AfterSave>> = [
    { title: "Read every point once", value: "read", description: "see the values now, no broker needed" },
    ...(canStart
      ? [
          {
            title: "Start the gateway here",
            value: "start" as const,
            description: "publish to the broker until Ctrl-C, status page included"
          }
        ]
      : []),
    { title: "Done for now", value: "done", description: "how to start it later" }
  ]
  while (true) {
    const next = yield* Prompt.Select<AfterSave>({ message: "What next?", choices })
    if (next === "done") {
      return yield* Console.log(
        [
          "",
          ui.rows([
            ["Start it", `${ui.command(`${cli} run${argument}`)}${ui.dim(`  or in Docker: ${cli} up`)}`],
            ["Read once", ui.command(`${cli} read${argument}`)],
            ["All commands", ui.command(`${cli} --help`)]
          ]),
          ""
        ].join("\n")
      )
    }
    if (next === "start") {
      yield* Console.log(`\n${statusPageLine(ui, `http://127.0.0.1:${saved.status?.port ?? 8080}`)}\n`)
      return yield* runConfigured(saved, path).pipe(Effect.provideService(References.MinimumLogLevel, "Info"))
    }
    yield* readEveryPoint(saved, ui)
  }
})

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
    wait: Flag.Int("wait").pipe(
      Flag.withDescription(
        `Listen for BACnet devices at least this many seconds (default ${LISTEN_SECONDS}); longer while new ones still answer, at most 30`
      ),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
    json: jsonFlag
  },
  // The draft is JSON already; --json makes a failure JSON too, and what --points-list wrote.
  ({ config, pointsList, append, address, wait, json }) =>
    Effect.gen(function* () {
      if (append && Option.isNone(pointsList)) {
        return yield* new DiscoverError({ message: "--append adds to the file --points-list names; give both" })
      }
      if (wait !== undefined && (!Number.isInteger(wait) || wait < 1 || wait > 30)) {
        return yield* new DiscoverError({ message: `--wait takes 1 to 30 seconds, not ${wait}` })
      }
      // A person at a terminal picks what to keep and saves it into the config; scripts and agents get the draft.
      // Without a config there is nothing to save into: the draft, as before, and init named as the way to one.
      const fs = yield* FileSystem.FileSystem
      if (!json && Option.isNone(pointsList) && process.stdin.isTTY && process.stdout.isTTY) {
        if (yield* fs.exists(config)) {
          const ui = terminalUi()
          yield* Console.error(ui.header("ot-gateway discover", yield* readVersion))
          return yield* discoverAndSave(config, Option.getOrUndefined(address), ui, wait).pipe(inColumn(ui))
        }
        yield* Console.error(
          `no ${config} here, so the devices found are printed, not saved: ${yield* invocation} init sets up the broker and the site, then discover saves the devices you pick`
        )
      }
      const found = yield* configForDiscovery(config)
      const decoded = found.config
      const options = {
        address: Option.getOrUndefined(address),
        wait,
        append,
        configPath: found.noConfig ? undefined : config,
        noConfig: found.noConfig,
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
    "Find devices. In a terminal: choose BACnet/IP or a Modbus TCP scan (or a points list), pick the points to read, see what changes and save them into the config, then read them once or start the gateway. Otherwise (--json, a pipe, no config yet): print a draft of the BACnet devices' entries; nothing is written"
  ),
  Command.withExamples([
    {
      command: "ot-gateway discover",
      description: "In a terminal: pick what to keep and save it into ot-gateway.json"
    },
    { command: "ot-gateway discover --json", description: "Print the draft as JSON, in the config's shape" },
    { command: "ot-gateway discover --points-list points.csv", description: "Write it as a points list to trim" },
    {
      command: "ot-gateway discover --points-list points.csv --append",
      description: "Add it to a points list you have, rows it has already skipped"
    },
    {
      command: "ot-gateway discover --address 10.20.3.40:47809",
      description: "Ask one device whose address a device list gives"
    }
  ]),
  Command.withSubcommands([discoverModbusCommand])
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

/** The line before a gateway starts in the terminal: where its status page is, and how it stops. */
const statusPageLine = (ui: Ui, url: string) =>
  ui.rows([["Status page", `${ui.command(url)}  ${ui.dim("Ctrl-C stops the gateway")}`]])

const optionalFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional, Flag.map(Option.getOrUndefined))

/**
 * What `init` would have asked that no flag answers, as the flags to add: the folder, the site, the broker and where
 * the devices come from. The building and the rest have defaults that need no cleaning up.
 */
export const missingInitAnswers = (
  directory: string | undefined,
  given: {
    readonly site: string | undefined
    readonly broker: string | undefined
    readonly points: string | undefined
    readonly devices: string | undefined
  }
): ReadonlyArray<string> => [
  ...(directory === undefined ? ["<folder> (. for this one)"] : []),
  ...(given.site === undefined ? ["--site"] : []),
  ...(given.broker === undefined ? ["--broker"] : []),
  ...(given.points === undefined && given.devices === undefined
    ? ["--points <list> or --devices simulated|discover|none"]
    : [])
]

/**
 * The `init` line to run without a terminal, with the answers it needs: the folder, site, broker and devices given
 * kept as they were and an example for the rest, so it names the folder the user chose (`init . --site …`). Other
 * flags (`--building`, `--status-port`, …) are left to add again.
 */
export const initExample = (
  command: string,
  directory: string | undefined,
  given: {
    readonly site: string | undefined
    readonly broker: string | undefined
    readonly points: string | undefined
    readonly devices: string | undefined
  }
) => {
  const devices =
    given.points !== undefined
      ? `--points ${shellArgument(given.points)}`
      : given.devices !== undefined
        ? `--devices ${shellArgument(given.devices)}`
        : "--points points.csv"
  return [
    `${command} init ${shellArgument(directory ?? "site-1")}`,
    `--site ${shellArgument(given.site ?? "site-1")}`,
    `--broker ${shellArgument(given.broker ?? "mqtts://broker.example:8883")}`,
    devices
  ].join(" ")
}

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
    points: optionalFlag("points", "A points list (CSV or JSON) to take the devices from"),
    broadcast: optionalFlag("broadcast", "The broadcast address for BACnet discovery, when there are several networks"),
    yes: Flag.Boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription(
        "Ask nothing: the defaults for whatever no flag gives (without a terminal, init needs this or the flags)"
      ),
      Flag.withDefault(false)
    ),
    force: Flag.Boolean("force").pipe(Flag.withDescription("Replace an existing config"), Flag.withDefault(false)),
    statusPort: Flag.Int("status-port").pipe(
      Flag.withDescription("The status page's port (default 8080), when another program has 8080"),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
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
      // Nobody to ask and no --yes: writing the defaults would leave a folder of placeholders (my-site, a broker on
      // localhost, a simulated device) to clean up. A dry run writes nothing, so it may fill them in to show them.
      if (!interactive && !given.yes && !given.dryRun) {
        const missing = missingInitAnswers(directory, given)
        if (missing.length > 0) {
          return yield* new UsageMistake({
            code: "missing-answers",
            message: `no terminal to ask, so init needs its answers as flags: ${missing.join(", ")}; or --yes for the defaults (site my-site, a broker on localhost, a simulated device). Nothing was written`,
            missing,
            hint: initExample(yield* invocation, directory, given)
          })
        }
      }
      const flags = { ...given, yes: !interactive }
      // A person gets one column: the prompts, notes and results line up (Ui.ts). Scripts get the plain text.
      const ui = terminalUi()
      const asked = interactive ? inColumn(ui) : <A, E, R>(effect: Effect.Effect<A, E, R>) => effect
      if (interactive) yield* Console.error(ui.header("ot-gateway init", yield* readVersion))
      const config = yield* asked(initTarget(directory, flags.yes))
      const written = yield* asked(runInit(config, flags))
      if (written === undefined) return yield* Console.log(ui.done(`Kept ${config} as it is`))
      const folder = yield* writeFolderFiles(config, written, { dryRun: flags.dryRun, timeZone: localTimeZone() })
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
      if (!interactive) {
        // Scripts and agents get the whole account: the config, every file, the notes and the next commands.
        yield* Console.log(describeConfig(written))
        return yield* Console.log(nextSteps(config, written, files, context))
      }
      // A person gets a few lines to scan, then the one next step: start it now, as create-cloudflare offers to deploy.
      // The folder's ot-gateway.env may hold the broker password already (a folder init kept it in).
      yield* loadFolderEnv(config)
      const summary = initSummary(config, written, files, context, process.env, ui)
      yield* Console.log(["", ...summary.lines].join("\n"))
      const question = startNowQuestion(written, process.env)
      if (question === undefined || !(yield* asked(Prompt.Confirm({ message: question, initial: true })))) {
        return yield* Console.log(["", ...summary.later, ""].join("\n"))
      }
      const loaded = yield* loadConfig(config)
      yield* Console.log(`\n${statusPageLine(ui, initNext(config, written, files, context).url)}\n`)
      return yield* runConfigured(loaded, config).pipe(Effect.provideService(References.MinimumLogLevel, "Info"))
    }).pipe(
      jsonFailure(json),
      Effect.catchTag("QuitError", () =>
        Console.error(terminalUi().failed("init cancelled, nothing written")).pipe(
          Effect.andThen(Effect.sync(() => (process.exitCode = 1)))
        )
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
      Argument.withDescription(
        "A CSV with a device and a point column, one row per point, or the same as a JSON array of rows"
      )
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
    "Add the devices of a points list (CSV or JSON: device, point, host, register, type, unit, …) to the config"
  ),
  Command.withExamples([
    { command: "ot-gateway import points.csv", description: "Add them to ot-gateway.json" },
    { command: "ot-gateway import points.csv site-1/ot-gateway.json", description: "Add them to another config" },
    { command: "ot-gateway import points.csv --dry-run", description: "Only check and print them" },
    { command: "ot-gateway import points.json --dry-run --json", description: "The same for a JSON list, for agents" }
  ])
)

const schemaCommand = Command.make(
  "schema",
  {
    json: jsonFlag,
    brief: Flag.Boolean("brief").pipe(
      Flag.withDescription("Each column's name, scope, required, first sentence and values, one line each; no aliases"),
      Flag.withDefault(false)
    ),
    jsonSchema: Flag.Boolean("json-schema").pipe(
      Flag.withDescription("The JSON form of the list as a JSON Schema (draft 2020-12), to check a list against"),
      Flag.withDefault(false)
    )
  },
  ({ json, brief, jsonSchema }) =>
    jsonSchema
      ? printJson(pointsListJsonSchema())
      : json
        ? brief
          ? printResult(briefPointsListSchemaJson())
          : printJson(pointsListSchema())
        : Console.log(describePointsListSchema({ brief }))
).pipe(
  Command.withDescription("The points list's columns, rules and allowed values"),
  Command.withExamples([
    { command: "ot-gateway points schema", description: "Every column, for people" },
    { command: "ot-gateway points schema --brief --json", description: "The columns in short, for agents" },
    { command: "ot-gateway points schema --json", description: "Everything, with the column names import also reads" },
    { command: "ot-gateway points schema --json-schema", description: "The JSON form's JSON Schema" }
  ])
)

const templateCommand = Command.make(
  "template",
  {
    protocol: Flag.ChoiceWithValue("protocol", [
      ["modbus", "modbus"],
      ["bacnet", "bacnet"],
      ["modbus-tcp", "modbus"],
      ["bacnet-ip", "bacnet"]
    ] as const).pipe(
      Flag.withDescription("Only this protocol's example rows and the columns they can use"),
      Flag.optional
    )
  },
  ({ protocol }) => Effect.sync(() => process.stdout.write(pointsListTemplate(Option.getOrUndefined(protocol))))
).pipe(
  Command.withDescription("A points list with example rows, as CSV on stdout: every column, or one protocol's"),
  Command.withExamples([
    { command: "ot-gateway points template > points.csv", description: "Start a list to fill in" },
    { command: "ot-gateway points template --protocol modbus > points.csv", description: "Only Modbus TCP" },
    { command: "ot-gateway points template --protocol bacnet > points.csv", description: "Only BACnet/IP" }
  ])
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

const exportCommand = Command.make(
  "export",
  {
    config: configPath,
    format: Flag.Literals("format", ["csv", "json"] as const).pipe(
      Flag.withDescription("csv (default), or json: the points list's JSON form, an array of rows"),
      Flag.withDefault("csv" as const)
    ),
    json: jsonFlag
  },
  ({ config, format, json }) =>
    Effect.gen(function* () {
      const decoded = yield* loadConfig(config)
      const list = exportPointsList(decoded)
      const text = format === "json" ? exportJson(list) : exportCsv(list)
      const file = format === "json" ? "points.json" : "points.csv"
      const next = [
        {
          command: `${yield* invocation} import ${file} --dry-run`,
          description: "Check the list; import adds its devices to a config that does not have them yet"
        }
      ]
      if (json) {
        return yield* printJson({
          ok: true,
          path: config,
          format,
          devices: list.devices,
          points: list.rows.length,
          columns: list.columns,
          rows: list.rows,
          ...(format === "csv" ? { csv: text } : {}),
          notCarried: list.notCarried,
          next
        })
      }
      yield* Effect.sync(() => process.stdout.write(text))
      yield* Console.error(
        [
          `✓ ${list.rows.length} point(s) of ${list.devices} device(s) from ${config}`,
          ...describeNotCarried(list.notCarried),
          ...next.map((step) => `next: ${step.command}`)
        ].join("\n")
      )
    }).pipe(jsonFailure(json, { path: config }))
).pipe(
  Command.withDescription(
    "The config's devices as a points list on stdout (CSV, or --format json), the columns import reads, so the list follows edits made in the config or on the status page. What a list cannot say (writable points, semantics, a register's bit, …) is named on stderr; --json: rows, columns and notCarried [{kind, device, point, detail, skipped}]"
  ),
  Command.withExamples([
    { command: "ot-gateway points export > points.csv", description: "The list of ot-gateway.json" },
    { command: "ot-gateway points export site-1/ot-gateway.json --format json > points.json", description: "As JSON" },
    { command: "ot-gateway points export --json", description: "The rows and what the list leaves out, for agents" }
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
  Command.withDescription("The points list, the CSV (or JSON) that import and init read: its schema and a template"),
  Command.withSubcommands([schemaCommand, templateCommand, fromEdeCommand, exportCommand])
)

const contractCommand = Command.make(
  "contract",
  {
    message: Argument.Literals("message", contractMessageNames).pipe(
      Argument.withDescription(
        `One message's fields, or with --json its JSON Schema: ${contractMessageNames.join(", ")}`
      ),
      Argument.optional,
      Argument.map(Option.getOrUndefined)
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription(
        "Print it as JSON: {ok, version, url, topics, schemas}, or with a message that message's JSON Schema alone"
      ),
      Flag.withDefault(false)
    )
  },
  ({ message, json }) =>
    message === undefined
      ? json
        ? printJson(contractJson())
        : Console.log(describeContract())
      : json
        ? printJson(contractJson().schemas[message])
        : Console.log(describeContractMessage(message))
).pipe(
  Command.withDescription(
    "The MQTT contract: every topic the gateway publishes or listens on and its payload, as JSON Schemas; no config needed"
  ),
  Command.withExamples([
    { command: "ot-gateway contract", description: "The topics and messages, for people" },
    { command: "ot-gateway contract health", description: "The health message's fields" },
    { command: "ot-gateway contract --json", description: "Everything with the JSON Schemas, for agents" },
    { command: "ot-gateway contract value --json > value.schema.json", description: "One message's JSON Schema" }
  ])
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
      Flag.withDescription(
        "One JSON object per message and line (NDJSON): at, topic, retained, payload; a watch that ends by itself ends with {event: summary}"
      ),
      Flag.withDefault(false)
    ),
    untilValues: Flag.Boolean("until-values").pipe(
      Flag.withDescription(
        "Stop once every configured point sent a value; exit 1 naming the ones that did not within --seconds (default: the slowest poll interval and 30 s, at least 60 s)"
      ),
      Flag.withDefault(false)
    ),
    check: Flag.Boolean("check").pipe(
      Flag.withDescription(
        "Check each message under the site and building against the MQTT contract, print only those off it with what is wrong; a watch that ends by itself exits 1 when one was"
      ),
      Flag.withDefault(false)
    )
  },
  ({ config, topic, seconds, json, untilValues, check: againstContract }) =>
    Effect.flatMap(loadConfig(config), (decoded) =>
      watch(decoded, {
        topic: Option.getOrUndefined(topic),
        seconds: Option.getOrUndefined(seconds),
        json,
        untilValues,
        check: againstContract
      })
    ).pipe(jsonFailure(json, { path: config }, { lines: true }))
).pipe(
  Command.withDescription("Print what arrives at the config's broker under its site and building, as it arrives"),
  Command.withExamples([
    { command: "ot-gateway watch", description: "Watch the broker in ot-gateway.json" },
    { command: "ot-gateway watch --topic 'site-1/building-a/heat-pump/#'", description: "Only one device" },
    { command: "ot-gateway watch --seconds 10", description: "Ten seconds of it, then stop" },
    { command: "ot-gateway watch --seconds 10 --json", description: "The same as JSON lines, for scripts and agents" },
    { command: "ot-gateway watch --until-values --json", description: "Wait until every point sent a value" },
    { command: "ot-gateway watch --check --seconds 60", description: "A minute of messages against the MQTT contract" }
  ])
)

/**
 * `broker`'s report, as JSON or text, then a failure when its message did not come back, so the exit code is 1.
 * The failure comes after the output and outside `jsonFailure`, so the report is printed once and is the JSON; a
 * failed report carries the failure's `code` and `hint` as any other failure's JSON does.
 */
export const brokerOutcome = (json: boolean) =>
  Effect.fnUntraced(function* (report: BrokerReport) {
    const failure = report.ok ? undefined : roundTripFailure(report)
    yield* json
      ? printJson(failure === undefined ? report : { ...report, code: failure.code, hint: failure.hint })
      : Console.log(formatBrokerReport(report))
    if (failure !== undefined) return yield* failure
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

/** `--config`, the same as naming the config as the argument: status, events, history and messages take both. */
const targetConfigFlag = Flag.String("config").pipe(
  Flag.withDescription(
    `Path of the gateway's JSON config, the same as naming it as the argument (default ${defaultConfigPath} when it is in this folder)`
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined)
)

/** The gateway status, events and history ask: the config named either way, or `--url`, or the defaults. */
const targetFrom = (positional: string | undefined, flag: string | undefined, url: string | undefined) =>
  chooseConfig(positional, flag).pipe(Effect.flatMap((config) => resolveTarget({ config, url })))

const diffCommand = Command.make(
  "diff",
  {
    config: configPath,
    against: Flag.String("against").pipe(
      Flag.withDescription(
        "Compare with this config file (the one before; ot-gateway.json.bak after a save on the status page) instead of the running gateway"
      ),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
    url: urlFlag,
    json: jsonFlag
  },
  ({ config, against, url, json }) =>
    Effect.gen(function* () {
      if (against !== undefined && url !== undefined) {
        return yield* new UsageMistake({
          message: "--against compares with a file and --url with a running gateway: give one of them",
          code: "usage",
          missing: [],
          hint: "ot-gateway diff --help"
        })
      }
      const report = yield* diffReport(config, { against, url })
      const context = {
        command: yield* invocation,
        config: config === DEFAULT_CONFIG ? undefined : config,
        against
      }
      const next = clearCommands(report.diff, context).map((command) => ({
        command,
        description: "After the change: clear a retained message nobody publishes any more"
      }))
      if (json) return yield* printJson({ ok: true, path: config, against: report.against, ...report.diff, next })
      yield* Console.log(formatDiff(report.diff, diffTitle(report), context))
    }).pipe(jsonFailure(json, { path: config }))
).pipe(
  Command.withDescription(
    "What a config change does on the broker before it is applied, against the running gateway (or --against an older file): topics new (+), silent (-) and moved (→: a point, device, site or building renamed), points that take commands now (!), $meta that changes (~), settings that change, and the retained messages left behind with the command to clear each. --json: changed, added, removed, moved, writable, meta, settings, stale, next"
  ),
  Command.withExamples([
    { command: "ot-gateway diff", description: "ot-gateway.json against the gateway running now" },
    {
      command: "ot-gateway diff ot-gateway.json --against ot-gateway.json.bak",
      description: "Against the config before the last save"
    },
    { command: "ot-gateway diff --json", description: "The same as JSON, for agents" }
  ])
)

const writeCommand = Command.make(
  "write",
  {
    target: Argument.String("point").pipe(
      Argument.withDescription("device/point, as in the config: demo-room/temperature-setpoint"),
      Argument.filter(
        (text) => parseTarget(text) !== undefined,
        () => "name a device/point"
      )
    ),
    value: Argument.String("value").pipe(
      Argument.withDescription(
        "A number in the point's unit, true or false (on/off) for a switch, null to release a BACnet priority slot"
      )
    ),
    config: Argument.String("config").pipe(
      Argument.withDescription(
        `Path of the gateway's JSON config (default ${defaultConfigPath}): its broker, site, building and points`
      ),
      Argument.optional,
      Argument.map(Option.getOrUndefined)
    ),
    configFlag: Flag.String("config").pipe(
      Flag.withDescription("Path of the gateway's JSON config, the same as naming it as the argument"),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription(
        "Seconds to wait for the gateway's result (default 25: up to 10 for its turn, 10 for the write)"
      ),
      Flag.filter(
        (seconds) => seconds >= 1 && seconds <= 300,
        (seconds) => `--timeout takes 1 to 300, not ${seconds}`
      ),
      Flag.withDefault(25)
    ),
    json: jsonFlag
  },
  ({ target, value, config, configFlag, timeout, json }) =>
    chooseConfig(config, configFlag).pipe(
      Effect.flatMap((path) => loadConfig(path ?? defaultConfigPath)),
      Effect.flatMap((decoded) =>
        writePoint(decoded, parseTarget(target) ?? { device: "", point: "" }, value, {
          timeout: Duration.seconds(timeout)
        })
      ),
      Effect.flatMap((report) => (json ? printJson(report) : Console.log(formatWritten(report)))),
      jsonFailure(json, { point: target, value })
    )
).pipe(
  Command.withDescription(
    "Write a point through the gateway, as a consumer would: a guarded command on its $set topic, then its result (exit 1 when not written)"
  ),
  Command.withExamples([
    {
      command: "ot-gateway write demo-room/temperature-setpoint 21.5",
      description: "Set a setpoint, wait for the result"
    },
    { command: "ot-gateway write plant/pump-enable on --json", description: "Switch a point on, the outcome as JSON" }
  ])
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
    configFlag: targetConfigFlag,
    url: urlFlag,
    json: jsonFlag,
    failOnAlarm: Flag.Boolean("fail-on-alarm").pipe(
      Flag.withDescription("Also exit with 1 while an alarm point is active, for scripts that act on alarms"),
      Flag.withDefault(false)
    )
  },
  ({ config, configFlag, url, json, failOnAlarm }) =>
    targetFrom(config, configFlag, url).pipe(
      Effect.flatMap((target) => fetchStatusFor(target, { json })),
      jsonFailure(json, { url: url ?? null, path: config ?? configFlag ?? null }),
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
    configFlag: targetConfigFlag,
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
  ({ config, configFlag, url, since, follow, seconds, json }) =>
    targetFrom(config, configFlag, url).pipe(
      Effect.flatMap((target) =>
        eventsReport(target, {
          since,
          sinceMs: parseSince(since) ?? Number.POSITIVE_INFINITY,
          json,
          follow: follow || seconds !== undefined,
          seconds
        })
      ),
      jsonFailure(json, { url: url ?? null, path: config ?? configFlag ?? null })
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
    configFlag: targetConfigFlag,
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
  ({ points: selection, config, configFlag, url, since, buckets, json }) =>
    targetFrom(config, configFlag, url).pipe(
      Effect.flatMap((target) =>
        historyReport(target, parseSelection(selection) ?? [], {
          since,
          sinceMs: parseSince(since) ?? 600_000,
          buckets,
          json
        })
      ),
      jsonFailure(json, { url: url ?? null, path: config ?? configFlag ?? null })
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
    config: targetConfigFlag,
    url: urlFlag,
    since: Flag.String("since").pipe(
      Flag.withDescription(
        `Count only the last 30s, 10m or up to ${MESSAGE_WINDOW_MS / 60_000}m (the gateway keeps a count per topic per minute for an hour); since its start when left out`
      ),
      Flag.filter(
        (since) => {
          const ms = parseSince(since)
          return since !== "all" && ms !== undefined && ms <= MESSAGE_WINDOW_MS
        },
        (since) => `--since takes 30s, 10m or up to ${MESSAGE_WINDOW_MS / 60_000}m, not ${since}`
      ),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
    json: jsonFlag
  },
  ({ points: pointsArgument, positionalConfig, config: configFlag, url, since, json }) => {
    const chosen = messagesArguments(pointsArgument, positionalConfig, configFlag)
    const config = "error" in chosen ? undefined : chosen.config
    return Effect.gen(function* () {
      if ("error" in chosen) return yield* new BrokerCommandError({ message: chosen.error })
      const target = yield* resolveTarget({ config, url })
      const selection = chosen.points === undefined ? [] : (parseSelection(chosen.points) ?? [])
      return yield* messagesReport(target, selection, {
        json,
        since,
        sinceMs: since === undefined ? undefined : parseSince(since)
      })
    }).pipe(jsonFailure(json, { url: url ?? null, path: config ?? null }))
  }
).pipe(
  Command.withDescription(
    "How many messages the running gateway published per topic since it started (or in the last --since, up to an hour), how many reached the broker, and the last one"
  ),
  Command.withExamples([
    { command: "ot-gateway messages", description: "Every topic under the gateway's site and building" },
    { command: "ot-gateway messages energy-meter/active-power", description: "One point's value and $meta topics" },
    { command: "ot-gateway messages energy-meter --json", description: "A device's topics as JSON" },
    { command: "ot-gateway messages --since 5m", description: "Only the last 5 minutes, in whole minutes" },
    { command: "ot-gateway messages energy-meter site-1/ot-gateway.json", description: "The gateway of another config" }
  ])
)

const logsCommand = Command.make(
  "logs",
  {
    config: targetConfig,
    configFlag: targetConfigFlag,
    url: urlFlag,
    level: Flag.Literals("level", ["info", "warn", "error"]).pipe(
      Flag.withDescription("The least severe level to print: info (everything kept), warn or error"),
      Flag.withDefault("info")
    ),
    since: Flag.String("since").pipe(
      Flag.withDescription(
        "How far back: 30s, 10m, 2h, 1d, or all (the gateway keeps its latest 300 warnings and errors and 200 info lines, in memory since it started)"
      ),
      Flag.filter(
        (since) => parseSince(since) !== undefined,
        (since) => `--since takes 30s, 10m, 2h, 1d or all, not ${since}`
      ),
      Flag.withDefault("1h")
    ),
    follow: Flag.Boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("Then print each new line as it comes, until Ctrl-C (or --seconds)"),
      Flag.withDefault(false)
    ),
    seconds: secondsFlag("With --follow, stop after this many seconds instead of at Ctrl-C, for scripts and agents"),
    json: jsonFlag
  },
  ({ config, configFlag, url, level, since, follow, seconds, json }) =>
    targetFrom(config, configFlag, url).pipe(
      Effect.flatMap((target) =>
        logsReport(target, {
          since,
          sinceMs: parseSince(since) ?? Number.POSITIVE_INFINITY,
          level,
          json,
          follow: follow || seconds !== undefined,
          seconds
        })
      ),
      jsonFailure(json, { url: url ?? null, path: config ?? configFlag ?? null })
    )
).pipe(
  Command.withDescription(
    "The running gateway's recent log lines, oldest first, from the ring it keeps in memory: the warnings and errors behind status and events (a decode problem, a refused write, a config that did not apply), without docker logs. Secrets are redacted, long lines cut"
  ),
  Command.withExamples([
    { command: "ot-gateway logs", description: "The last hour" },
    { command: "ot-gateway logs --level warn --since 10m", description: "Warnings and errors of the last 10 minutes" },
    { command: "ot-gateway logs --follow", description: "The last hour, then each new line as it comes" },
    { command: "ot-gateway logs --since all --json", description: "Everything it keeps, as JSON" }
  ])
)

/**
 * `read`'s arguments: the points and the config, either order. A word ending in `.json` is the config (`read
 * site-1/ot-gateway.json`, `read room site-1/ot-gateway.json`, `read site-1/ot-gateway.json room`); `--config` names
 * it too.
 */
const isJsonPath = (word: string | undefined) => word !== undefined && word.toLowerCase().endsWith(".json")

export const readArguments = (
  first: string | undefined,
  second: string | undefined,
  flag: string | undefined
): { readonly points?: string; readonly config: string } | { readonly error: string } => {
  if (isJsonPath(first) && isJsonPath(second)) return { error: `two configs: ${first} and ${second}; name one` }
  const [config, selection] = isJsonPath(first) ? [first, second] : [second, first]
  if (config !== undefined && flag !== undefined && config !== flag) {
    return { error: `two configs: ${config} and --config ${flag}; name one` }
  }
  return { ...(selection === undefined ? {} : { points: selection }), config: config ?? flag ?? DEFAULT_CONFIG }
}

const readCommand = Command.make(
  "read",
  {
    points: Argument.String("points").pipe(
      Argument.withDescription(
        "device/point, a device for all its points, or several of either comma-separated; every point when left out"
      ),
      Argument.optional,
      Argument.map(Option.getOrUndefined)
    ),
    positionalConfig: Argument.String("config").pipe(
      Argument.withDescription(`Path of the gateway's JSON config (default ${DEFAULT_CONFIG})`),
      Argument.optional,
      Argument.map(Option.getOrUndefined)
    ),
    config: Flag.String("config").pipe(
      Flag.withDescription("Path of the gateway's JSON config, the same as naming it as an argument"),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription(
        `Seconds each device may take, connecting and finding it included (default ${DEFAULT_READ_SECONDS})`
      ),
      Flag.filter(
        (seconds) => seconds >= 1 && seconds <= 600,
        (seconds) => `--timeout takes 1 to 600 seconds, not ${seconds}`
      ),
      Flag.withDefault(DEFAULT_READ_SECONDS)
    ),
    json: jsonFlag
  },
  ({ points: first, positionalConfig, config: configFlag, timeout, json }) => {
    const chosen = readArguments(first, positionalConfig, configFlag)
    return Effect.gen(function* () {
      if ("error" in chosen) {
        return yield* new UsageMistake({
          code: "usage",
          message: chosen.error,
          missing: [],
          hint: "ot-gateway read --help"
        })
      }
      const decoded = yield* loadConfig(chosen.config)
      const selection = chosen.points === undefined ? [] : parseReadSelection(chosen.points)
      if (selection === undefined) {
        return yield* new UsageMistake({
          code: "usage",
          message: `no device or point named in "${chosen.points ?? ""}"; leave it out to read every point`,
          missing: [],
          hint: "ot-gateway read --help"
        })
      }
      const devices = yield* selectDevices(decoded, selection)
      if (!json && process.stderr.isTTY) {
        const count = devices.reduce((sum, device) => sum + device.points.length, 0)
        yield* Console.error(`reading ${count} point(s) of ${devices.length} device(s) once …`)
      }
      // The report says what failed and why; the drivers' warnings about it would only repeat it, unformatted.
      return yield* readOnce(decoded, devices, { timeout: Duration.seconds(timeout) }).pipe(
        Effect.provideService(References.MinimumLogLevel, "Error")
      )
    }).pipe(
      jsonFailure(json, { path: "error" in chosen ? null : chosen.config }),
      Effect.flatMap((report) =>
        Effect.gen(function* () {
          yield* json ? printJsonWithLocalTimes(report) : printResult(formatReadReport(report))
          if (!report.ok) return yield* new ReadIncomplete({ message: incompleteMessage(report) })
        })
      )
    )
  }
).pipe(
  Command.withDescription(
    "Read every configured point (or the ones named) once through the gateway's drivers and exit, without a running gateway or a broker; exits with 1 when a point was not read. Read-only: it never writes"
  ),
  Command.withExamples([
    { command: "ot-gateway read", description: "Every point of ot-gateway.json in this folder" },
    { command: "ot-gateway read demo-room", description: "Every point of one device" },
    {
      command: "ot-gateway read demo-room/setpoint,meter",
      description: "One point, and every point of another device"
    },
    { command: "ot-gateway read site-1/ot-gateway.json --json", description: "Another config, as JSON" }
  ])
)

const probeCommand = Command.make(
  "probe",
  {
    device: Argument.String("device").pipe(
      Argument.withDescription(
        "The device's host or host:port, as the points list's host and port (port 502 when left out)"
      )
    ),
    register: Argument.Int("register").pipe(
      Argument.withDescription(
        "The 0-based address, as the points list's register column: a datasheet's 40101 is usually holding register 100"
      )
    ),
    unitId: Flag.Int("unit-id").pipe(
      Flag.withAlias("u"),
      Flag.withDescription("The Modbus unit (slave) id, as the points list's unit_id column"),
      Flag.withDefault(1)
    ),
    table: Flag.Literals("table", probeTables).pipe(
      Flag.withAlias("t"),
      Flag.withDescription("The register table, as the points list's table column"),
      Flag.withDefault("holding")
    ),
    count: Flag.Int("count").pipe(
      Flag.withAlias("n"),
      Flag.withDescription(
        "How many registers (or bits) to read: 2 by default, enough for 32-bit types (1 for coil and discrete); 4 adds the 64-bit ones"
      ),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
    json: jsonFlag
  },
  ({ device, register, unitId, table, count, json }) =>
    Effect.gen(function* () {
      const endpoint = parseEndpoint(device)
      if (endpoint === undefined) {
        return yield* new ProbeError({
          reason: "usage",
          message: `${device} is not a host or host:port (192.168.1.50, 192.168.1.50:5020, [fd00::5]:502)`
        })
      }
      const report = yield* probe({
        ...endpoint,
        unitId,
        table,
        address: register,
        count: count ?? defaultCount(table)
      })
      yield* json ? printJson(probeJson(report)) : printResult(formatProbeReport(report))
    }).pipe(
      Effect.tapError((error) =>
        json
          ? printJson({
              ok: false,
              device,
              reason: error.reason,
              ...(error.exceptionCode === undefined ? {} : { exceptionCode: error.exceptionCode }),
              error: error.message
            })
          : Effect.void
      )
    )
).pipe(
  Command.withDescription(
    "Read Modbus registers once and show every type and byte order they read as, with a points list row to copy; read-only, it never writes"
  ),
  Command.withExamples([
    { command: "ot-gateway probe 192.168.1.50 100", description: "Holding registers 100 and 101 of unit 1" },
    {
      command: "ot-gateway probe 192.168.1.50:5020 0 --table input --count 4",
      description: "Input registers 0 to 3, 64-bit types too"
    },
    {
      command: "ot-gateway probe 192.168.1.60 342 --unit-id 2 --json",
      description: "A meter behind a Modbus gateway, as JSON"
    }
  ])
)

const simulateBacnetCommand = Command.make(
  "bacnet",
  {
    instance: Flag.Int("instance").pipe(
      Flag.withDescription("The device instance, 0 to 4194302 (two devices on one network need different ones)"),
      Flag.withDefault(1001)
    ),
    port: Flag.Int("port").pipe(
      Flag.withDescription(
        "The UDP port; 47808 to be found by a broadcast Who-Is, another one when a gateway on this machine holds it"
      ),
      Flag.withDefault(47_808)
    ),
    listen: Flag.String("listen").pipe(
      Flag.withDescription("The IPv4 address to listen on: 0.0.0.0, every interface, receives broadcasts"),
      Flag.withDefault("0.0.0.0")
    )
  },
  ({ instance, port, listen }) =>
    Effect.gen(function* () {
      if (!Number.isInteger(instance) || instance < 0 || instance > 4_194_302) {
        return yield* new SimulateError({ message: `--instance takes 0 to 4194302, not ${instance}` })
      }
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        return yield* new SimulateError({ message: `--port takes 1 to 65535, not ${port}` })
      }
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(listen) || listen.split(".").some((octet) => Number(octet) > 255)) {
        return yield* new SimulateError({
          message: `--listen takes an IPv4 address (BACnet/IP is IPv4 only), not ${listen}`
        })
      }
      return yield* simulateBacnet({ instance, port, listen })
    }).pipe(
      Effect.scoped,
      // Nothing has run yet: one plain line, like a one-shot command's answer, not a log line.
      Effect.catchTag("SimulateError", (error) =>
        Console.error(failureLine(error.message)).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1))))
      )
    )
).pipe(
  Command.withDescription(
    "A simulated BACnet/IP device on this machine's network: a room with a temperature, a writable setpoint and its heating, to discover, read and write from another machine"
  ),
  Command.withExamples([
    { command: "ot-gateway simulate bacnet", description: "Device 1001 on UDP 47808, found by discover on the LAN" },
    {
      command: "ot-gateway simulate bacnet --port 47810 --instance 1002",
      description: "Next to a gateway on this machine; discover it with --address <ip>:47810"
    }
  ])
)

const doctorCommand = Command.make("doctor", { config: configPath, json: jsonFlag }, ({ config, json }) =>
  Effect.gen(function* () {
    const report = yield* runDoctor(config, { cli: yield* invocation })
    // A terminal gets one line per check and the one command to run; a pipe or a log the hint for each problem too.
    yield* json ? printJson(report) : Console.log(formatDoctor(report, { brief: process.stdout.isTTY }))
    const problems = doctorProblems(report)
    if (problems !== undefined) return yield* problems
  })
).pipe(
  Command.withDescription(
    "Run every check in order: the config, the broker (a round trip), the running gateway, each device (read-only: its first point, or a Who-Is for its instance, when the gateway does not run), the BACnet/IP port, the disk and the clock. One line per finding and the command to run next; --json: findings [{check, status, subject, message, code, hint, next}]. Exits with 1 when one fails"
  ),
  Command.withExamples([
    { command: "ot-gateway doctor", description: "Check ot-gateway.json in this folder and everything it names" },
    { command: "ot-gateway doctor site-1/ot-gateway.json --json", description: "Another config, as JSON" }
  ])
)

const explainCommand = Command.make(
  "explain",
  {
    code: Argument.String("code").pipe(
      Argument.withDescription(
        "A code as a command printed it (broker-unreachable), or a command result (rejected out-of-range); none lists every code"
      ),
      Argument.optional,
      Argument.map(Option.getOrUndefined)
    ),
    markdown: Flag.Boolean("markdown").pipe(
      Flag.withDescription(
        "Print every code as the Markdown table in docs/troubleshooting.md, to paste there after adding a code"
      ),
      Flag.withDefault(false)
    ),
    json: jsonFlag
  },
  ({ code, markdown, json }) =>
    Effect.gen(function* () {
      const cli = yield* invocation
      if (markdown) return yield* printResult(codesTable())
      if (code === undefined) {
        return yield* json
          ? printJson({ ok: true, codes: codes.map((entry) => codeJson(entry, cli)) })
          : printResult(formatCodeList())
      }
      const entry = yield* Effect.fromResult(explainCode(code))
      yield* json ? printJson({ ok: true, ...codeJson(entry, cli) }) : printResult(formatCode(entry, cli))
    }).pipe(jsonFailure(json, { asked: code ?? null }))
).pipe(
  Command.withDescription(
    "What a code means, what to do about it and the command to run next: any code a command prints, in its --json code, a doctor finding or a command result. With no code, every code by area"
  ),
  Command.withExamples([
    { command: "ot-gateway explain broker-login-refused", description: "One code" },
    { command: "ot-gateway explain timeout --json", description: "As JSON, with what to check per protocol" },
    { command: "ot-gateway explain", description: "Every code, one line each" }
  ])
)

const supportCommand = Command.make(
  "support",
  {
    config: targetConfig,
    configFlag: targetConfigFlag,
    url: urlFlag,
    output: Flag.String("output").pipe(
      Flag.withAlias("o"),
      Flag.withDescription(
        "Where to write the bundle (default ot-gateway-support-<date>-<time>.md in this folder); - prints it instead (with --json: {ok, text, sections})"
      ),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
    json: jsonFlag
  },
  ({ config, configFlag, url, output, json }) =>
    Effect.gen(function* () {
      const now = Date.now()
      const bundle = yield* supportBundle({ config: yield* chooseConfig(config, configFlag), url, now })
      const sections = bundle.sections.map(({ name, ok, note }) => ({ name, ok, note }))
      if (output === "-") {
        return yield* json ? printJson({ ok: true, text: bundle.text, sections }) : printResult(bundle.text.trimEnd())
      }
      const path = output ?? supportFileName(now)
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(path, bundle.text)
      yield* json
        ? printJson({
            ok: true,
            path,
            bytes: Buffer.byteLength(bundle.text),
            sections
          })
        : printResult(formatSupportSummary(path, bundle))
    }).pipe(jsonFailure(json, { path: config ?? configFlag ?? null }))
).pipe(
  Command.withDescription(
    "Write one file for an issue report: versions and host, the config (redacted), which settings variables are set, and the running gateway's status, last 24 hours of events and the log lines it keeps. Secrets are redacted; device addresses and names are not. Sections it cannot fill say why, so it works while the gateway is down too"
  ),
  Command.withExamples([
    { command: "ot-gateway support", description: "The gateway of ot-gateway.json in this folder" },
    { command: "ot-gateway support site-1/ot-gateway.json -o report.md", description: "Another config, to report.md" },
    { command: "ot-gateway support --output -", description: "Print it instead of writing a file" }
  ])
)

/**
 * `mcp`: the commands as MCP tools on stdin and stdout. Its type is written out because a tool call runs `runCli`,
 * whose type is the CLI's, this command included.
 */
const mcpCommand = Command.make("mcp", {}, (): Effect.Effect<void, never, NodeServices> =>
  Effect.gen(function* () {
    const version = yield* readVersion
    // stdout is the protocol's: what is printed besides goes to stderr.
    const log = yield* Console.Console
    yield* serveMcp({
      tools: mcpTools,
      version,
      run: (argv): Effect.Effect<unknown, unknown, NodeServices> => runCli(argv),
      log
    })
  }).pipe(Effect.updateService(Console.Console, stderrConsole))
).pipe(
  Command.withDescription(
    "Serve these commands as MCP tools over stdio (check, doctor, status, read, write, watch, …), for agents that do not run a shell; each tool's result is the command's --json"
  ),
  Command.withExamples([
    { command: "ot-gateway mcp", description: "Started by an MCP client, in the gateway's folder" },
    { command: "claude mcp add ot-gateway -- npx ot-gateway mcp", description: "Add it to Claude Code" }
  ])
)

const deployTarget = Argument.String("config").pipe(
  Argument.withDescription(
    `The gateway's JSON config, or its folder (default ./${DEFAULT_CONFIG}); compose.yaml is next to it`
  ),
  Argument.withDefault(DEFAULT_CONFIG)
)

const waitSeconds = Flag.Int("timeout").pipe(
  Flag.withDescription("Seconds to wait until every point has a value (default 120)"),
  Flag.filter(
    (seconds) => seconds >= 1 && seconds <= 3600,
    (seconds) => `--timeout takes 1 to 3600, not ${seconds}`
  ),
  Flag.withDefault(120)
)

const forceFlag = Flag.Boolean("force").pipe(
  Flag.withDescription(
    "Go ahead on Docker Desktop (macOS, Windows), which reaches no devices on the LAN: for simulated devices or a broker here"
  ),
  Flag.withDefault(false)
)

const noWaitFlag = Flag.Boolean("no-wait").pipe(
  Flag.withDescription("Return once Compose has started it, without waiting for values"),
  Flag.withDefault(false)
)

/** What up, down, restart and upgrade need of this machine: how the CLI was run, the platform and the folder. */
const deployContext = Effect.map(invocation, (cli) => ({ cli, platform: process.platform, cwd: process.cwd() }))

/** A report for a person: the lines printed on the way, then its warnings and the command to run next. */
const deployDone = (
  json: boolean,
  report: { readonly next: string | null; readonly warnings?: ReadonlyArray<string> }
) => {
  if (json) return printJson(report)
  const lines = [...(report.warnings ?? []).map((warning) => `! ${warning}`), ...nextLine(report.next)]
  return lines.length === 0 ? Effect.void : Console.log(lines.join("\n"))
}

const upOrRestart = (recreate: boolean) =>
  Command.make(
    recreate ? "restart" : "up",
    { config: deployTarget, timeout: waitSeconds, noWait: noWaitFlag, force: forceFlag, json: jsonFlag },
    ({ config, timeout, noWait, force, json }) =>
      Effect.gen(function* () {
        const context = yield* deployContext
        const report = yield* up(config, {
          ...context,
          recreate,
          force,
          wait: !noWait,
          timeout: Duration.seconds(timeout)
        })
        yield* deployDone(json, report)
      }).pipe(Effect.provide(dockerLayer), jsonFailure(json, { action: recreate ? "restart" : "up", config }))
  )

const upCommand = upOrRestart(false).pipe(
  Command.withDescription(
    "Start the gateway of this folder with Docker Compose and wait until every point has a value: checks the config, writes compose.yaml when there is none, docker compose up -d. Exit 1 with code, hint and next when values do not flow"
  ),
  Command.withExamples([
    { command: "ot-gateway up", description: "Start ./ot-gateway.json's gateway, wait for values" },
    { command: "ot-gateway up site-1 --json", description: "The gateway of the folder site-1, the outcome as JSON" }
  ])
)

const restartCommand = upOrRestart(true).pipe(
  Command.withDescription(
    "Recreate the gateway's container (it reads the config and ot-gateway.env again) and wait until every point has a value"
  ),
  Command.withExamples([{ command: "ot-gateway restart", description: "After editing ot-gateway.env" }])
)

const downCommand = Command.make("down", { config: deployTarget, json: jsonFlag }, ({ config, json }) =>
  Effect.gen(function* () {
    const report = yield* down(config, yield* deployContext)
    yield* deployDone(json, report)
  }).pipe(Effect.provide(dockerLayer), jsonFailure(json, { action: "down", config }))
).pipe(
  Command.withDescription(
    "Stop the gateway of this folder (docker compose down); the outbox and history stay in their volume"
  ),
  Command.withExamples([{ command: "ot-gateway down", description: "Stop ./ot-gateway.json's gateway" }])
)

const upgradeCommand = Command.make(
  "upgrade",
  {
    config: deployTarget,
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Only say whether a newer release is out; change nothing"),
      Flag.withDefault(false)
    ),
    to: Flag.String("to").pipe(
      Flag.withDescription("The release to move to (v0.16.0), an older one too; the newest when left out"),
      Flag.filter(
        (tag) => isDockerTag(tag),
        (tag) => `--to takes a release tag such as v0.16.0, not ${tag}`
      ),
      Flag.optional,
      Flag.map(Option.getOrUndefined)
    ),
    timeout: waitSeconds,
    force: forceFlag,
    json: jsonFlag
  },
  ({ config, check: checkOnly, to, timeout, force, json }) =>
    Effect.gen(function* () {
      const context = yield* deployContext
      const envTag = yield* Config.String("OT_GATEWAY_TAG").pipe(Config.option, Config.map(Option.getOrUndefined))
      const report = yield* upgrade(config, {
        ...context,
        check: checkOnly,
        to,
        envTag,
        force,
        timeout: Duration.seconds(timeout)
      })
      yield* deployDone(json, report)
    }).pipe(Effect.provide(dockerLayer), jsonFailure(json, { action: checkOnly ? "upgrade-check" : "upgrade", config }))
).pipe(
  Command.withDescription(
    "Move the gateway of this folder to the newest release: pull it, check the config with it, switch compose.yaml's tag, wait until values flow again, and go back to the old release when they do not. --check only says whether one is out"
  ),
  Command.withExamples([
    { command: "ot-gateway upgrade --check", description: "Is a newer release out?" },
    { command: "ot-gateway upgrade", description: "Move to it, back again when values stop" },
    { command: "ot-gateway upgrade --to v0.15.0", description: "Back to an older release" }
  ])
)

const simulate = Command.make("simulate").pipe(
  Command.withDescription("Simulated devices on the network, to try the gateway against without a building"),
  Command.withSubcommands([simulateBacnetCommand])
)

/** The top of `--help`: what it is, then the short way through for agents, which read help first. */
export const rootDescription = [
  "OT Gateway: Modbus TCP and BACnet/IP in, MQTT 5 or 3.1.1 out, safe commands back",
  "",
  "  For AI agents: nothing asks without a terminal, and --json prints results and failures as JSON.",
  "    diff --json                      what a config change does on the broker before it is applied: topics, writable points, stale $meta",
  "    points export --json             the config's devices as a points list again, and what a list cannot carry",
  "    points schema --json             the points list's columns: translate any list or EDE file into it (CSV, or JSON rows: --json-schema)",
  "    profiles list --json             Modbus models a points list row takes the registers of by name",
  "    import <list> --dry-run --json   check a points list, row by row",
  "    init <folder> --dry-run --json   the folder init would write (with --site, --broker, --points <list>)",
  "    check --json                     every mistake in a config, with its path",
  "    broker --json                    the broker: MQTT version, limits, a round trip",
  "    status --json                    the running gateway, device by device, with what to check; exits 1 when something fails",
  "    events --since 1h --json         what broke, since when and why, and when it came back (--follow: as it happens)",
  "    history <device/point> --json    what a point did lately: min, max, average per bucket, and the gaps",
  "    messages [<device/point>] --json how many messages went out per topic since start (--since 10m: lately), and reached the broker",
  "    logs --level warn --since 1h     the gateway's recent warnings and errors in detail, without docker logs (--follow, --json)",
  "    probe <host> <register> --json   read Modbus registers once: every type and byte order, to pick the points list's type and byte_order",
  "  status, events, history, messages and logs ask the gateway of ./ot-gateway.json (or the config named, or --config) at its status port.",
  "  Their --json gives each time as Unix ms and as <key>Local, this machine's local time with its UTC offset (timeZone names the zone)."
].join("\n")

export const cli = Command.make("ot-gateway").pipe(
  Command.withDescription(rootDescription),
  Command.withSubcommands([
    demo,
    init,
    run,
    check,
    doctorCommand,
    upCommand,
    downCommand,
    restartCommand,
    upgradeCommand,
    discoverCommand,
    importCommand,
    diffCommand,
    points,
    profiles,
    contractCommand,
    watchCommand,
    brokerCommand,
    publishCommand,
    writeCommand,
    status,
    eventsCommand,
    historyCommand,
    messagesCommand,
    logsCommand,
    readCommand,
    probeCommand,
    explainCommand,
    supportCommand,
    simulate,
    mcpCommand
  ])
)

const subcommands = new Set([
  "demo",
  "init",
  "run",
  "check",
  "doctor",
  "up",
  "down",
  "restart",
  "upgrade",
  "discover",
  "import",
  "diff",
  "points",
  "profiles",
  "contract",
  "watch",
  "broker",
  "publish",
  "write",
  "status",
  "events",
  "history",
  "messages",
  "logs",
  "read",
  "probe",
  "explain",
  "support",
  "simulate",
  "mcp"
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

/**
 * The arguments to run for `argv` as typed: a bare `ot-gateway` in a terminal with no `ot-gateway.json` here starts
 * `init`, as a bare `vercel` sets up a project it does not know yet. Without a terminal, or with a config, it stays
 * `run`, which the image and the systemd unit rely on.
 */
export const withFirstRun = (
  argv: ReadonlyArray<string>,
  where: { readonly terminal: boolean; readonly configHere: boolean }
): ReadonlyArray<string> => (argv.length === 0 && where.terminal && !where.configHere ? ["init"] : argv)

/** The commands that run until stopped and log what they do, as the gateway does. */
const longRunning = new Set(["run", "demo", "simulate"])

/** Whether `argv` (without node and the script) runs until stopped, the forms from before the subcommands too. */
export const isLongRunning = (argv: ReadonlyArray<string>) => longRunning.has(toCliArgs(argv)[0] ?? "")
