/**
 * `main.ts --discover`: find the BACnet devices on the network and draft
 * their config, so nobody types object instances off a commissioning sheet.
 *
 * It broadcasts Who-Is through the config's `bacnet` settings, reads each
 * device's name and pollable objects (`describeDevice`), and prints
 * `{ "devices": [...] }` in the config's own shape on stdout: ids are slugs
 * of the object names, units QUDT where known, and nothing writable (a
 * write is a decision, not a default). Progress and failures go to stderr.
 *
 * When more than one address answers for the same device instance (two
 * devices commissioned with one instance number, or one device answering on
 * several addresses), the instance does not say which host is meant. Its
 * draft entry then has no `address` and no points, and a warning on stderr
 * names every address that answered, so that the operator takes the address
 * from a source they trust.
 *
 * A device already in the config with a fixed `address` is read at that
 * address, and its draft entry, under its config id, holds only the objects
 * it has no point for yet. One without an address is left out.
 */
import {
  type BacnetClient,
  type BacnetRequestError,
  type DescribedDevice,
  type DescribedObject,
  type DeviceAddress,
  describeDevice,
  type FoundDevice,
  makeBacnetNetwork,
  MAX_CONFLICTS,
  MAX_DEVICES,
  MAX_OBJECTS,
  ObjectType,
  objectTypeNumber,
  parseDeviceAddress
} from "@ot-gateway/bacnet"
import { parseConfig } from "@ot-gateway/core"
import type { BacnetDevice, GatewayConfig, Network } from "@ot-gateway/core"
import { Console, Context, Effect, FileSystem, Result, Schema } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import { basename, dirname, join } from "node:path"
import { toCsv } from "./Csv.ts"
import { isEde } from "./Ede.ts"
import { printJson, shellArgument } from "./Output.ts"
import { appendToPointsList } from "./PointsListAppend.ts"
import { slugify } from "./Slug.ts"
import { plural } from "./Words.ts"

export { slugify }

/**
 * How long Who-Is answers are collected at least, in seconds (`discover --wait`). Devices on one network answer
 * within a second; past this, discovery keeps listening while new devices still answer, a second at a time, so a
 * large site behind routers is not cut off, and stops after `MAX_LISTEN` whatever comes.
 */
export const LISTEN_SECONDS = 3
const QUIET = "1 second"
const MAX_LISTEN = "30 seconds"

/** Waiting for Who-Is answers, shown: a line on stderr by default, a spinner for a person (Ui.ts). */
export type WhoIsShown = (
  target: string,
  seconds: number
) => <E, R>(listen: Effect.Effect<ReadonlyArray<FoundDevice>, E, R>) => Effect.Effect<ReadonlyArray<FoundDevice>, E, R>

export const WhoIsProgress = Context.Reference<WhoIsShown>("@ot-gateway/gateway/WhoIsProgress", {
  defaultValue: () => (target, seconds) => (listen) =>
    Console.error(`Who-Is to ${target}, listening for ${seconds} seconds or longer while devices answer…`).pipe(
      Effect.andThen(listen)
    )
})

/** Where the operator should take a device's address from. */
const TRUSTED_SOURCE = "a source you trust (commissioning sheet, device display, DHCP reservation)"

/** Object names often repeat the device's ("Heat pump flow temp" on "Heat pump"); the topic has it already. */
const withoutPrefix = (slug: string, prefix: string) =>
  prefix !== "" && slug.startsWith(`${prefix}-`) ? slug.slice(prefix.length + 1) : slug

/**
 * A point's name without the device's name in front, whole words and any case ("Heat pump flow temperature" on
 * "Heat pump" is "Flow temperature"): the topic and the page name the device already. A symbol between the two
 * goes with it. The name as it is when that would leave nothing, or nothing that starts with a letter or digit.
 */
export const withoutDeviceName = (name: string, deviceName: string) => {
  const device = slugify(deviceName)
  if (device === "") return name
  const words = name.trim().split(/\s+/)
  // The longest prefix first, so a symbol after the device's name ("Heat pump ★ flow") goes with it.
  for (let end = words.length - 1; end >= 1; end--) {
    if (slugify(words.slice(0, end).join(" ")) !== device) continue
    const rest = words.slice(end).join(" ")
    if (/^[\p{L}\p{N}]/u.test(rest)) return capitalized(rest)
  }
  return name
}

