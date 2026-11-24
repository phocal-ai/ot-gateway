/**
 * BACnet discovery from the status page (`/api/discover/devices`, `/api/discover/objects`): what `ot-gateway
 * discover` does (Discover.ts), in two steps a person takes one after the other. First Who-Is, broadcast or to one
 * address, and the devices that answer with their names; then, for the device picked, its objects with the id, name
 * and unit a point would get and the value each reads now.
 *
 * It only reads, from a UDP socket of its own: the configured BACnet port while the gateway reads no BACnet device
 * (broadcast answers arrive there), otherwise or when that port is taken a free one, which hears a device asked at
 * its address but may miss broadcast answers (the result says so). Every step runs through the setup tools' test gate
 * (one at a time), within a deadline, and is bounded in the devices and objects it reads. Names come from the network,
 * where anyone can answer Who-Is, so they are cut to printable text.
 */
import {
  type DiscoveredDevices,
  type DiscoveredObject,
  type DiscoveredObjects,
  DISCOVER_SECONDS,
  DiscoveryFailed,
  type FoundBacnetDevice,
  MAX_DISCOVERED_DEVICES,
  MAX_DISCOVERED_OBJECTS,
  type TestBusy,
  TestInvalid
} from "@ot-gateway/api"
import {
  type BacnetClient,
  describeDevice,
  type DeviceAddress,
  makeBacnetDriverFromClient,
  makeBacnetNetwork,
  ObjectType,
  objectTypeNumber,
  parseDeviceAddress,
  PropertyId
} from "@ot-gateway/bacnet"
import { BacnetDevice, type GatewayConfig, monotonicMillis, type Network } from "@ot-gateway/core"
import { Duration, Effect, Option, Result, Schema } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import { draftDevices, printable } from "./Discover.ts"

/** How long reading the names of the devices that answered may take, after listening. */
const NAMES_TIMEOUT = Duration.seconds(8)
/** How long one device may take to say its name. */
const NAME_TIMEOUT = Duration.seconds(2)
/** How long reading one device's objects, names, units and values may take: inside the server's 30 s deadline. */
const OBJECTS_TIMEOUT = Duration.seconds(25)

export type Gate = <A, E, R>(target: string, test: Effect.Effect<A, E, R>) => Effect.Effect<A, E | TestBusy, R>

/** The config's `address` for where a device answered: `ip`, or `ip:port` off 47808. */
const configAddress = (at: DeviceAddress) => {
  const host = NetAddress.formatHost(at.address)
  return at.address.port === 47808 ? host : `${host}:${at.address.port}`
}

/**
 * The BACnet client for a discovery: on the configured port while the gateway uses none, else (or when it is
 * taken) on a free one. `ownPort` says which, for the note about broadcast answers.
 */
const openClient = (config: GatewayConfig, gatewayUsesPort: boolean, network: Pick<Network, "udp"> | undefined) => {
  const ownPort = { ...config.bacnet, port: 0 }
  const free = makeBacnetNetwork(ownPort, network).pipe(Effect.map((client) => ({ client, ownPort: true })))
  if (gatewayUsesPort) return free
  return makeBacnetNetwork(config.bacnet, network).pipe(
    Effect.map((client) => ({ client, ownPort: false })),
    Effect.catchTag("BacnetSocketError", (error) => (error.addressInUse === true ? free : Effect.fail(error)))
  )
}

/** A device's object-name, or none when it does not say within `NAME_TIMEOUT`. */
const nameOf = (client: BacnetClient, at: DeviceAddress, instance: number) =>
  client
    .readProperty(at, { object: { objectType: ObjectType.device, instance }, property: PropertyId["object-name"] })
    .pipe(
      Effect.map(([value]) =>
        value?.type === "character-string" && value.value !== "" ? Option.some(printable(value.value)) : Option.none()
      ),
      Effect.timeoutOrElse({ duration: NAME_TIMEOUT, orElse: () => Effect.succeed(Option.none<string>()) }),
      Effect.catchTags({
        BacnetTimeout: () => Effect.succeedNone,
        BacnetDeviceError: () => Effect.succeedNone,
        BacnetCodecError: () => Effect.succeedNone,
        BacnetSocketError: () => Effect.succeedNone,
        BacnetEncodeError: () => Effect.succeedNone
      })
    )

