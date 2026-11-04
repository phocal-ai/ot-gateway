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
import { Console, Effect, Result } from "effect"
import * as NetAddress from "effect/net/NetAddress"

/** How long Who-Is answers are collected. */
const LISTEN = "3 seconds"

/** Where the operator should take a device's address from. */
const TRUSTED_SOURCE = "a source you trust (commissioning sheet, device display, DHCP reservation)"

/** A config slug (lowercase, digits, `-` and `_`, at most 64) from a free-text name; empty when nothing is left. */
export const slugify = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "")

/** Object names often repeat the device's ("AHU 2 supply temp" on "AHU 2"); the topic has it already. */
const withoutPrefix = (slug: string, prefix: string) =>
  prefix !== "" && slug.startsWith(`${prefix}-`) ? slug.slice(prefix.length + 1) : slug

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
          name: object.name === "" ? fallback : object.name,
          ...(object.unit === undefined ? {} : { unit: object.unit }),
          objectType: object.objectType,
          instance: object.instance
        }
      })
    }
  })
}

/**
 * A device-supplied name as it may be printed to a terminal: anyone on the
 * LAN can answer Who-Is with any name, escape sequences included.
 */
export const printable = (name: string) => name.replace(/[\p{Cc}\p{Cf}]/gu, "?").slice(0, 120)

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

/** Discover, describe and print the draft; through `network` instead of Node's in a simulation. */
export const discover = (config: GatewayConfig, network?: Pick<Network, "udp">) =>
  Effect.gen(function* () {
    const client = yield* makeBacnetNetwork(config.bacnet, network)
    yield* Console.error(`Who-Is to ${config.bacnet.broadcastAddress}, listening for ${LISTEN}…`)
    const devices = yield* client.discover({ within: LISTEN })
    if (devices.length === 0) {
      yield* Console.error(
        "No device answered. Set bacnet.broadcastAddress to this subnet's broadcast (e.g. 192.168.1.255), check that UDP 47808 is not taken by another BACnet program on this machine, and that devices on other subnets have a BBMD."
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
    yield* Console.log(JSON.stringify({ devices: draftDevices(described.flat(), existing) }, null, 2))
  }).pipe(Effect.scoped)