/** `wanted`, or `wanted-<suffix>`, or that with a counter: whichever is not taken yet. */
const unique = (taken: Set<string>, wanted: string, suffix: string) => {
  let id = taken.has(wanted) ? `${wanted.slice(0, 63 - suffix.length)}-${suffix}` : wanted
  for (let n = 2; taken.has(id); n++) id = `${wanted.slice(0, 60 - suffix.length)}-${suffix}-${n}`
  taken.add(id)
  return id
}

/** Where a device to draft answered from, and every other source that answered for its instance. */
export type DraftDevice = DeviceAddress & {
  readonly instance: number
  readonly conflicts: ReadonlyArray<DeviceAddress>
}

/** One device for the draft: where it is, what it holds, and its config entry if it has one already. */
export interface DraftInput {
  readonly device: DraftDevice
  readonly described: DescribedDevice
  /** Already in the config: the draft keeps its id and address, and holds only objects it has no point for. */
  readonly configured?: BacnetDevice
}

/**
 * A device's address for the config: only for a device on this network (one
 * behind a router is found by Who-Is), and only when no other address
 * answered for its instance.
 */
const addressOf = (device: DraftDevice) => {
  if (device.network !== undefined || device.conflicts.length > 0) return undefined
  const host = NetAddress.formatHost(device.address)
  return device.address.port === 47808 ? host : `${host}:${device.address.port}`
}

/** The objects a configured device has no point for; its points may name types by name or number. */
const notConfigured = (configured: BacnetDevice, objects: ReadonlyArray<DescribedObject>) =>
  objects.filter(
    (object) =>
      !configured.points.some(
        (point) =>
          point.instance === object.instance && objectTypeNumber(point.objectType) === ObjectType[object.objectType]
      )
  )

/** The config draft for described devices, ids unique across them and against `existing`. */
export const draftDevices = (found: ReadonlyArray<DraftInput>, existing: ReadonlyArray<string> = []) => {
  const deviceIds = new Set(existing)
  return found.map(({ device, described, configured }) => {
    const deviceSlug = slugify(described.name)
    const id = configured?.id ?? unique(deviceIds, deviceSlug || `device-${device.instance}`, String(device.instance))
    const address = configured === undefined ? addressOf(device) : configured.address
    const pointIds = new Set(configured?.points.map((point) => point.id))
    const objects = configured === undefined ? described.objects : notConfigured(configured, described.objects)
    return {
      protocol: "bacnet-ip" as const,
      id,
      deviceInstance: device.instance,
      ...(address === undefined ? {} : { address }),
      points: objects.map((object) => {
        const fallback = `${object.objectType}-${object.instance}`
        return {
          id: unique(pointIds, withoutPrefix(slugify(object.name), deviceSlug) || fallback, String(object.instance)),
          name: object.name === "" ? fallback : withoutDeviceName(object.name, described.name || id),
          ...(object.unit === undefined ? {} : { unit: object.unit }),
          objectType: object.objectType,
          instance: object.instance
        }
      })
    }
  })
}

/**
 * Text from the network as it may be printed to a terminal: every control and format character (C0, C1,
 * escape sequences, bidi overrides) becomes `?`. Also used by `watch` for what the broker sends.
 */
export const withoutControls = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, "?")

/**
 * A device-supplied name as it may be printed to a terminal: anyone on the
 * LAN can answer Who-Is with any name, escape sequences included.
 */
export const printable = (name: string) => withoutControls(name).slice(0, 120)

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(":")

/** Where an answer came from, as printed: its IP address and port, and its network behind a router. */
const sourceText = (source: DeviceAddress) =>
  printable(
    NetAddress.formatInet(source.address) +
      (source.network === undefined
        ? ""
        : ` (network ${source.network.network}, address ${hex(source.network.address)})`)
  )

