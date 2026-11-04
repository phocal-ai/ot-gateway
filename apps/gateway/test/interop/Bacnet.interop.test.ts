/**
 * The BACnet driver against a device that is not ours: the BACnet Stack demo
 * server (bacserv, test/interop/bacnet/Dockerfile), the open-source
 * reference implementation. Discovery, ReadPropertyMultiple, WriteProperty
 * with priority and relinquish, and change of value.
 *
 * Runs with OT_GATEWAY_INTEROP=1 and OT_GATEWAY_INTEROP_BACNET=<device ip>; the test
 * binds the BACnet port (47808) on every address, since bacserv answers
 * Who-Is with a broadcast I-Am. OT_GATEWAY_INTEROP_BACNET_BROADCAST is the
 * broadcast address of the network bacserv is on.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import {
  type BacnetClient,
  type DeviceAddress,
  makeBacnetDriverFromClient,
  makeBacnetNetwork,
  ObjectType,
  parseDeviceAddress,
  PropertyId
} from "@ot-gateway/bacnet"
import { parseConfig, type Reading } from "@ot-gateway/core"
import { Effect, Result, Stream } from "effect"

const device = process.env["OT_GATEWAY_INTEROP_BACNET"]
const broadcast = process.env["OT_GATEWAY_INTEROP_BACNET_BROADCAST"] ?? "255.255.255.255"
const enabled = process.env["OT_GATEWAY_INTEROP"] === "1" && device !== undefined

/** The first instance of `objectType` in the device's object list, read element by element (always fits unsegmented). */
const firstInstance = Effect.fnUntraced(function* (client: BacnetClient, target: DeviceAddress, objectType: number) {
  const deviceObject = { objectType: ObjectType.device, instance: 2002 }
  const property = PropertyId["object-list"]
  const [count] = yield* client.readProperty(target, { object: deviceObject, property, arrayIndex: 0 })
  const length = count?.type === "unsigned" ? count.value : 0
  for (let index = 1; index <= length; index++) {
    const [entry] = yield* client.readProperty(target, { object: deviceObject, property, arrayIndex: index })
    if (entry?.type === "object-identifier" && entry.value.objectType === objectType) return entry.value.instance
  }
  return yield* Effect.die(new Error(`bacserv has no object of type ${objectType}`))
})

const setup = Effect.gen(function* () {
  const settings = yield* parseConfig(
    JSON.stringify({
      site: "s",
      building: "b",
      mqtt: { url: "mqtt://unused" },
      bacnet: { broadcastAddress: broadcast, requestTimeoutMs: 1_000 },
      devices: []
    })
  )
  const client = yield* makeBacnetNetwork(settings.bacnet)
  const target = { address: Result.getOrThrow(parseDeviceAddress(device ?? "")) }
  // The demo server's objects vary between releases: use the ones it has.
  const input = yield* firstInstance(client, target, ObjectType["analog-input"])
  const output = yield* firstInstance(client, target, ObjectType["analog-output"])
  const config = yield* parseConfig(
    JSON.stringify({
      ...settings,
      devices: [
        {
          protocol: "bacnet-ip",
          id: "bacserv",
          deviceInstance: 2002,
          address: device,
          points: [
            { id: "input", name: "Input", objectType: "analog-input", instance: input },
            {
              id: "output",
              name: "Output",
              objectType: "analog-output",
              instance: output,
              writable: true,
              limits: { min: 0, max: 100 },
              priority: 8
            }
          ]
        }
      ]
    })
  )
  const [bacnetDevice] = config.devices
  if (bacnetDevice?.protocol !== "bacnet-ip") return yield* Effect.die(new Error("no BACnet device"))
  return yield* makeBacnetDriverFromClient(bacnetDevice, client, {
    cov: { lifetimeSeconds: 60, renewMs: 30_000, checkMs: 200 }
  })
})

const valueOf = (readings: ReadonlyArray<Reading>, id: string) =>
  readings.find((reading) => reading.pointId === id)?.value

describe.runIf(enabled)("interop: BACnet/IP against the BACnet Stack demo server", () => {
  it.live(
    "finds the device, reads it, writes an output at priority 8 and relinquishes it",
    () =>
      Effect.gen(function* () {
        const driver = yield* setup
        const first = yield* driver.readAll
        expect(typeof valueOf(first, "input")).toBe("number")
        yield* driver.write("output", 42.5)
        expect(valueOf(yield* driver.readAll, "output")).toBe(42.5)
        yield* driver.write("output", null)
        expect(valueOf(yield* driver.readAll, "output")).not.toBe(42.5)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000
  )

  it.live(
    "subscribes to change of value and hears a written output change",
    () =>
      Effect.gen(function* () {
        const driver = yield* setup
        const changes = driver.changes
        if (changes === undefined) return yield* Effect.die(new Error("no COV stream"))
        const pushed: Array<Reading> = []
        yield* Stream.runForEach(changes, (reading) => Effect.sync(() => pushed.push(reading))).pipe(Effect.forkScoped)
        yield* driver.readAll
        // Let the subscriptions go out, then change the output.
        yield* Effect.sleep("2 seconds")
        yield* driver.write("output", 17.25)
        const deadline = Date.now() + 10_000
        while (!pushed.some((reading) => reading.pointId === "output" && reading.value === 17.25)) {
          if (Date.now() > deadline) return yield* Effect.die(new Error("no COV notification for the write"))
          yield* Effect.sleep("100 millis")
        }
        yield* driver.write("output", null)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000
  )
})