const socketFailed = (message: string) =>
  new DiscoveryFailed({ message: `No UDP port for BACnet discovery: ${message}` })

/** Where a request is asked: `ip` or `ip:port`, checked; a typed refusal otherwise. */
const parseAddress = (address: string) => {
  const parsed = parseDeviceAddress(address.trim())
  return Result.isSuccess(parsed)
    ? Effect.succeed<DeviceAddress>({ address: parsed.success })
    : Effect.fail(new TestInvalid({ message: `The address takes ip or ip:port: ${parsed.failure}`, issues: [] }))
}

/** Whether the gateway reads a BACnet device, and so holds the configured port. */
const gatewayUsesPort = (config: GatewayConfig) => config.devices.some((device) => device.protocol === "bacnet-ip")

export const makePageDiscovery = (deps: {
  readonly gate: Gate
  readonly running: () => GatewayConfig
  readonly network?: Pick<Network, "udp"> | undefined
}) => {
  const discoverDevices = Effect.fn("Setup.discoverDevices")(function* (
    address: string | undefined,
    seconds: number | undefined
  ) {
    const config = deps.running()
    const target = address === undefined || address.trim() === "" ? undefined : yield* parseAddress(address)
    const listen = Duration.seconds(seconds ?? DISCOVER_SECONDS.default)
    const asked = target === undefined ? config.bacnet.broadcastAddress : configAddress(target)
    const started = yield* monotonicMillis
    const usesPort = gatewayUsesPort(config)
    const found = yield* deps.gate(
      "BACnet discovery",
      Effect.gen(function* () {
        const { client, ownPort } = yield* openClient(config, usesPort, deps.network)
        const answered = yield* client.discover({
          within: listen,
          ...(target === undefined ? {} : { target: { address: target.address } })
        })
        const listed = answered.slice(0, MAX_DISCOVERED_DEVICES)
        const names = yield* Effect.forEach(
          listed,
          (device) => (device.conflicts.length > 0 ? Effect.succeedNone : nameOf(client, device, device.instance)),
          { concurrency: 4 }
        ).pipe(
          Effect.timeoutOrElse({
            duration: NAMES_TIMEOUT,
            orElse: () => Effect.succeed(listed.map(() => Option.none<string>()))
          })
        )
        return { answered, listed, names, ownPort }
      }).pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: Duration.sum(listen, Duration.sum(NAMES_TIMEOUT, Duration.seconds(2))),
          orElse: () => Effect.fail(new DiscoveryFailed({ message: "BACnet discovery did not finish in time." }))
        }),
        Effect.catchTag("BacnetSocketError", (error) => Effect.fail(socketFailed(error.message)))
      )
    )
    const configured = new Map(
      config.devices.flatMap((device) => (device.protocol === "bacnet-ip" ? [[device.deviceInstance, device.id]] : []))
    )
    const devices = found.listed.map((device, index): FoundBacnetDevice => {
      const name = found.names[index]
      const id = configured.get(device.instance)
      return {
        instance: device.instance,
        ...(device.network === undefined && device.conflicts.length === 0 ? { address: configAddress(device) } : {}),
        ...(name === undefined || Option.isNone(name) ? {} : { name: name.value }),
        conflicts: device.conflicts.map((other) => printable(NetAddress.formatInet(other.address))),
        ...(id === undefined ? {} : { configured: id })
      }
    })
    const note =
      devices.length > 0
        ? undefined
        : target !== undefined
          ? `No device answered at ${asked}. Check the address and port, that BACnet/IP is on for the device, and that no firewall drops UDP to it or from it.`
          : found.ownPort
            ? `No device answered. The BACnet port ${config.bacnet.port} is in use (by the gateway or another program), so this search listened on another port and may not hear answers to a broadcast. Ask a device at its address (ip or ip:port) instead.`
            : `No device answered the broadcast to ${asked}. Set the BACnet broadcast address to this subnet's (e.g. 192.168.1.255), check that devices on other subnets have a BBMD, or ask a device at its address.`
    const finished = yield* monotonicMillis
    const result: DiscoveredDevices = {
      asked,
      devices,
      more: found.answered.length > devices.length,
      ...(note === undefined ? {} : { note }),
      durationMs: Math.max(0, finished - started)
    }
    yield* Effect.logInfo("BACnet devices discovered from the status page").pipe(
      Effect.annotateLogs({ asked, devices: devices.length })
    )
    return result
  })

  const discoverObjects = Effect.fn("Setup.discoverObjects")(function* (instance: number, address: string) {
    const config = deps.running()
    const at = yield* parseAddress(address)
    const started = yield* monotonicMillis
    const usesPort = gatewayUsesPort(config)
    const { described, values } = yield* deps.gate(
      `device ${instance} at ${address}`,
      Effect.gen(function* () {
        const { client } = yield* openClient(config, usesPort, deps.network)
        const read = yield* describeDevice(client, at, instance, 4, MAX_DISCOVERED_OBJECTS)
        const named = {
          ...read,
          name: printable(read.name),
          objects: read.objects.map((object) => ({ ...object, name: printable(object.name) }))
        }
        const [draft] = draftDevices(
          [{ device: { ...at, instance, conflicts: [] }, described: named }],
          config.devices.map((device) => device.id)
        )
        // The values now, read as the gateway would read them; an object that does not answer just has none.
        const device =
          draft === undefined || draft.points.length === 0
            ? Option.none<BacnetDevice>()
            : Schema.decodeUnknownOption(BacnetDevice)({ ...draft, cov: false })
        const readings = Option.isNone(device)
          ? []
          : yield* makeBacnetDriverFromClient(device.value, client).pipe(
              Effect.flatMap((driver) => driver.readAll),
              Effect.orElseSucceed(() => [])
            )
        return { described: { ...named, draft }, values: new Map(readings.map((each) => [each.pointId, each.value])) }
      }).pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: OBJECTS_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new DiscoveryFailed({
                message: `Device ${instance} at ${address} did not list its objects within ${Duration.format(OBJECTS_TIMEOUT)}.`
              })
            )
        }),
        Effect.catchTags({
          BacnetSocketError: (error) => Effect.fail(socketFailed(error.message)),
          BacnetTimeout: () =>
            Effect.fail(
              new DiscoveryFailed({
                message: `Device ${instance} did not answer at ${address}. Check the address and port, and that the instance is the device's.`
              })
            ),
          BacnetDeviceError: (error) =>
            Effect.fail(new DiscoveryFailed({ message: `Device ${instance} refused: ${error.message}` })),
          BacnetCodecError: (error) =>
            Effect.fail(
              new DiscoveryFailed({
                message: `Device ${instance} sent an answer that does not decode: ${error.message}`
              })
            ),
          BacnetEncodeError: (error) =>
            Effect.fail(new DiscoveryFailed({ message: `The request could not be encoded: ${error.message}` }))
        })
      )
    )
    const configuredDevice = config.devices.find(
      (device) => device.protocol === "bacnet-ip" && device.deviceInstance === instance
    )
    const has = (objectType: string, objectInstance: number) =>
      configuredDevice?.protocol === "bacnet-ip" &&
      configuredDevice.points.some(
        (point) =>
          point.instance === objectInstance && objectTypeNumber(point.objectType) === objectTypeNumber(objectType)
      )
    const draft = described.draft
    const objects = (draft?.points ?? []).map((point): DiscoveredObject => {
      const value = values.get(point.id)
      return {
        objectType: point.objectType,
        instance: point.instance,
        name: point.name,
        id: point.id,
        ...(point.unit === undefined ? {} : { unit: point.unit }),
        ...(typeof value === "number" || typeof value === "boolean" ? { value } : {}),
        configured: has(point.objectType, point.instance)
      }
    })
    const finished = yield* monotonicMillis
    const result: DiscoveredObjects = {
      instance,
      address: configAddress(at),
      name: described.name,
      id: draft?.id ?? `device-${instance}`,
      listed: described.listed,
      objects,
      durationMs: Math.max(0, finished - started)
    }
    yield* Effect.logInfo("BACnet device's objects read from the status page").pipe(
      Effect.annotateLogs({ device: instance, address, objects: objects.length, listed: described.listed })
    )
    return result
  })

  return { discoverDevices, discoverObjects }
}