/** Name every address that answered for the device's instance, and say where its address must come from. */
const conflictWarning = (device: FoundDevice, configured: BacnetDevice | undefined) => {
  const advice =
    configured === undefined
      ? `Its draft entry has no address and no points. Take its address from ${TRUSTED_SOURCE}`
      : configured.address === undefined
        ? `It is in the config as ${configured.id}: set its address from ${TRUSTED_SOURCE}`
        : `It is in the config as ${configured.id} at ${configured.address}: check that address against ${TRUSTED_SOURCE}`
  return Console.error(
    `  device ${device.instance}: WARNING, more than one address answered for it: ` +
      [device, ...device.conflicts].map(sourceText).join(", ") +
      (device.conflicts.length >= MAX_CONFLICTS ? " and possibly more" : "") +
      `. Two devices may share instance ${device.instance}, or one device answers on several addresses. ` +
      `${advice}; the list only says which hosts to check.`
  )
}

const listedNote = (described: DescribedDevice) =>
  described.listed > MAX_OBJECTS ? ` (only the first ${MAX_OBJECTS} of ${described.listed} objects read)` : ""

/** Nothing read from a device: no name, no objects. */
const NOT_DESCRIBED: DescribedDevice = { name: "", listed: 0, objects: [] }

const skip = (instance: number, why: string) =>
  Console.error(`  device ${instance}: left out, ${why}`).pipe(Effect.as<ReadonlyArray<DraftInput>>([]))

/** Leave a device out, saying why, when reading it fails. */
const skipOnFailure =
  (instance: number) =>
  <R>(effect: Effect.Effect<ReadonlyArray<DraftInput>, BacnetRequestError, R>) =>
    effect.pipe(
      Effect.catchTags({
        BacnetTimeout: (error) => skip(instance, error.message),
        BacnetDeviceError: (error) => skip(instance, error.message),
        BacnetCodecError: (error) => skip(instance, error.message),
        BacnetSocketError: (error) => skip(instance, error.message),
        BacnetEncodeError: (error) => skip(instance, error.message)
      })
    )

/**
 * Describe one device that answered Who-Is, or say on stderr why not and
 * leave it out. One that several addresses answered for is not read from
 * any of them.
 */
const describeFound = (client: BacnetClient, device: FoundDevice) =>
  Effect.gen(function* () {
    if (device.conflicts.length > 0) return [{ device, described: NOT_DESCRIBED }]
    const described = yield* describeDevice(client, device, device.instance)
    yield* Console.error(
      `  device ${device.instance} at ${NetAddress.formatInet(device.address)}: "${printable(described.name)}", ${plural(described.objects.length, "point")}` +
        listedNote(described)
    )
    return [{ device, described }]
  }).pipe(skipOnFailure(device.instance))

/** Describe a configured device at its fixed address, for the objects it has no point for yet. */
const describeConfigured = (client: BacnetClient, configured: BacnetDevice, address: string) =>
  Effect.gen(function* () {
    const instance = configured.deviceInstance
    const at = parseDeviceAddress(address)
    if (Result.isFailure(at)) return yield* skip(instance, at.failure)
    const device: DraftDevice = { address: at.success, instance, conflicts: [] }
    const described = yield* describeDevice(client, device, instance)
    const missing = notConfigured(configured, described.objects).length
    yield* Console.error(
      `  device ${instance}: in the config as ${configured.id}, read at ${address}: ` +
        (missing === 0
          ? "every object it lists has a point already"
          : `${plural(missing, "point")} not in the config yet, drafted under its id to merge into its points`) +
        listedNote(described)
    )
    return missing === 0 ? [] : [{ device, described, configured }]
  }).pipe(skipOnFailure(configured.deviceInstance))

export class DiscoverError extends Schema.TaggedError<DiscoverError>()("DiscoverError", { message: Schema.String }) {}

export interface DiscoverOptions {
  /**
   * Ask the device at this `ip` or `ip:port` only, with a Who-Is sent to it rather than broadcast: for a device
   * on another subnet without a BBMD, or on a port other than 47808, whose address a device list gives.
   */
  readonly address?: string | undefined
  /** The config discover read: for an error that names the key to change there, and the import command it names. */
  readonly configPath?: string | undefined
  /** There was no config: the BACnet defaults were used, and the next step is `init --points`, not `import`. */
  readonly noConfig?: boolean | undefined
  /** How long to listen for answers at least, in seconds (`LISTEN_SECONDS` when undefined). */
  readonly wait?: number | undefined
}

