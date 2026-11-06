/**
 * `ot-gateway init`: a few questions, then a config that `check` accepts. It asks for the site and building
 * (the first two topic segments), the broker, and where the devices come from: a simulated device to try
 * things with, the BACnet devices that answer a Who-Is (drafted read-only, as `discover` does), or none yet.
 *
 * The answers become the config in `initConfig`, a pure function, and the result is decoded with the gateway's
 * own schema before anything is written, so `init` never leaves a config that `run` refuses. An existing file
 * is only replaced after a yes.
 */
import { GatewayConfig, parseConfig, Slug } from "@ot-gateway/core"
import { parseBrokerUrl } from "@ot-gateway/mqtt"
import { Console, Effect, FileSystem, Schema, type Terminal } from "effect"
import { Prompt } from "effect/cli"
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os"
import { basename, dirname, join } from "node:path"
import { discoverDrafts, type draftDevices } from "./Discover.ts"
import { folderConfigName, type FolderFiles } from "./Folder.ts"
import { devicesFromFile } from "./Import.ts"
import type { PointsListDevice } from "./PointsList.ts"

/** A simulated device with two points, to see values flow before any real device is connected. */
export const simulatedDevice = {
  protocol: "simulator",
  id: "sim-1",
  pollIntervalMs: 2000,
  points: [
    {
      id: "supply-air-temp",
      name: "Simulated supply air temperature",
      unit: "unit:DEG_C",
      deadband: 0.2,
      waveform: "sine",
      min: 16,
      max: 22,
      periodSeconds: 60
    },
    {
      id: "fan-speed",
      name: "Simulated fan speed",
      unit: "unit:PERCENT",
      waveform: "ramp",
      min: 0,
      max: 100,
      periodSeconds: 30
    }
  ]
} as const

export type InitDevice = typeof simulatedDevice | ReturnType<typeof draftDevices>[number] | PointsListDevice

export type DeviceSource = "simulated" | "discover" | "list" | "none"

export interface InitAnswers {
  readonly site: string
  readonly building: string
  readonly brokerUrl: string
  /** With it, the password comes from the env variable `passwordEnv`, never from the file. */
  readonly login?: { readonly username: string; readonly passwordEnv: string } | undefined
  readonly broadcastAddress?: string | undefined
}

/**
 * Answers given on the command line, for scripts and AI agents: each one skips its question, and with `yes` the
 * questions left take their defaults, so init asks nothing at all.
 */
export interface InitFlags {
  readonly site?: string | undefined
  readonly building?: string | undefined
  readonly broker?: string | undefined
  readonly username?: string | undefined
  readonly passwordEnv?: string | undefined
  readonly devices?: DeviceSource | undefined
  /** A points list; implies `devices: "list"`. */
  readonly points?: string | undefined
  readonly broadcast?: string | undefined
  /** Take the defaults for every question not answered by a flag. */
  readonly yes?: boolean | undefined
  /** Replace an existing config without asking. */
  readonly force?: boolean | undefined
  /** Work out the config, but write nothing. */
  readonly dryRun?: boolean | undefined
}

/** A flag's value that its question would not accept, or a config in the way without `--force`. */
export class InitError extends Schema.TaggedError<InitError>()("InitError", { message: Schema.String }) {}

/** The config for the answers and devices, in the file's own shape. */
export const initConfig = (answers: InitAnswers, devices: ReadonlyArray<InitDevice>) => ({
  site: answers.site,
  building: answers.building,
  mqtt: {
    url: answers.brokerUrl,
    clientId: `ot-gateway-${answers.site}-${answers.building}`,
    ...(answers.login === undefined ? {} : { username: answers.login.username, passwordEnv: answers.login.passwordEnv })
  },
  buffer: { path: "./ot-gateway-buffer.sqlite" },
  status: {},
  ...(answers.broadcastAddress === undefined ? {} : { bacnet: { broadcastAddress: answers.broadcastAddress } }),
  devices
})

/** An IPv4 interface on a LAN, and the broadcast address of its subnet. */
export interface LanInterface {
  readonly name: string
  readonly address: string
  readonly broadcast: string
}

