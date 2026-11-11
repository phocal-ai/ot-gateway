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
import type { BacnetDevice, GatewayConfig, Network } from "@ot-gateway/core"
import { Console, Effect, FileSystem, Result, Schema } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import { basename, dirname, join } from "node:path"
import { toCsv } from "./Csv.ts"
import { isEde } from "./Ede.ts"
import { printJson, shellArgument } from "./Output.ts"
import { appendToPointsList } from "./PointsListAppend.ts"
import { slugify } from "./Slug.ts"

export { slugify }

/** How long Who-Is answers are collected. */
const LISTEN = "3 seconds"

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
      `  device ${device.instance} at ${NetAddress.formatInet(device.address)}: "${printable(described.name)}", ${described.objects.length} point(s)` +
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
          : `${missing} point(s) not in the config yet, drafted under its id to merge into its points`) +
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
}

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
  configPath: string | undefined
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
          message: `the BACnet/IP port ${port} is in use by another program (a running gateway, the demo, a BACnet tool). Stop it and discover again, or set "bacnet.port" in ${configPath ?? "the config"} to a free port (devices that answer a broadcast on 47808 are then only found with --address ip[:port])`
        })
      })
    )
  )

/**
 * The draft `devices` entries for the BACnet devices that answer, with progress and warnings on stderr; through
 * `network` instead of Node's in a simulation.
 */
export const discoverDrafts = (config: GatewayConfig, network?: Pick<Network, "udp">, options: DiscoverOptions = {}) =>
  Effect.gen(function* () {
    const target = options.address === undefined ? undefined : parseDeviceAddress(options.address)
    if (target !== undefined && Result.isFailure(target)) {
      return yield* new DiscoverError({ message: `--address takes ip or ip:port: ${target.failure}` })
    }
    const client = yield* openEndpoint(config, network, target !== undefined, options.configPath)
    yield* Console.error(`Who-Is to ${options.address ?? config.bacnet.broadcastAddress}, listening for ${LISTEN}…`)
    const devices = yield* client.discover({
      within: LISTEN,
      ...(target === undefined ? {} : { target: { address: target.success } })
    })
    if (devices.length === 0) {
      yield* Console.error(
        options.address === undefined
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
    return draftDevices(described.flat(), existing)
  }).pipe(Effect.scoped)

/** `ot-gateway discover`: the drafts as `{ "devices": [...] }` on stdout, ready to paste into the config. */
export const discover = (config: GatewayConfig, network?: Pick<Network, "udp">, options: DiscoverOptions = {}) =>
  Effect.flatMap(discoverDrafts(config, network, options), (devices) => printJson({ devices }))

type Draft = ReturnType<typeof draftDevices>[number]

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

/**
 * `text` at `path` in one step: written next to it under a temporary name, then renamed over it, so an
 * interrupted run leaves the old file or the new one, never half of one. The temporary file goes on failure.
 */
const writeAtomically = Effect.fn("writeAtomically")(function* (path: string, text: string) {
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
      `  ${drafts.length - fresh.length} device(s) already in the config are left out; discover without --points-list drafts their new objects`
    )
  }
  const points = fresh.reduce((total, draft) => total + draft.points.length, 0)
  if (points === 0) {
    return yield* new DiscoverError({
      message: `no points to list; ${path} was ${existing === undefined ? "not written" : "left as it was"}.`
    })
  }
  const next = importCommand(path, options.configPath, options.command)
  if (existing === undefined) {
    yield* writeAtomically(path, draftPointsList(fresh))
    yield* Console.error(
      `wrote ${points} point(s) of ${fresh.length} device(s) to ${path}. Delete the rows you do not need, then: ${next}`
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
    `added ${added} point(s), skipped ${skipped} already in the list, to ${path}` +
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