/**
 * What `discover` asks with when there is no config yet: the BACnet/IP defaults (UDP 47808, broadcast to
 * 255.255.255.255), no devices. Site, building and broker are placeholders it never uses.
 */
export const discoveryDefaults = parseConfig(
  JSON.stringify({ site: "site", building: "building", mqtt: { url: "mqtt://localhost:1883" }, devices: [] })
)

/**
 * The BACnet/IP endpoint discovery asks from. When another program (a running gateway, the demo, a BACnet tool)
 * holds the configured port, a Who-Is sent to one address (`unicast`) goes out from a free port instead: the device
 * answers to the port the request came from. A broadcast cannot: devices may answer it on 47808 itself, so the error
 * says what to do.
 */
const openEndpoint = (
  config: GatewayConfig,
  network: Pick<Network, "udp"> | undefined,
  unicast: boolean,
  configPath: string | undefined,
  noConfig = false
) =>
  makeBacnetNetwork(config.bacnet, network).pipe(
    Effect.catchTag("BacnetSocketError", (error) =>
      Effect.gen(function* () {
        if (error.addressInUse !== true) return yield* error
        const port = `${config.bacnet.bindAddress}:${config.bacnet.port}`
        if (unicast) {
          yield* Console.error(`UDP ${port} is in use by another program; asking from a free port instead`)
          return yield* makeBacnetNetwork({ ...config.bacnet, port: 0 }, network)
        }
        return yield* new DiscoverError({
          message: noConfig
            ? `the BACnet/IP port ${port} is in use by another program (a running gateway, the demo, a BACnet tool). Stop it and discover again, or ask one device from a free port with --address ip[:port]`
            : `the BACnet/IP port ${port} is in use by another program (a running gateway, the demo, a BACnet tool). Stop it and discover again, or set "bacnet.port" in ${configPath ?? "the config"} to a free port (devices that answer a broadcast on 47808 are then only found with --address ip[:port])`
        })
      })
    )
  )

/**
 * The BACnet devices that answer: their draft `devices` entries and the name each gave, by instance, with progress
 * and warnings on stderr; through `network` instead of Node's in a simulation.
 */
