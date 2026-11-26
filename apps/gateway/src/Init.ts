/**
 * `ot-gateway init`: a few questions, then a config that `check` accepts. A person answers the broker, the site and
 * the building, and adds devices next with `discover`, which runs `discoverInteractively` below: Who-Is, the points
 * to keep and the writable setpoints, and when nobody answers, the other ways (one device by its address, a Modbus
 * TCP scan of a range, a points list, the simulated device). Scripts give init its devices as flags: a points list,
 * the simulated device, or `--devices discover` (drafted read-only).
 *
 * The answers become the config in `initConfig`, a pure function, and the result is decoded with the gateway's
 * own schema before anything is written, so `init` never leaves a config that `run` refuses. An existing file
 * is only replaced after a yes.
 */
import { bacnetValueKind, GatewayConfig, parseConfig, Slug } from "@ot-gateway/core"
import { parseBrokerUrl } from "@ot-gateway/mqtt"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Console, Effect, FileSystem, Result, Schema, type Terminal } from "effect"
import { Prompt } from "effect/cli"
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { discoverDrafts, type draftDevices, printable } from "./Discover.ts"
import { parseDeviceAddress } from "@ot-gateway/bacnet"
import { folderConfigName, type FolderFiles } from "./Folder.ts"
import { devicesFromFile } from "./Import.ts"
import { shellArgument } from "./Output.ts"
import {
  foundUnits,
  formatScan,
  MODBUS_PORT,
  modbusDraftPointsList,
  modbusRangeHint,
  parseRange,
  scanModbus
} from "./ModbusDiscover.ts"
import { devicesFromPointsList, type PointsListDevice, PointsListIssue } from "./PointsList.ts"

/** A simulated device with two points, to see values flow before any real device is connected. */
export const simulatedDevice = {
  protocol: "simulator",
  id: "sim-1",
  pollIntervalMs: 2000,
  points: [
    {
      id: "flow-temp",
      name: "Simulated flow temperature",
      unit: "unit:DEG_C",
      deadband: 0.2,
      waveform: "sine",
      min: 30,
      max: 38,
      periodSeconds: 60
    },
    {
      id: "power",
      name: "Simulated power",
      unit: "unit:KiloW",
      waveform: "ramp",
      min: 0,
      max: 8,
      periodSeconds: 30
    }
  ]
} as const

/** A device as discovery drafts it, every point read-only. */
export type DraftedDevice = ReturnType<typeof draftDevices>[number]

/** A drafted point the operator let MQTT commands write, within `limits` unless it is binary. */
type DraftedPoint = DraftedDevice["points"][number]
type PickedPoint = DraftedPoint & {
  readonly writable?: true
  readonly limits?: { readonly min: number; readonly max: number }
}

/** A drafted device with the points the operator picked, some of them writable. */
export type PickedDevice = Omit<DraftedDevice, "points"> & {
  readonly points: ReadonlyArray<PickedPoint>
  /** How often its points are read where the device does not send changes itself; the config's default without. */
  readonly pollIntervalMs?: number
}

export type InitDevice = typeof simulatedDevice | PickedDevice | PointsListDevice

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
  /** `false` leaves the history out of the config (`--no-history`). */
  readonly history?: boolean | undefined
  /** The status page's port, when 8080 is taken (`--status-port`). */
  readonly statusPort?: number | undefined
}

/**
 * A flag's value that its question would not accept, a config in the way without `--force`, or a points list with
 * mistakes, whose `issues` are those mistakes one by one, as `import --json` gives them.
 */
export class InitError extends Schema.TaggedError<InitError>()("InitError", {
  message: Schema.String,
  issues: Schema.optionalKey(Schema.Array(PointsListIssue))
}) {}

/**
 * The config for the answers and devices, in the file's own shape. The outbox and the history are files next to
 * the config (LoadConfig.ts resolves them there; the container image, in its data volume). The history is on
 * unless `history` is `false`, so the status page has charts from the first run.
 */
export const initConfig = (
  answers: InitAnswers,
  devices: ReadonlyArray<InitDevice>,
  options: { readonly history?: boolean | undefined; readonly statusPort?: number | undefined } = {}
) => ({
  site: answers.site,
  building: answers.building,
  mqtt: {
    url: answers.brokerUrl,
    clientId: `ot-gateway-${answers.site}-${answers.building}`,
    ...(answers.login === undefined ? {} : { username: answers.login.username, passwordEnv: answers.login.passwordEnv })
  },
  buffer: { path: "./ot-gateway-buffer.sqlite" },
  ...(options.history === false ? {} : { history: { path: "./ot-gateway-history.sqlite" } }),
  status: options.statusPort === undefined ? {} : { port: options.statusPort },
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

const slugMessage = "lowercase letters, digits, - and _, starting with a letter or digit (site-1, not Site 1)"

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

/** Whether a broker answers on localhost:1883, so the broker question can say so; at most a second. */
export const localBrokerAnswers = NodeSocket.makeNet({ host: "localhost", port: 1883, openTimeout: "1 second" }).pipe(
  Effect.flatMap((socket) => socket.reader),
  Effect.scoped,
  Effect.as(true),
  Effect.catchTag("SocketError", () => Effect.succeed(false)),
  Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed(false) })
)

