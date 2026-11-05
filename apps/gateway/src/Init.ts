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
import { discoverDrafts, type draftDevices } from "./Discover.ts"
import { readPointsList } from "./Import.ts"
import { devicesFromPointsList, type PointsListDevice } from "./PointsList.ts"

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

const slug = (message: string, fallback: string) =>
  Prompt.String({
    message,
    default: fallback,
    validate: (value) => (Schema.is(Slug)(value) ? Effect.succeed(value) : Effect.fail(slugMessage))
  })

const brokerUrl = Prompt.String({
  message: "MQTT broker URL (mqtts:// for TLS)",
  default: "mqtt://localhost:1883",
  validate: (value) =>
    parseBrokerUrl(value).pipe(
      Effect.as(value),
      Effect.catchTag("MqttSettingsError", (error) => Effect.fail(error.message))
    )
})

const login = Effect.gen(function* () {
  const username = yield* Prompt.String({ message: "Broker username (empty for none)", default: "" })
  if (username === "") return undefined
  const passwordEnv = yield* Prompt.String({
    message: "Env variable that will hold the password (it is never written to the config)",
    default: "MQTT_PASSWORD",
    validate: (value) =>
      /^[A-Z_][A-Z0-9_]*$/.test(value) ? Effect.succeed(value) : Effect.fail("upper case, digits and _")
  })
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

/** Where Who-Is goes: the only LAN's broadcast address, or the one picked from several. */
const broadcastAddress = (lans: ReadonlyArray<LanInterface>) => {
  const [only] = lans
  if (lans.length <= 1) return Effect.succeed(only?.broadcast ?? "255.255.255.255")
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
  return yield* readPointsList(path).pipe(
    Effect.flatMap((text) => devicesFromPointsList(text)),
    Effect.tap((devices) => Console.error(`  ${devices.length} device(s) from ${path}, none writable`)),
    Effect.catchTags({
      PointsListError: (error) => retry(error.message),
      PlatformError: (error) => retry(error.message)
    })
  )
})

/** The devices for the chosen source; discovery runs with the answers so far. */
const devicesFrom = Effect.fn("devicesFrom")(function* (source: DeviceSource, answers: InitAnswers) {
  if (source === "none") return []
  if (source === "simulated") return [simulatedDevice]
  if (source === "list") return yield* devicesFromList
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
 * Asks the questions and writes the config to `path`. Returns the config written, or `undefined` when the
 * operator kept an existing file.
 */
export const runInit = Effect.fn("runInit")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  if (yield* fs.exists(path)) {
    const replace = yield* Prompt.Confirm({ message: `${path} exists. Replace it?`, initial: false })
    if (!replace) return undefined
  }
  const site = yield* slug("Site (the first topic segment)", "my-site")
  const building = yield* slug("Building (the second)", "main")
  const answers: InitAnswers = { site, building, brokerUrl: yield* brokerUrl, login: yield* login }
  const source = yield* deviceSource
  const withNetwork =
    source === "discover"
      ? { ...answers, broadcastAddress: yield* broadcastAddress(lanInterfaces(networkInterfaces())) }
      : answers
  const text = `${JSON.stringify(initConfig(withNetwork, yield* devicesFrom(source, withNetwork)), null, 2)}\n`
  const config = yield* parseConfig(text)
  yield* fs.writeFileString(path, text)
  return config
})

/** What to do after `init`, for the config it wrote to `path`. */
export const nextSteps = (path: string, config: GatewayConfig) => {
  const passwordEnv = config.mqtt.passwordEnv
  return [
    `wrote ${path}`,
    ...(passwordEnv === undefined ? [] : [`  set ${passwordEnv} to the broker password before you start the gateway`]),
    ...(config.devices.length === 0 ? ["  add your devices under devices (docs/configuration.md)"] : []),
    "next:",
    `  ot-gateway check ${path}    validate it again after an edit`,
    `  ot-gateway run ${path}      start the gateway (status page on http://127.0.0.1:${config.status?.port ?? 8080})`,
    `  ot-gateway watch ${path}    see what arrives at ${config.mqtt.url}`
  ].join("\n")
}