export const discoverFound = (config: GatewayConfig, network?: Pick<Network, "udp">, options: DiscoverOptions = {}) =>
  Effect.gen(function* () {
    const target = options.address === undefined ? undefined : parseDeviceAddress(options.address)
    if (target !== undefined && Result.isFailure(target)) {
      return yield* new DiscoverError({ message: `--address takes ip or ip:port: ${target.failure}` })
    }
    const client = yield* openEndpoint(
      config,
      network,
      target !== undefined,
      options.configPath,
      options.noConfig === true
    )
    const seconds = options.wait ?? LISTEN_SECONDS
    const shown = yield* WhoIsProgress
    const devices = yield* client
      .discover({
        within: `${seconds} seconds`,
        quiet: QUIET,
        atMost: MAX_LISTEN,
        ...(target === undefined ? {} : { target: { address: target.success } })
      })
      .pipe(shown(options.address ?? config.bacnet.broadcastAddress, seconds))
    if (devices.length === 0) {
      yield* Console.error(
        options.address === undefined && options.noConfig === true
          ? "No device answered a broadcast to 255.255.255.255. Without a config, discover asks with the defaults: write one with ot-gateway init and set bacnet.broadcastAddress to this subnet's broadcast (e.g. 192.168.1.255), or ask one device: discover --address ip[:port]."
          : options.address === undefined
            ? "No device answered. Set bacnet.broadcastAddress to this subnet's broadcast (e.g. 192.168.1.255), check that UDP 47808 is not taken by another BACnet program on this machine, and that devices on other subnets have a BBMD. With a device's address from a device list: discover --address ip[:port]."
            : `No device answered at ${options.address}. Check the address and port, that BACnet/IP is on for the device, and that no firewall drops UDP to it or from it.`
      )
    }
    if (devices.length >= MAX_DEVICES) {
      yield* Console.error(
        `  only the first ${MAX_DEVICES} devices that answered are listed, and possibly more answered`
      )
    }
    const configured = new Map(
      config.devices.flatMap((device) => (device.protocol === "bacnet-ip" ? [[device.deviceInstance, device]] : []))
    )
    yield* Effect.forEach(
      devices.filter((device) => device.conflicts.length > 0),
      (device) => conflictWarning(device, configured.get(device.instance)),
      { discard: true }
    )
    const fresh = yield* Effect.filter(devices, (device) => {
      const known = configured.get(device.instance)
      if (known === undefined) return Effect.succeed(true)
      // One with a fixed address is read there, below.
      if (known.address !== undefined) return Effect.succeed(false)
      return Console.error(
        `  device ${device.instance}: already in the config as ${known.id}; with an address it is read there and its other points drafted`
      ).pipe(Effect.as(false))
    })
    const atAddress = [...configured.values()].flatMap((device) =>
      device.address === undefined ? [] : [describeConfigured(client, device, device.address)]
    )
    // A few devices at once; the client keeps the requests within its invoke IDs and deadlines.
    const described = yield* Effect.all([...fresh.map((device) => describeFound(client, device)), ...atAddress], {
      concurrency: 4
    })
    const existing = config.devices.map((device) => device.id)
    const inputs = described.flat()
    const drafts = draftDevices(inputs, existing)
    // The name each device gave, by instance, for the overview: the draft keeps only its slug as the id.
    const names = new Map(inputs.map(({ device, described: about }) => [device.instance, printable(about.name)]))
    return { drafts, names }
  }).pipe(Effect.scoped)

/**
 * The draft `devices` entries for the BACnet devices that answer, with progress and warnings on stderr; through
 * `network` instead of Node's in a simulation.
 */
export const discoverDrafts = (config: GatewayConfig, network?: Pick<Network, "udp">, options: DiscoverOptions = {}) =>
  Effect.map(discoverFound(config, network, options), (found) => found.drafts)

type Draft = ReturnType<typeof draftDevices>[number]

/** One device discovery found, in a line a person reads before choosing: what it is and what it holds. */
export interface FoundOverview {
  /** The id it gets in the config: what `--save` takes, with its instance. */
  readonly id: string
  /** The name the device gave (`""` when it gave none, or was not read). */
  readonly name: string
  readonly deviceInstance: number
  /** Where it answered; null when it is behind a router or more than one address answered for its instance. */
  readonly address: string | null
  /** The points it has that the config does not have yet: all of them for a device new to the config. */
  readonly points: number
  /** Those points by BACnet object type: `{ "analog-input": 4, "binary-value": 2 }`. */
  readonly objectTypes: Readonly<Record<string, number>>
  /** Whether the config has this device already (under this id): saving it adds only `points`. */
  readonly inConfig: boolean
  /** Why saving it adds nothing: every point is in the config, or there are none to read. */
  readonly note?: string
}

/** The overview of `drafts`: one entry per device, for an agent to show and ask which to keep. */
export const foundOverview = (
  drafts: ReadonlyArray<Draft>,
  names: ReadonlyMap<number, string>,
  configured: ReadonlySet<string> = new Set()
): ReadonlyArray<FoundOverview> =>
  drafts.map((draft) => {
    const objectTypes: Record<string, number> = {}
    for (const point of draft.points) objectTypes[point.objectType] = (objectTypes[point.objectType] ?? 0) + 1
    return {
      id: draft.id,
      name: names.get(draft.deviceInstance) ?? "",
      deviceInstance: draft.deviceInstance,
      address: draft.address ?? null,
      points: draft.points.length,
      objectTypes,
      inConfig: configured.has(draft.id),
      ...(draft.points.length > 0
        ? {}
        : configured.has(draft.id)
          ? { note: "in the config already, with every point it lists" }
          : { note: "no points to read: it lists none, or more than one address answered" })
    }
  })