const toNumber = (address: string) => address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0)
const toAddress = (value: number) => [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".")

/** Every IPv4 LAN interface with its subnet's broadcast address (loopback and point-to-point links left out). */
export const lanInterfaces = (
  interfaces: Readonly<Record<string, ReadonlyArray<NetworkInterfaceInfo> | undefined>>
): ReadonlyArray<LanInterface> =>
  Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses ?? []).flatMap((info) => {
      if (info.family !== "IPv4" || info.internal || info.netmask === "255.255.255.255") return []
      // A contiguous netmask: the subnet holds `size` addresses, and the broadcast is its last.
      const size = 2 ** 32 - toNumber(info.netmask)
      const broadcast = toAddress(Math.floor(toNumber(info.address) / size) * size + size - 1)
      return [{ name, address: info.address, broadcast }]
    })
  )

const slugMessage = "lowercase letters, digits, - and _, starting with a letter or digit (vienna-hq, not Vienna HQ)"

const validSlug = (value: string) => (Schema.is(Slug)(value) ? Effect.succeed(value) : Effect.fail(slugMessage))

const validBrokerUrl = (value: string) =>
  parseBrokerUrl(value).pipe(
    Effect.as(value),
    Effect.catchTag("MqttSettingsError", (error) => Effect.fail(error.message))
  )

const validEnvName = (value: string) =>
  /^[A-Z_][A-Z0-9_]*$/.test(value) ? Effect.succeed(value) : Effect.fail("upper case, digits and _")

/**
 * One answer: the flag's value when given (checked as the question would check it), the default with `--yes`,
 * otherwise the question.
 */
const answer = <A extends string>(
  flag: string,
  given: A | undefined,
  yes: boolean,
  fallback: A,
  ask: Effect.Effect<A, Terminal.QuitError, Prompt.Environment>,
  validate: (value: string) => Effect.Effect<string, string> = Effect.succeed
) => {
  if (given !== undefined) {
    return validate(given).pipe(
      Effect.as(given),
      Effect.mapError((issue) => new InitError({ message: `--${flag} ${given}: ${issue}` }))
    )
  }
  return yes ? Effect.succeed(fallback) : ask
}

const slug = (flag: string, given: string | undefined, yes: boolean, message: string, fallback: string) =>
  answer(flag, given, yes, fallback, Prompt.String({ message, default: fallback, validate: validSlug }), validSlug)

const brokerUrl = (flags: InitFlags) =>
  answer(
    "broker",
    flags.broker,
    flags.yes === true,
    "mqtt://localhost:1883",
    Prompt.String({
      message: "MQTT broker URL (mqtts:// for TLS)",
      default: "mqtt://localhost:1883",
      validate: validBrokerUrl
    }),
    validBrokerUrl
  )

const login = Effect.fn("login")(function* (flags: InitFlags) {
  const yes = flags.yes === true
  const username = yield* answer(
    "username",
    flags.username,
    yes || flags.passwordEnv !== undefined,
    "",
    Prompt.String({ message: "Broker username (empty for none)", default: "" })
  )
  if (username === "") {
    if (flags.passwordEnv !== undefined) return yield* new InitError({ message: "--password-env needs --username" })
    return undefined
  }
  const passwordEnv = yield* answer(
    "password-env",
    flags.passwordEnv,
    yes || flags.username !== undefined,
    "MQTT_PASSWORD",
    Prompt.String({
      message: "Env variable that will hold the password (it is never written to the config)",
      default: "MQTT_PASSWORD",
      validate: validEnvName
    }),
    validEnvName
  )
  return { username, passwordEnv }
})

const deviceSource = Prompt.Select<DeviceSource>({
  message: "Devices",
  choices: [
    { title: "A simulated device", value: "simulated", description: "to see values flow first; replace it later" },
    { title: "Find BACnet devices now", value: "discover", description: "Who-Is on the LAN, read-only" },
    {
      title: "From a points list",
      value: "list",
      description: "a CSV of devices and points, e.g. exported from Excel"
    },
    { title: "None yet", value: "none", description: "add Modbus or BACnet devices to the file later" }
  ]
})

/**
 * Where Who-Is goes: the flag's address, the only LAN's broadcast address, or the one picked from several (the
 * first with `--yes`, said on stderr).
 */
