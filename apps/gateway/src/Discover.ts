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
 * When more than one address answers for the same device instance, the
 * instance does not say which host is the device. Its draft entry then has
 * no `address` and no points, and a warning on stderr names every address
 * that answered, so that the operator takes the address from a source they
 * trust.
 */
import {
  type BacnetClient,
  type DescribedDevice,
  type DeviceAddress,
  type DiscoveredDevice,
  describeDevice,
  type FoundDevice,
  makeBacnetNetwork,
  MAX_CONFLICTS,
  MAX_OBJECTS
} from "@ot-gateway/bacnet"
import type { GatewayConfig, Network } from "@ot-gateway/core"
import { Console, Effect } from "effect"
import * as NetAddress from "effect/net/NetAddress"

/** How long Who-Is answers are collected. */
const LISTEN = "3 seconds"

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

/**
 * A device's address for the config: only for a device on this network (one
 * behind a router is found by Who-Is), and only when no other address
 * answered for its instance.
 */
const addressOf = (device: FoundDevice) => {
  if (device.network !== undefined || device.conflicts.length > 0) return undefined
  const host = NetAddress.formatHost(device.address)
  return device.address.port === 47808 ? host : `${host}:${device.address.port}`
}

/** The config draft for described devices, ids unique across them and against `existing`. */
export const draftDevices = (
  found: ReadonlyArray<{ readonly device: FoundDevice; readonly described: DescribedDevice }>,
  existing: ReadonlyArray<string> = []
) => {
  const deviceIds = new Set(existing)
  return found.map(({ device, described }) => {
    const deviceSlug = slugify(described.name)
    const id = unique(deviceIds, deviceSlug || `device-${device.instance}`, String(device.instance))
    const address = addressOf(device)
    const pointIds = new Set<string>()
    return {
      protocol: "bacnet-ip" as const,
      id,
      deviceInstance: device.instance,
      ...(address === undefined ? {} : { address }),
      points: described.objects.map((object) => {
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
const conflictWarning = (device: FoundDevice) =>
  Console.error(
    `  device ${device.instance}: WARNING, more than one address answered for it: ` +
      [device, ...device.conflicts].map(sourceText).join(", ") +
      (device.conflicts.length >= MAX_CONFLICTS ? " and possibly more" : "") +
      ". Its draft entry has no address and no points. Take its address from a source you trust" +
      " (commissioning sheet, device display, DHCP reservation), not from this list."
  )

/** Nothing read from a device: no name, no objects. */
const NOT_DESCRIBED: DescribedDevice = { name: "", listed: 0, objects: [] }

/**
 * Describe one device, or say on stderr why not and leave it out. One that
 * several addresses answered for is not read from any of them.
 */
const describeOne = (client: BacnetClient, device: FoundDevice) =>
  Effect.gen(function* () {
    if (device.conflicts.length > 0) return [{ device, described: NOT_DESCRIBED }]
    const described = yield* describeDevice(client, device, device.instance)
    yield* Console.error(
      `  device ${device.instance} at ${NetAddress.formatInet(device.address)}: "${printable(described.name)}", ${described.objects.length} point(s)` +
        (described.listed > MAX_OBJECTS ? ` (only the first ${MAX_OBJECTS} of ${described.listed} objects read)` : "")
    )
    return [{ device, described }]
  }).pipe(
    Effect.catchTags({
      BacnetTimeout: (error) => skip(device, error.message),
      BacnetDeviceError: (error) => skip(device, error.message),
      BacnetCodecError: (error) => skip(device, error.message),
      BacnetSocketError: (error) => skip(device, error.message)
    })
  )

const skip = (device: DiscoveredDevice, why: string) =>
  Console.error(`  device ${device.instance}: left out, ${why}`).pipe(Effect.as([]))

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
    // Configured devices are named too: one configured without an address is located by the same broadcast.
    yield* Effect.forEach(
      devices.filter((device) => device.conflicts.length > 0),
      conflictWarning,
      { discard: true }
    )
    const configured = new Map(
      config.devices.flatMap((device) => (device.protocol === "bacnet-ip" ? [[device.deviceInstance, device.id]] : []))
    )
    const fresh = yield* Effect.filter(devices, (device) => {
      const id = configured.get(device.instance)
      return id === undefined
        ? Effect.succeed(true)
        : Console.error(`  device ${device.instance}: already in the config as ${id}`).pipe(Effect.as(false))
    })
    // A few devices at once; the client keeps the requests within its invoke IDs and deadlines.
    const described = yield* Effect.forEach(fresh, (device) => describeOne(client, device), { concurrency: 4 })
    const existing = config.devices.map((device) => device.id)
    yield* Console.log(JSON.stringify({ devices: draftDevices(described.flat(), existing) }, null, 2))
  }).pipe(Effect.scoped)
