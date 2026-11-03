/**
 * `main.ts --discover`: find the BACnet devices on the network and draft
 * their config, so nobody types object instances off a commissioning sheet.
 *
 * It broadcasts Who-Is through the config's `bacnet` settings, reads each
 * device's name and pollable objects (`describeDevice`), and prints
 * `{ "devices": [...] }` in the config's own shape on stdout: ids are slugs
 * of the object names, units QUDT where known, and nothing writable (a
 * write is a decision, not a default). Progress and failures go to stderr.
 */
import {
  type BacnetClient,
  type DescribedDevice,
  type DiscoveredDevice,
  describeDevice,
  makeBacnetNetwork,
  MAX_OBJECTS
} from "@plenum/bacnet"
import type { GatewayConfig } from "@plenum/core"
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

/** A device's address for the config: only for a device on this network (one behind a router is found by Who-Is). */
const addressOf = (device: DiscoveredDevice) => {
  if (device.network !== undefined) return undefined
  const host = NetAddress.formatHost(device.address)
  return device.address.port === 47808 ? host : `${host}:${device.address.port}`
}

/** The config draft for described devices, ids unique across them and against `existing`. */
export const draftDevices = (
  found: ReadonlyArray<{ readonly device: DiscoveredDevice; readonly described: DescribedDevice }>,
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

/** Describe one device, or say on stderr why not and leave it out. */
const describeOne = (client: BacnetClient, device: DiscoveredDevice) =>
  Effect.gen(function* () {
    const described = yield* describeDevice(client, device, device.instance)
    yield* Console.error(
      `  device ${device.instance} at ${NetAddress.formatInet(device.address)}: "${described.name}", ${described.objects.length} point(s)` +
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

/** Discover, describe and print the draft. */
export const discover = (config: GatewayConfig) =>
  Effect.gen(function* () {
    const client = yield* makeBacnetNetwork(config.bacnet)
    yield* Console.error(`Who-Is to ${config.bacnet.broadcastAddress}, listening for ${LISTEN}…`)
    const devices = yield* client.discover({ within: LISTEN })
    if (devices.length === 0) {
      yield* Console.error(
        "No device answered. Set bacnet.broadcastAddress to this subnet's broadcast (e.g. 192.168.1.255), check that UDP 47808 is not taken by another BACnet program on this machine, and that devices on other subnets have a BBMD."
      )
    }
    const configured = new Map(
      config.devices.flatMap((device) => (device.protocol === "bacnet-ip" ? [[device.deviceInstance, device.id]] : []))
    )
    const fresh = yield* Effect.filter(devices, (device) => {
      const id = configured.get(device.instance)
      return id === undefined
        ? Effect.succeed(true)
        : Console.error(`  device ${device.instance}: already in the config as ${id}`).pipe(Effect.as(false))
    })
    const described = yield* Effect.forEach(fresh, (device) => describeOne(client, device))
    const existing = config.devices.map((device) => device.id)
    yield* Console.log(JSON.stringify({ devices: draftDevices(described.flat(), existing) }, null, 2))
  }).pipe(Effect.scoped)