/** The overview as lines a person scans: one per device, its name, where it is and what it holds. */
export const overviewLines = (found: ReadonlyArray<FoundOverview>) =>
  found.map((device) => {
    const types = Object.entries(device.objectTypes)
      .map(([type, count]) => `${count} ${type}`)
      .join(", ")
    const name = device.name === "" || slugify(device.name) === device.id ? "" : ` "${device.name}"`
    const where = device.address === null ? "" : ` at ${device.address}`
    return `${device.id}${name} (instance ${device.deviceInstance}${where}): ${plural(device.points, "point")}${types === "" ? "" : ` (${types})`}${device.note === undefined ? "" : `; ${device.note}`}`
  })

/**
 * The drafts `selection` names: `all` (every one with points), or ids and device instances separated by commas.
 * A device the config has with every point already (`configured`) is `unchanged`, not a mistake, so saving the same
 * selection twice works. Fails naming what matched nothing, with the ids there are, so a mistyped id never saves
 * less than was meant.
 */
export const selectDrafts = (
  drafts: ReadonlyArray<Draft>,
  selection: string,
  configured: ReadonlySet<string> = new Set()
): Result.Result<{ readonly picked: ReadonlyArray<Draft>; readonly unchanged: ReadonlyArray<string> }, string> => {
  const saved = (draft: Draft) => draft.points.length === 0 && configured.has(draft.id)
  const usable = drafts.filter((draft) => draft.points.length > 0)
  const wanted = selection
    .split(",")
    .map((each) => each.trim())
    .filter((each) => each !== "")
  if (wanted.length === 0) {
    return Result.fail("--save takes all, or device ids or instances separated by commas")
  }
  if (wanted.length === 1 && wanted[0] === "all") {
    return Result.succeed({ picked: usable, unchanged: drafts.filter(saved).map((draft) => draft.id) })
  }
  const picked: Array<Draft> = []
  const unchanged: Array<string> = []
  const unknown: Array<string> = []
  const empty: Array<string> = []
  for (const each of wanted) {
    const draft = drafts.find((one) => one.id === each || String(one.deviceInstance) === each)
    if (draft === undefined) unknown.push(each)
    else if (saved(draft)) {
      if (!unchanged.includes(draft.id)) unchanged.push(draft.id)
    } else if (draft.points.length === 0) empty.push(draft.id)
    else if (!picked.includes(draft)) picked.push(draft)
  }
  const available = usable.map((draft) => `${draft.id} (${draft.deviceInstance})`).join(", ") || "none"
  if (unknown.length > 0) {
    return Result.fail(`no device found as ${unknown.join(", ")}; found: ${available}`)
  }
  if (empty.length > 0) {
    return Result.fail(
      `${empty.join(", ")} has no points to read, so it cannot be saved; found with points: ${available}`
    )
  }
  return Result.succeed({ picked, unchanged })
}

/**
 * What `discover --json` (and a pipe) print: the drafts as `{ "devices": [...] }`, ready to paste into the config,
 * with `found`, one overview entry per device to show before choosing, and `next`, the commands that save them.
 */
export const discoveredJson = (
  drafts: ReadonlyArray<Draft>,
  names: ReadonlyMap<number, string>,
  configured: ReadonlySet<string>,
  options: Pick<DiscoverOptions, "configPath" | "noConfig" | "address"> & { readonly command?: string | undefined } = {}
) => {
  const cli = options.command ?? "ot-gateway"
  // The folder's config needs no naming; one device asked by address is asked the same way again.
  const config =
    (options.configPath === undefined || options.configPath === "ot-gateway.json"
      ? ""
      : ` ${shellArgument(options.configPath)}`) +
    (options.address === undefined ? "" : ` --address ${shellArgument(options.address)}`)
  const usable = drafts.filter((draft) => draft.points.length > 0)
  const next =
    usable.length === 0
      ? []
      : options.noConfig === true
        ? [`${cli} init . --site <site> --broker <url> --devices none`, `${cli} discover --save all`]
        : [
            `${cli} discover${config} --save all`,
            `${cli} discover${config} --save ${usable.map((draft) => draft.id).join(",")}`
          ]
  return { devices: drafts, found: foundOverview(drafts, names, configured), next }
}