const broadcastAddress = (lans: ReadonlyArray<LanInterface>, flags: InitFlags) => {
  const [only] = lans
  if (flags.broadcast !== undefined) return Effect.succeed(flags.broadcast)
  if (lans.length <= 1) return Effect.succeed(only?.broadcast ?? "255.255.255.255")
  if (flags.yes === true && only !== undefined) {
    return Console.error(`  Who-Is on ${only.name} (${only.broadcast}); --broadcast picks another network`).pipe(
      Effect.as(only.broadcast)
    )
  }
  return Prompt.Select({
    message: "Which network are the BACnet devices on?",
    choices: lans.map((lan) => ({ title: `${lan.name} ${lan.address}`, value: lan.broadcast }))
  })
}

const retry = (message: string) =>
  Console.error(`  ${message}`).pipe(Effect.andThen(Effect.suspend(() => devicesFromList)))

/** Asks for a points list until one reads without a mistake; each mistake is shown with its line. */
const devicesFromList: Effect.Effect<
  ReadonlyArray<PointsListDevice>,
  Terminal.QuitError,
  Prompt.Environment
> = Effect.gen(function* () {
  const path = yield* Prompt.String({ message: "Points list (CSV, see docs/first-building.md)", default: "points.csv" })
  return yield* devicesFromFile(path).pipe(
    Effect.tap((devices) => Console.error(`  ${devices.length} device(s) from ${path}, none writable`)),
    Effect.catchTags({
      PointsListError: (error) => retry(error.message),
      ProfileError: (error) => retry(error.message),
      PlatformError: (error) => retry(error.message)
    })
  )
})

/** The devices of the points list a flag named: a mistake ends init, there being nobody to ask again. */
const devicesFromFlag = (path: string) =>
  devicesFromFile(path).pipe(
    Effect.tap((devices) => Console.error(`  ${devices.length} device(s) from ${path}, none writable`)),
    Effect.mapError((error) => new InitError({ message: `--points ${path}: ${error.message}` }))
  )

/** The devices for the chosen source; discovery runs with the answers so far. */
const devicesFrom = Effect.fn("devicesFrom")(function* (source: DeviceSource, answers: InitAnswers, flags: InitFlags) {
  if (source === "none") return []
  if (source === "simulated") return [simulatedDevice]
  if (source === "list") return yield* flags.points === undefined ? devicesFromList : devicesFromFlag(flags.points)
  const probe = yield* Schema.decodeUnknownEffect(GatewayConfig)(initConfig(answers, []))
  const drafts = yield* discoverDrafts(probe)
  // A device needs a point: one without (no readable objects, or more than one address answered) is left out.
  const usable = drafts.filter((draft) => draft.points.length > 0)
  const skipped = drafts.filter((draft) => draft.points.length === 0).map((draft) => draft.id)
  if (skipped.length > 0) {
    yield* Console.error(`  left out, no points to read: ${skipped.join(", ")} (add them by hand once you know why)`)
  }
  if (usable.length > 0) {
    yield* Console.error(`  ${usable.length} device(s) drafted, none writable: review their points before run`)
  }
  return usable
})

/**
 * Asks the questions and writes the config to `path` (not on a dry run). Returns the config, or `undefined`
 * when the operator kept an existing file.
 */