/** The broker question: whether something answers on localhost:1883 says if the default is a good one. */
export const brokerQuestion = (localAnswers: boolean) =>
  localAnswers
    ? "MQTT broker URL (one answers on localhost:1883)"
    : "MQTT broker URL (nothing answers on localhost:1883 yet; mqtts:// for TLS)"

const brokerUrl = Effect.fn("brokerUrl")(function* (flags: InitFlags, localBroker: Effect.Effect<boolean>) {
  const asks = flags.broker === undefined && flags.yes !== true
  return yield* answer(
    "broker",
    flags.broker,
    flags.yes === true,
    "mqtt://localhost:1883",
    Prompt.String({
      message: brokerQuestion(asks && (yield* localBroker)),
      default: "mqtt://localhost:1883",
      validate: validBrokerUrl
    }),
    validBrokerUrl
  )
})

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

/**
 * Where Who-Is goes: the flag's address, the only LAN's broadcast address, or the one picked from several (the
 * first with `--yes`, said on stderr).
 */
export const broadcastAddress = (lans: ReadonlyArray<LanInterface>, flags: InitFlags) => {
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

/** A points list's failure under the flag that named it; several mistakes start on a line of their own. */
const pointsFlagMessage = (path: string, message: string) =>
  `--points ${path}:${message.includes("\n") ? "\n" : " "}${message}`

/** The devices of the points list a flag named: a mistake ends init, there being nobody to ask again. */
const devicesFromFlag = (path: string) =>
  devicesFromFile(path).pipe(
    Effect.tap((devices) => Console.error(`  ${devices.length} device(s) from ${path}, none writable`)),
    Effect.catchTags({
      PointsListError: (error) =>
        Effect.fail(
          new InitError({
            message: pointsFlagMessage(path, error.message),
            ...(error.issues === undefined ? {} : { issues: error.issues })
          })
        ),
      ProfileError: (error) => Effect.fail(new InitError({ message: pointsFlagMessage(path, error.message) })),
      PlatformError: (error) => Effect.fail(new InitError({ message: pointsFlagMessage(path, error.message) }))
    })
  )

/** A drafted point's key in the pickers: its device and its id, both slugs, so `/` cannot be in either. */
const pointKey = (device: { readonly id: string }, point: { readonly id: string }) => `${device.id}/${point.id}`

/**
 * The BACnet object types whose present value is commandable (ASHRAE 135, clause 19.2): outputs and values, never
 * inputs. Only these are offered as writable.
 */
const commandableTypes = new Set([
  "analog-output",
  "analog-value",
  "binary-output",
  "binary-value",
  "multi-state-output",
  "multi-state-value"
])

/** What the point pickers list for a drafted point: the device, the name, the object and the unit. */
const pointTitle = (device: { readonly id: string }, point: DraftedPoint) =>
  `${device.id}: ${printable(point.name)} (${point.objectType} ${point.instance}${point.unit === undefined ? "" : `, ${point.unit.replace(/^unit:/, "")}`})`

/** Every drafted point, ticked: the operator unticks what the gateway should not read. */
export const pointChoices = (drafts: ReadonlyArray<DraftedDevice>) =>
  drafts.flatMap((device) =>
    device.points.map((point) => ({
      title: pointTitle(device, point),
      value: pointKey(device, point),
      selected: true
    }))
  )

/**
 * The picked points that commands could write, none ticked: a write is the operator's decision. Setpoints come
 * first, as the points most often written.
 */
export const writableChoices = (drafts: ReadonlyArray<PickedDevice>) =>
  drafts
    .flatMap((device) =>
      device.points
        .filter((point) => commandableTypes.has(point.objectType))
        .map((point) => ({
          title: pointTitle(device, point),
          value: pointKey(device, point),
          selected: false,
          setpoint: isSetpoint(point.name)
        }))
    )
    .toSorted((a, b) => Number(b.setpoint) - Number(a.setpoint))
    .map(({ title, value, selected }) => ({ title, value, selected }))

const isSetpoint = (title: string) => /set ?point|sollwert|\bsp\b/i.test(title)

/** The drafts with only the `picked` points; a device left with none is dropped. */
export const keepPicked = (drafts: ReadonlyArray<DraftedDevice>, picked: ReadonlyArray<string>) => {
  const keep = new Set(picked)
  return drafts.flatMap((device) => {
    const points = device.points.filter((point) => keep.has(pointKey(device, point)))
    return points.length === 0 ? [] : [{ ...device, points }]
  })
}

/**
 * The drafts with each point in `writable` made writable, with its limits; a binary point takes no limits (it is
 * written on or off).
 */
export const makeWritable = (
  drafts: ReadonlyArray<PickedDevice>,
  writable: ReadonlyMap<string, { readonly min: number; readonly max: number } | undefined>
): ReadonlyArray<PickedDevice> =>
  drafts.map((device) => ({
    ...device,
    points: device.points.map((point) => {
      const key = pointKey(device, point)
      if (!writable.has(key)) return point
      const limits = writable.get(key)
      return { ...point, writable: true as const, ...(limits === undefined ? {} : { limits }) }
    })
  }))

/** Limits to suggest for a writable point by its unit (a room setpoint in °C, a valve in %), when there is a usual range. */
export const suggestedLimits = (unit: string | undefined): { readonly min: number; readonly max: number } | undefined =>
  unit === undefined ? undefined : usualRanges[unit]

const usualRanges: Readonly<Record<string, { readonly min: number; readonly max: number }>> = {
  "unit:DEG_C": { min: 15, max: 30 },
  "unit:DEG_F": { min: 59, max: 86 },
  "unit:PERCENT": { min: 0, max: 100 }
}

/** Asks the limits of one writable numeric point: min, then max from min up. */
const askLimits = Effect.fn("askLimits")(function* (title: string, unit: string | undefined) {
  const suggested = suggestedLimits(unit)
  yield* Console.error(`  ${title}: commands outside these limits are refused`)
  const min = yield* Prompt.Number({
    message: "  lowest value a command may set",
    ...(suggested === undefined ? {} : { default: suggested.min })
  })
  const max = yield* Prompt.Number({
    message: "  highest value a command may set",
    min,
    ...(suggested === undefined || suggested.max < min ? {} : { default: suggested.max })
  })
  return { min, max }
})

/** The read interval init suggests, the config's default (`pollIntervalMs` 5000). */
const defaultIntervalSeconds = 5

/** The devices read every `seconds`; the config's default is left out rather than written. */
export const withInterval = (devices: ReadonlyArray<PickedDevice>, seconds: number): ReadonlyArray<PickedDevice> =>
  seconds === defaultIntervalSeconds
    ? devices
    : devices.map((device) => ({ ...device, pollIntervalMs: Math.round(seconds * 1000) }))

/** Up to this many points found, init lets the operator tick which to read. */
export const maxPointsToPick = 25

/** Asks which drafted points to read and which of them commands may write (with their limits). */
const pickPoints = Effect.fn("pickPoints")(function* (drafts: ReadonlyArray<DraftedDevice>) {
  const choices = pointChoices(drafts)
  // A list to tick through stays short; past that, every point is read and trimmed where the whole list shows.
  const kept =
    choices.length > maxPointsToPick
      ? yield* Console.error(
          `  ${choices.length} points found, all of them read: leave out the ones you don't need later, on the status page or in ot-gateway.json`
        ).pipe(Effect.as(drafts))
      : keepPicked(
          drafts,
          yield* Prompt.MultiSelect({
            message: `Points to read (${choices.length} found; space toggles, enter confirms, none for other ways)`,
            choices,
            maxPerPage: 15
          })
        )
  if (kept.length === 0) return undefined
  const interval = yield* Prompt.Number({
    message: "Read every how many seconds? (where a device does not send changes itself)",
    default: defaultIntervalSeconds,
    min: 0.1,
    max: 86_400
  })
  const timed = withInterval(kept, interval)
  const candidates = writableChoices(timed)
  if (candidates.length === 0) return timed
  const chosen = yield* Prompt.MultiSelect({
    message: "Which may MQTT commands write? (none by default; every write is checked and logged)",
    choices: candidates,
    maxPerPage: 15
  })
  const points = new Map(kept.flatMap((device) => device.points.map((point) => [pointKey(device, point), point])))
  const writable = new Map<string, { readonly min: number; readonly max: number } | undefined>()
  for (const key of chosen) {
    const point = points.get(key)
    if (point === undefined) continue
    const binary = bacnetValueKind({ objectType: point.objectType, property: "present-value" }) === "binary"
    writable.set(key, binary ? undefined : yield* askLimits(printable(point.name), point.unit))
  }
  return makeWritable(timed, writable)
})

/** The other ways to devices, when no BACnet device answered Who-Is. */
type OtherWay = "again" | "address" | "modbus" | "list" | "simulated" | "none"

const otherWayChoices: ReadonlyArray<Prompt.SelectChoice<OtherWay>> = [
  {
    title: "Ask one device by its address",
    value: "address",
    description: "ip or ip:port, for a device on another subnet or another port"
  },
  { title: "Search again", value: "again", description: "once the device is on and on this network" },
  {
    title: "Scan for Modbus TCP devices",
    value: "modbus",
    description: "ask a range of addresses on port 502, read-only, as discover modbus does"
  },
  {
    title: "From a points list",
    value: "list",
    description: "a CSV or JSON of devices and points (Modbus, or BACnet from an EDE file)"
  },
  { title: "A simulated device", value: "simulated", description: "to see values flow first; replace it later" },
  { title: "None yet", value: "none", description: "add devices later, on the status page" }
]

const otherWays = Prompt.Select<OtherWay>({ message: "No BACnet device answered. What now?", choices: otherWayChoices })

/** The other ways when a Modbus scan found nothing to read. */
const otherWaysAfterModbus = Prompt.Select<OtherWay>({
  message: "No Modbus device to read. What now?",
  choices: otherWayChoices
})

/** The other ways when the operator picked none of the points found. */
const otherWaysAfterPicking = Prompt.Select<OtherWay>({
  message: "No point picked. What now?",
  choices: otherWayChoices
})

/** The /24 of the first LAN this machine is on, to scan for Modbus devices; a common one without a LAN. */
export const suggestedModbusRange = (lans: ReadonlyArray<LanInterface>) => {
  const [first] = lans
  return first === undefined ? "192.168.1.0/24" : `${first.address.split(".").slice(0, 3).join(".")}.0/24`
}

const validModbusRange = (value: string) => {
  const targets = parseRange(value)
  return Result.isSuccess(targets) ? Effect.succeed(value) : Effect.fail(`${targets.failure}; ${modbusRangeHint}`)
}

/**
 * The Modbus way to devices: scan a range (read-only, rate-limited, `discover modbus`), and draft each unit that
 * answered with a register as a device with that one placeholder point, to replace with the datasheet's registers.
 */
const devicesFromModbusScan = Effect.fn("devicesFromModbusScan")(function* (suggested: string) {
  const range = yield* Prompt.String({
    message: "Addresses to scan for Modbus TCP (a network, first-last, or one address)",
    default: suggested,
    validate: validModbusRange
  })
  const targets = parseRange(range)
  if (Result.isFailure(targets)) return []
  yield* Console.error(`  asking ${targets.success.length} address(es) on port ${MODBUS_PORT}, read-only`)
  const report = yield* scanModbus(
    { range, targets: targets.success },
    {
      onDone: (done, total) =>
        total >= 20 && (done === total || done % Math.ceil(total / 10) === 0)
          ? Console.error(`  ${done}/${total} addresses asked`)
          : Effect.void
    }
  )
  yield* Console.error(
    formatScan(report)
      .split("\n")
      .filter((line) => !line.startsWith("next:") && !line.startsWith("--points-list"))
      .map((line) => `  ${line}`.trimEnd())
      .join("\n")
  )
  const units = foundUnits(report)
  const readable = units.filter((unit) => unit.table !== undefined)
  if (readable.length < units.length) {
    yield* Console.error(
      `  ${units.length - readable.length} unit(s) left out, register 0 refused on both tables: draft them with ot-gateway discover modbus ${shellArgument(range)} --points-list modbus.csv and fill in their registers from the datasheet`
    )
  }
  if (readable.length === 0) return []
  const devices = yield* devicesFromPointsList(modbusDraftPointsList(readable)).pipe(
    Effect.catchTag("PointsListError", (error) => Console.error(`  ${error.message}`).pipe(Effect.as([])))
  )
  if (devices.length > 0) {
    yield* Console.error(
      `  ${devices.length} device(s) drafted, each with one placeholder point (register 0 as uint16): set their registers from the datasheet on the status page, or in a points list (ot-gateway probe <host> <register> shows how one reads)`
    )
  }
  return devices
})

const validDeviceAddress = (value: string) =>
  Result.isSuccess(parseDeviceAddress(value))
    ? Effect.succeed(value)
    : Effect.fail("ip or ip:port, e.g. 192.168.0.171 or 192.168.0.171:47810")

/**
 * Discovery for a person at the terminal, the first way to devices: Who-Is right away, then they pick the points
 * found. When nobody answers, discovery cannot run (another program holds UDP 47808), or they pick no point, the
 * other ways: one device by its address, again, a points list, the simulated device, or none yet.
 */
export const discoverInteractively = Effect.fn("discoverInteractively")(function* (
  probe: GatewayConfig,
  modbusRange: () => string,
  firstAddress?: string
) {
  let address: string | undefined = firstAddress
  let modbus = false
  while (true) {
    if (modbus) {
      modbus = false
      const devices = yield* devicesFromModbusScan(modbusRange())
      if (devices.length > 0) return devices
      const after = yield* otherWaysAfterModbus
      if (after === "modbus") {
        modbus = true
        continue
      }
      if (after === "simulated") return [simulatedDevice]
      if (after === "none") return []
      if (after === "list") return yield* devicesFromList
      address =
        after === "again"
          ? undefined
          : yield* Prompt.String({ message: "Device address (ip or ip:port)", validate: validDeviceAddress })
    }
    const drafts: ReadonlyArray<DraftedDevice> = yield* discoverDrafts(
      probe,
      undefined,
      address === undefined ? {} : { address }
    ).pipe(
      Effect.catchTag("DiscoverError", (error) =>
        Console.error(`  ${error.message}`).pipe(Effect.as<ReadonlyArray<DraftedDevice>>([]))
      )
    )
    const usable = drafts.filter((draft) => draft.points.length > 0)
    const picked = usable.length > 0 ? yield* pickPoints(usable) : undefined
    if (picked !== undefined) return picked
    const next = yield* usable.length > 0 ? otherWaysAfterPicking : otherWays
    if (next === "simulated") return [simulatedDevice]
    if (next === "none") return []
    if (next === "list") return yield* devicesFromList
    if (next === "modbus") {
      modbus = true
      continue
    }
    address =
      next === "again"
        ? undefined
        : yield* Prompt.String({ message: "Device address (ip or ip:port)", validate: validDeviceAddress })
  }
})

/** The devices for the chosen source; discovery asks through the network in `answers`. */
const devicesFrom = Effect.fn("devicesFrom")(function* (
  source: DeviceSource,
  answers: InitAnswers,
  flags: InitFlags,
  modbusRange: () => string
) {
  if (source === "none") return []
  if (source === "simulated") return [simulatedDevice]
  if (source === "list") return yield* flags.points === undefined ? devicesFromList : devicesFromFlag(flags.points)
  const probe = yield* Schema.decodeUnknownEffect(GatewayConfig)(initConfig(answers, []))
  if (flags.yes !== true) return yield* discoverInteractively(probe, modbusRange)
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
 * when the operator kept an existing file. `lans` lists the networks to choose from, read only when one is
 * needed: `--broadcast` is not given and BACnet devices are found by broadcast.
 */
export const runInit = Effect.fn("runInit")(function* (
  path: string,
  flags: InitFlags = {},
  lans: () => ReadonlyArray<LanInterface> = () => lanInterfaces(networkInterfaces()),
  localBroker: Effect.Effect<boolean> = localBrokerAnswers
) {
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
  // A wrong --site or --building fails now, before a discovery that would come to nothing.
  yield* slug("site", flags.site, true, "", "my-site")
  yield* slug("building", flags.building, true, "", "main")
  // As the work goes: where values go, which devices they come from, then the names their topics take.
  const broker = { brokerUrl: yield* brokerUrl(flags, localBroker), login: yield* login(flags) }
  // Discovery is the first way to devices for a person at the terminal; the others come when nobody answers.
  // init sets up the project; a person adds devices next, with discover. Scripts get the simulated device with --yes.
  const source: DeviceSource = flags.points === undefined ? (flags.devices ?? (yes ? "simulated" : "none")) : "list"
  // Discovery reads only the BACnet settings; the names come after it.
  const answers: InitAnswers = { site: "site", building: "building", ...broker }
  // Discovery needs the network before it can run; any other source has its devices first.
  const network = (answersSoFar: InitAnswers) =>
    broadcastAddress(lans(), flags).pipe(Effect.map((address) => ({ ...answersSoFar, broadcastAddress: address })))
  const beforeDevices =
    source === "discover" ? yield* network(answers) : { ...answers, broadcastAddress: flags.broadcast }
  const devices: ReadonlyArray<InitDevice> = yield* devicesFrom(source, beforeDevices, flags, () =>
    suggestedModbusRange(lans())
  )
  // A BACnet device without an address is found by broadcast at run time, so the list needs the right network too.
  const located = (device: InitDevice) => device.protocol !== "bacnet-ip" || "address" in device
  const networked =
    beforeDevices.broadcastAddress === undefined && !devices.every(located)
      ? yield* network(beforeDevices)
      : beforeDevices
  const site = yield* slug(
    "site",
    flags.site,
    yes,
    "Site (the first topic segment)",
    yes ? "my-site" : siteSuggestion(path)
  )
  const building = yield* slug("building", flags.building, yes, "Building (the second)", "main")
  const withNetwork = { ...networked, site, building }
  const text = `${JSON.stringify(initConfig(withNetwork, devices, { history: flags.history, statusPort: flags.statusPort }), null, 2)}\n`
  const config = yield* parseConfig(text)
  if (flags.dryRun === true) return config
  // Made only now, so a cancelled init leaves no empty folder behind.
  yield* fs.makeDirectory(dirname(path), { recursive: true })
  yield* fs.writeFileString(path, text)
  return config
})

/**
 * The site init suggests: the gateway folder's name when it is a slug other than the default folder's (`init
 * plant-3` suggests `plant-3`), otherwise `my-site`. `--yes` always takes `my-site`.
 */
export const siteSuggestion = (path: string) => {
  const folder = basename(resolve(dirname(path)))
  return Schema.is(Slug)(folder) && folder !== defaultFolder ? folder : "my-site"
}

/** The folder `init` creates when it is given none and asks nothing, as create-next-app's `my-app`. */
export const defaultFolder = "ot-gateway"

/** Whether init may ask: not with --yes, and not without a terminal on stdin (an AI agent, a script, CI). */
export const isInteractive = (yes: boolean, stdinIsTTY: boolean | undefined) => !yes && stdinIsTTY === true

/**
 * Where init writes, from its argument: a folder (`.` for this one), created when missing; or, as before folders, a
 * path ending in `.json`, which is the config itself. Without one, as create-next-app and create-cloudflare do with
 * an empty folder: this folder when it is empty (`here` says whether it is) and a person answers, otherwise the
 * folder asked for, or `ot-gateway` with `--yes` (scripts rely on where that is).
 */
export const initTarget = Effect.fn("initTarget")(function* (
  argument: string | undefined,
  yes: boolean,
  here: { readonly empty: boolean } = { empty: false }
) {
  if (argument?.endsWith(".json") === true) return argument
  if (argument === undefined && here.empty && !yes) {
    yield* Console.error("  this folder is empty, so the gateway's files go here")
    return folderConfigName
  }
  const folder =
    argument ??
    (yes
      ? defaultFolder
      : yield* Prompt.String({ message: "Folder for this gateway (. for this one)", default: defaultFolder }))
  return join(folder, folderConfigName)
})

/** Whether the working directory has nothing in it but hidden files (`.git`, `.DS_Store`): init then writes there. */
export const isEmptyFolder = (entries: ReadonlyArray<string>) => entries.every((entry) => entry.startsWith("."))

/**
 * The question init ends with when the gateway can start right away, or undefined when it cannot: no devices to
 * read yet, or a broker password whose variable is not set (it goes in ot-gateway.env first).
 */
export const startNowQuestion = (
  config: GatewayConfig,
  env: Readonly<Record<string, string | undefined>>
): string | undefined => {
  if (config.devices.length === 0) return undefined
  const passwordEnv = config.mqtt.passwordEnv
  if (passwordEnv !== undefined && (env[passwordEnv] ?? "") === "") return undefined
  return "Start the gateway now, in this terminal? (Ctrl-C stops it)"
}

/** The SSH session the CLI runs in, so next steps can say how to reach the status page from the other end. */
export interface SshSession {
  /** The address the client connected to, or undefined when the environment does not say. */
  readonly host: string | undefined
  readonly user: string | undefined
}

/** The variables `sshSession` reads; the Docker wrapper passes them into the container. */
export interface SshEnvironment {
  readonly SSH_CONNECTION?: string | undefined
  readonly SSH_CLIENT?: string | undefined
  readonly USER?: string | undefined
  readonly LOGNAME?: string | undefined
}

/** Only what is safe in a printed command line: a host name or an address, a login name. */
const shellSafe = /^[\w.:%-]{1,253}$/

const safe = (value: string | undefined) =>
  value !== undefined && shellSafe.test(value) && !value.startsWith("-") ? value : undefined

/**
 * The SSH session from the environment, or undefined when the CLI does not run over SSH. `SSH_CONNECTION` is
 * "client-address client-port server-address server-port"; `SSH_CLIENT` has no server address.
 */
export const sshSession = (env: SshEnvironment): SshSession | undefined => {
  const connection = env.SSH_CONNECTION?.trim()
  const client = env.SSH_CLIENT?.trim()
  if ((connection === undefined || connection === "") && (client === undefined || client === "")) return undefined
  const host = safe(connection?.split(/\s+/)[2])
  const user = safe(env.USER) ?? safe(env.LOGNAME)
  return { host, user }
}

/** The tunnel that opens a status page on `port` from the laptop the SSH session came from, as localhost:8080. */
export const sshTunnel = (session: SshSession, port: number): NextStep => ({
  command: `ssh -L 8080:127.0.0.1:${port} ${session.user ?? "<user>"}@${session.host ?? "<host>"}`,
  description: "on your laptop, then open http://localhost:8080 for the status page"
})

/** One thing to do after `init`: a command and what it is for. */
export interface NextStep {
  readonly command: string
  readonly description: string
}

const step = (command: string, description: string): NextStep => ({ command, description })

/**
 * What `init` prints after the config: the files, notes, the next commands, and the status page, as text and in
 * `--json`. The status page is not a command, so it is not in `next`: `url` is its address and `page` the sentence
 * that says what to do there, which the text prints after the command that starts the gateway (`startedBy`).
 */
export interface InitNext {
  readonly notes: ReadonlyArray<string>
  readonly next: ReadonlyArray<NextStep>
  readonly url: string
  readonly page: string
  /** How many of `next` come before the status page: up to the command that starts the gateway. */
  readonly startedBy: number
  /** The command that starts the gateway in the foreground, `ot-gateway run` with the config when it needs naming. */
  readonly run: string
  /** The command that starts it in Docker, when compose.yaml is the way here. */
  readonly compose?: string | undefined
}

/** Where `init` runs, for its next steps: over SSH or not, the operating system, the working directory. */
export interface InitContext {
  /** Adds the tunnel to the status page. */
  readonly ssh?: SshSession | undefined
  /** `process.platform`; on macOS and Windows, Docker Desktop cannot reach the building network (`dockerDesktopNote`). */
  readonly platform?: string | undefined
  /** The working directory the commands run from; the process's when undefined. */
  readonly cwd?: string | undefined
  /** How the CLI was run (`cliCommand`): `pnpm ot-gateway` in a checkout; `ot-gateway` when undefined. */
  readonly command?: string | undefined
}

/**
 * Why `compose.yaml` is not the way to run the gateway on macOS and Windows: Docker Desktop runs containers in a VM,
 * so host networking does not put the gateway on the building network and BACnet broadcasts never reach it.
 */
export const dockerDesktopNote =
  "Docker Desktop on macOS and Windows cannot reach devices on the LAN through host networking, and BACnet broadcasts do not reach its VM: run the gateway with ot-gateway run here, or use compose.yaml on a Linux machine"

/** Bytes per stored read and per point and minute of the history, measured on its SQLite tables. */
const historyBytesPerRead = 50
const historyBytesPerPointMinute = 70

/**
 * About how much disk the history of `config` takes once full: a day of every read plus `retentionDays` of
 * per-minute rows, each point read every `pollIntervalMs` (a BACnet point by change of value may notify more often).
 */
export const historyDiskBytes = (config: GatewayConfig) => {
  const retentionDays = config.history?.retentionDays ?? 7
  const points = config.devices.reduce((total, device) => total + device.points.length, 0)
  const readsPerDay = config.devices.reduce(
    (total, device) => total + (device.points.length * 86_400_000) / device.pollIntervalMs,
    0
  )
  return readsPerDay * historyBytesPerRead + points * 1440 * retentionDays * historyBytesPerPointMinute
}

const megabytes = (bytes: number) => (bytes < 1_000_000 ? "under 1 MB" : `about ${Math.round(bytes / 1_000_000)} MB`)

/** What the history costs on disk, for the notes after `init`; nothing when the config has none. */
export const historyNote = (config: GatewayConfig) => {
  if (config.history === undefined) return []
  const keeps = `the history keeps every read for a day and per-minute values for ${config.history.retentionDays} days for the status page's charts`
  const leaveOut = "--no-history leaves it out"
  if (config.devices.length === 0) {
    return [
      `${keeps}: about ${historyBytesPerRead} B per read and ${historyBytesPerPointMinute} B per point and minute on disk (100 points read every 10 s: about 115 MB); ${leaveOut}`
    ]
  }
  return [`${keeps}: ${megabytes(historyDiskBytes(config))} on disk for these points; ${leaveOut}`]
}

/**
 * What to do after `init`, for the config it wrote to `path`. Commands name the config when its folder is not the
 * working directory, so they work from where `init` ran (a checkout's root with `pnpm ot-gateway`) without a `cd`.
 */
export const initNext = (
  path: string,
  config: GatewayConfig,
  folder: FolderFiles = { written: [], kept: [] },
  context: InitContext = {}
): InitNext => {
  const { ssh, platform } = context
  const cli = context.command ?? "ot-gateway"
  const passwordEnv = config.mqtt.passwordEnv
  const envFile = [...folder.written, ...folder.kept].find((file) => file.endsWith("ot-gateway.env"))
  const compose =
    folder.noCompose === undefined && [...folder.written, ...folder.kept].some((file) => file.endsWith("compose.yaml"))
  const dockerDesktop = compose && (platform === "darwin" || platform === "win32")
  const port = config.status?.port ?? 8080
  const password =
    passwordEnv === undefined
      ? []
      : envFile === undefined
        ? [`set ${passwordEnv} to the broker password before you start the gateway`]
        : [`put the broker password after ${passwordEnv}= in ${envFile}`]
  const folderPath = dirname(path)
  const here = resolve(folderPath) === resolve(context.cwd ?? ".")
  // In the gateway's folder, the config's default name needs no argument; anywhere else every command names it.
  const argument = here
    ? basename(path) === folderConfigName
      ? ""
      : ` ${shellArgument(basename(path))}`
    : ` ${shellArgument(path)}`
  const inFolder = (file: string) => (here ? file : shellArgument(join(folderPath, file)))
  const pointsList = inFolder("points.csv")
  const manual = config.devices.length === 0
  const url = `http://127.0.0.1:${port}`
  const run = `${cli} run${argument}`
  const composeUp =
    compose && !dockerDesktop
      ? here
        ? "docker compose up -d"
        : `docker compose -f ${inFolder("compose.yaml")} up -d`
      : undefined
  const start =
    composeUp === undefined
      ? [step(run, "start the gateway")]
      : [
          step(composeUp, "start it in Docker, restarted after a crash or a reboot"),
          step(`${cli} status${argument}`, "one line per device")
        ]
  // As the work goes: the broker answers, the points go in and pass the check, then the gateway starts. A wrong URL,
  // port or password shows first, not later as a stale gateway.
  const points = manual
    ? [
        step(
          `${cli} points template > ${pointsList}`,
          "fill in a points list (discover --points-list drafts one for BACnet), or add devices on the status page instead"
        ),
        step(`${cli} import ${pointsList}${argument}`, "add its devices to the config")
      ]
    : []
  const before = [
    step(`${cli} broker${argument}`, `check that ${config.mqtt.url} answers, with a message there and back`),
    ...points,
    step(`${cli} check${argument}`, "validate the config without connecting, again after every edit"),
    ...start
  ]
  // Without devices, the status page is where they are added; a points list is the way from the terminal.
  const page = manual
    ? `then open ${url} for the status page, where devices can be added too (or a points list uploaded)`
    : `then open ${url} for the status page: devices, values, charts`
  const next = [
    ...before,
    // Over SSH, 127.0.0.1 is the gateway's machine, not the laptop with the browser.
    ...(ssh === undefined ? [] : [sshTunnel(ssh, port)]),
    // Bounded, so an agent that runs the line as printed gets its answer and its prompt back.
    step(`${cli} watch${argument} --seconds 10`, `ten seconds of what arrives at ${config.mqtt.url}`)
  ]
  return {
    notes: [...password, ...historyNote(config), ...(dockerDesktop ? [dockerDesktopNote] : [])],
    next,
    url,
    page: ssh === undefined ? page : `${page}; ${url} is this machine, so from your laptop use the tunnel below`,
    startedBy: before.length,
    run,
    compose: composeUp
  }
}

/** What a device of the config is, in a few words, for the summary a person reads. */
const deviceLine = (device: GatewayConfig["devices"][number]) => {
  const writable = device.points.filter((point) => point.writable).length
  const where = "address" in device && device.address !== undefined ? ` at ${device.address}` : ""
  const points = `${device.points.length} point${device.points.length === 1 ? "" : "s"}`
  return `${device.id}${where}: ${points}${writable === 0 ? "" : `, ${writable} writable`}`
}

/**
 * What init prints for a person at the terminal: a few lines to scan, what was written and found, and what is left
 * before it runs. The full account (every file, the history's disk, the next commands) is what scripts and agents
 * get, and `ot-gateway check` prints for a person too.
 */
export const initSummary = (
  path: string,
  config: GatewayConfig,
  folder: FolderFiles = { written: [], kept: [] },
  context: InitContext = {},
  env: Readonly<Record<string, string | undefined>> = {}
) => {
  const { run, url, compose } = initNext(path, config, folder, context)
  const cli = context.command ?? "ot-gateway"
  const files = folder.written.map((file) => basename(file))
  const passwordEnv = config.mqtt.passwordEnv
  const envFile = [...folder.written, ...folder.kept].find((file) => file.endsWith("ot-gateway.env"))
  const devices = config.devices.map((device) => `✓ ${deviceLine(device)}`)
  // The command with the config named as `run` names it: nothing in its folder, the path from elsewhere.
  const discover = `${cli} discover${run.slice(`${cli} run`.length)}`
  return {
    lines: [
      `✓ wrote ${files.join(", ")}${folder.written.length > 0 && dirname(path) !== "." ? ` in ${dirname(path)}` : ""}`,
      ...devices,
      ...(passwordEnv === undefined || (env[passwordEnv] ?? "") !== ""
        ? []
        : [`· put the broker password after ${passwordEnv}= in ${envFile ?? "the environment"} before you start`])
    ],
    /** Said when the gateway is not started now. */
    later:
      config.devices.length === 0
        ? [
            `next: ${discover}`,
            "      finds the BACnet devices on this network, lets you pick their points and saves them here",
            `      (Modbus TCP: it offers a scan of a range; a points list: ${cli} import points.csv)`
          ]
        : [
            `start it:     ${run}${compose === undefined ? "" : `   (or in Docker: ${compose})`}`,
            `read once:    ${cli} read${run.slice(`${cli} run`.length)}`,
            `status page:  ${url}`,
            `all commands: ${cli} --help`
          ]
  }
}

/**
 * Steps as text, each description on its own line under its command: an absolute path makes a command long, and
 * padding every command to the longest one pushes the descriptions off a terminal.
 */
const stepLines = (steps: ReadonlyArray<NextStep>) =>
  steps.flatMap(({ command, description }) => [`  ${command}`, `      ${description}`])

/** What to do after `init` as text, for the config it wrote to `path`. */
export const nextSteps = (
  path: string,
  config: GatewayConfig,
  folder: FolderFiles = { written: [], kept: [] },
  context: InitContext = {}
) => {
  const { notes, next, page, startedBy } = initNext(path, config, folder, context)
  return [
    ...folder.written.map((file) => `wrote ${file}`),
    ...folder.kept.map((file) => `kept ${file} as it is`),
    ...(folder.noCompose === undefined ? [] : [`no compose.yaml: ${folder.noCompose}`]),
    ...notes.map((note) => `  ${note}`),
    "next:",
    ...stepLines(next.slice(0, startedBy)),
    `  ${page}`,
    ...stepLines(next.slice(startedBy))
  ].join("\n")
}