/** `ot-gateway discover`: the drafts on stdout, with the overview and the commands that save them. */
export const discover = (
  config: GatewayConfig,
  network?: Pick<Network, "udp">,
  options: DiscoverOptions & { readonly command?: string | undefined } = {}
) =>
  Effect.flatMap(discoverFound(config, network, options), ({ drafts, names }) =>
    printJson(discoveredJson(drafts, names, new Set(config.devices.map((device) => device.id)), options))
  )

/** `text` with its first letter upper-cased ("flow temperature" → "Flow temperature"). */
const capitalized = (text: string) => {
  const [first = ""] = text
  return first.toUpperCase() + text.slice(first.length)
}

/**
 * A device-supplied point name as the list's `point` column, readable and with the point's id as its slug,
 * since import makes the id from it: the object name from the word where its id starts, so the device's name
 * in front ("Heat pump flow temperature" with id `flow-temperature`) is dropped as `draftDevices` drops it
 * from the id, first letter upper-cased ("Flow temperature"). Otherwise the id: a name made unique with a
 * suffix, or one whose words do not slug to the id. The name must start with a letter or digit, which keeps
 * out names that a spreadsheet would run as a formula (=, +, -, @, tab, CR): anyone on the LAN can answer Who-Is
 * with any name. A symbol between the device's name and the point's ("Heat pump ★ flow") is dropped with it.
 */
export const pointColumn = (point: { readonly id: string; readonly name: string }) => {
  const words = point.name.trim().split(/\s+/)
  for (let start = 0; start < words.length; start++) {
    const name = capitalized(words.slice(start).join(" "))
    if (/^[\p{L}\p{N}]/u.test(name) && slugify(name) === point.id) return name
  }
  return point.id
}

/**
 * The points list columns discover fills (PointsSchema.ts), in the schema's order. `publish` is written out as the
 * default, `sample` (every read), so the list shows what each row sends and where to change it.
 */
export const draftColumns = [
  "device",
  "point",
  "unit",
  "publish",
  "device_instance",
  "address",
  "object_type",
  "object_instance"
]

/** What a discovered row sends: every read, the points list's default, written out. */
export const draftPublish = "sample"

/** The drafts as points list rows, fields in the order of `draftColumns`. */
export const draftRows = (drafts: ReadonlyArray<Draft>) =>
  drafts.flatMap((draft) =>
    draft.points.map((point) => [
      draft.id,
      pointColumn(point),
      point.unit ?? "",
      draftPublish,
      String(draft.deviceInstance),
      draft.address ?? "",
      point.objectType,
      String(point.instance)
    ])
  )

/** The drafts as a points list (PointsSchema.ts): one row per object, to trim and import. */
export const draftPointsList = (drafts: ReadonlyArray<Draft>) => toCsv([draftColumns, ...draftRows(drafts)])

/**
 * What `discover --points-list` wrote: the file; the devices and points discovery listed; how many of those points
 * were added to the file and how many were in it already (`--append` only, 0 otherwise); whether it appended;
 * and the command that imports the list into the config discover read, when it added rows.
 */
export interface PointsListWritten {
  readonly path: string
  readonly devices: number
  readonly points: number
  readonly added: number
  readonly skipped: number
  readonly appended: boolean
  readonly next?: string
}

/**
 * The command that adds the list at `listPath` to the config at `configPath`, both named, so it runs anywhere; `cli`
 * is how the CLI was run (`cliCommand`).
 */
export const importCommand = (listPath: string, configPath: string | undefined, cli = "ot-gateway") =>
  `${cli} import ${shellArgument(listPath)}${configPath === undefined ? "" : ` ${shellArgument(configPath)}`}`

/** What to run after a list is written: import it into the config, or with no config yet, start one from it. */
export const pointsListNext = (path: string, options: PointsListOptions) =>
  options.noConfig === true
    ? `${options.command ?? "ot-gateway"} init . --points ${shellArgument(path)}`
    : importCommand(path, options.configPath, options.command)

/**
 * `text` at `path` in one step: written next to it under a temporary name, then renamed over it, so an
 * interrupted run leaves the old file or the new one, never half of one. The temporary file goes on failure.
 */