export const runInit = Effect.fn("runInit")(function* (path: string, flags: InitFlags = {}) {
  const fs = yield* FileSystem.FileSystem
  const yes = flags.yes === true
  if (flags.points !== undefined && flags.devices !== undefined && flags.devices !== "list") {
    return yield* new InitError({ message: `--points reads devices from a list; leave out --devices ${flags.devices}` })
  }
  if ((yield* fs.exists(path)) && flags.force !== true) {
    if (yes) return yield* new InitError({ message: `${path} exists; --force replaces it` })
    const replace = yield* Prompt.Confirm({ message: `${path} exists. Replace it?`, initial: false })
    if (!replace) return undefined
  }
  const site = yield* slug("site", flags.site, yes, "Site (the first topic segment)", "my-site")
  const building = yield* slug("building", flags.building, yes, "Building (the second)", "main")
  const answers: InitAnswers = { site, building, brokerUrl: yield* brokerUrl(flags), login: yield* login(flags) }
  const source: DeviceSource =
    flags.points === undefined ? (flags.devices ?? (yes ? "simulated" : yield* deviceSource)) : "list"
  const withNetwork =
    source === "discover"
      ? { ...answers, broadcastAddress: yield* broadcastAddress(lanInterfaces(networkInterfaces()), flags) }
      : answers
  const text = `${JSON.stringify(initConfig(withNetwork, yield* devicesFrom(source, withNetwork, flags)), null, 2)}\n`
  const config = yield* parseConfig(text)
  if (flags.dryRun === true) return config
  // Made only now, so a cancelled init leaves no empty folder behind.
  yield* fs.makeDirectory(dirname(path), { recursive: true })
  yield* fs.writeFileString(path, text)
  return config
})

/** The folder `init` creates when it is given none and asks nothing, as create-next-app's `my-app`. */
export const defaultFolder = "ot-gateway"

/**
 * Where init writes, from its argument, as create-next-app takes one: a folder (`.` for this one), created when
 * missing; nothing, which asks for the folder (or takes `ot-gateway` with `--yes`); or, as before folders, a
 * path ending in `.json`, which is the config itself.
 */
/** Whether init may ask: not with --yes, and not without a terminal on stdin (an AI agent, a script, CI). */
export const isInteractive = (yes: boolean, stdinIsTTY: boolean | undefined) => !yes && stdinIsTTY === true

export const initTarget = Effect.fn("initTarget")(function* (argument: string | undefined, yes: boolean) {
  if (argument?.endsWith(".json") === true) return argument
  const folder =
    argument ??
    (yes
      ? defaultFolder
      : yield* Prompt.String({ message: "Folder for this gateway (. for this one)", default: defaultFolder }))
  return join(folder, folderConfigName)
})

/** What to do after `init`, for the config it wrote to `path`. */
export const nextSteps = (path: string, config: GatewayConfig, folder: FolderFiles = { written: [], kept: [] }) => {
  const passwordEnv = config.mqtt.passwordEnv
  const envFile = [...folder.written, ...folder.kept].find((file) => file.endsWith("ot-gateway.env"))
  const compose =
    folder.noCompose === undefined && [...folder.written, ...folder.kept].some((file) => file.endsWith("compose.yaml"))
  const port = config.status?.port ?? 8080
  const password =
    passwordEnv === undefined
      ? []
      : envFile === undefined
        ? [`  set ${passwordEnv} to the broker password before you start the gateway`]
        : [`  put the broker password after ${passwordEnv}= in ${envFile}`]
  // Commands run from the gateway's folder, where the config's default name needs no argument.
  const folderPath = dirname(path)
  const name = basename(path)
  const argument = name === folderConfigName ? "" : ` ${name}`
  const commands: ReadonlyArray<readonly [string, string]> = [
    ...(folderPath === "." ? [] : ([[`cd ${folderPath}`, "the gateway's folder"]] as const)),
    ...(compose
      ? ([
          ["docker compose up -d", "start it in Docker, restarted after a crash or a reboot"],
          ["ot-gateway status", `one line per device (status page on http://127.0.0.1:${port})`]
        ] as const)
      : ([[`ot-gateway run${argument}`, `start the gateway (status page on http://127.0.0.1:${port})`]] as const)),
    [`ot-gateway check${argument}`, "validate it again after an edit"],
    [`ot-gateway watch${argument}`, `see what arrives at ${config.mqtt.url}`]
  ]
  const width = Math.max(...commands.map(([command]) => command.length)) + 2
  return [
    ...folder.written.map((file) => `wrote ${file}`),
    ...folder.kept.map((file) => `kept ${file} as it is`),
    ...(folder.noCompose === undefined ? [] : [`no compose.yaml: ${folder.noCompose}`]),
    ...password,
    ...(config.devices.length === 0 ? ["  add your devices under devices (docs/configuration.md)"] : []),
    "next:",
    ...commands.map(([command, what]) => `  ${command.padEnd(width)}${what}`)
  ].join("\n")
}