export const writeAtomically = Effect.fn("writeAtomically")(function* (path: string, text: string) {
  const fs = yield* FileSystem.FileSystem
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  yield* fs.writeFileString(temporary, text).pipe(
    Effect.andThen(fs.rename(temporary, path)),
    Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore))
  )
})

export interface PointsListOptions extends DiscoverOptions {
  /** How the CLI was run (`cliCommand`), for the import command it prints; `ot-gateway` when undefined. */
  readonly command?: string | undefined
  /** Add to the list at the path when there is one, instead of refusing to touch it. */
  readonly append?: boolean | undefined
}

/**
 * `ot-gateway discover --points-list <file>`: the drafts of devices not in the config yet, written as a points
 * list to trim, check and import. An existing file is left alone, unless `append` asks to add to it
 * (PointsListAppend.ts: rows it has already are skipped). None is written when discovery found nothing; that and
 * an existing file without `append` fail, so a script or agent never goes on with a list that is stale or
 * missing. The file is replaced in one step, never left half written.
 */
export const discoverToPointsList = Effect.fn("discoverToPointsList")(function* (
  config: GatewayConfig,
  path: string,
  network?: Pick<Network, "udp">,
  options: PointsListOptions = {}
) {
  const fs = yield* FileSystem.FileSystem
  const append = options.append === true
  // Read before asking the network, so a list that cannot be added to fails without waiting for answers.
  const existing = (yield* fs.exists(path))
    ? append
      ? yield* fs.readFileString(path)
      : yield* new DiscoverError({
          message: `${path} exists; add --append to add the devices found to it, give another file name, or move it away first. Nothing was written.`
        })
    : undefined
  if (existing !== undefined && isEde(existing)) {
    return yield* new DiscoverError({
      message: `${path} is an EDE file; turn it into a points list first (ot-gateway points from-ede ${path} > points.csv) and add to that. Nothing was written.`
    })
  }
  if (existing !== undefined) {
    const check = appendToPointsList(existing, draftColumns, [])
    if (Result.isFailure(check)) {
      return yield* new DiscoverError({ message: `${path}: ${check.failure}. Nothing was written.` })
    }
  }
  const configured = new Set(config.devices.map((device) => device.id))
  const drafts = yield* discoverDrafts(config, network, options)
  const fresh = drafts.filter((draft) => !configured.has(draft.id))
  if (fresh.length < drafts.length) {
    yield* Console.error(
      `  ${plural(drafts.length - fresh.length, "device")} already in the config are left out; discover without --points-list drafts their new objects`
    )
  }
  const points = fresh.reduce((total, draft) => total + draft.points.length, 0)
  if (points === 0) {
    return yield* new DiscoverError({
      message: `no points to list; ${path} was ${existing === undefined ? "not written" : "left as it was"}.`
    })
  }
  const next = pointsListNext(path, options)
  if (existing === undefined) {
    yield* writeAtomically(path, draftPointsList(fresh))
    yield* Console.error(
      `wrote ${plural(points, "point")} of ${plural(fresh.length, "device")} to ${path}. Delete the rows you do not need, then: ${next}`
    )
    const written: PointsListWritten = {
      path,
      devices: fresh.length,
      points,
      added: points,
      skipped: 0,
      appended: false,
      next
    }
    return written
  }
  const merged = appendToPointsList(existing, draftColumns, draftRows(fresh))
  if (Result.isFailure(merged)) {
    return yield* new DiscoverError({ message: `${path}: ${merged.failure}. Nothing was written.` })
  }
  const { added, skipped } = merged.success
  if (added > 0) yield* writeAtomically(path, merged.success.text)
  yield* Console.error(
    `added ${plural(added, "point")}, skipped ${skipped} already in the list, to ${path}` +
      (added > 0 ? `. Delete the rows you do not need, then: ${next}` : "; it was left as it was")
  )
  const written: PointsListWritten = {
    path,
    devices: fresh.length,
    points,
    added,
    skipped,
    appended: true,
    ...(added > 0 ? { next } : {})
  }
  return written
})
