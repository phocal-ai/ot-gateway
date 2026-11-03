/**
 * WriteProperty (clause 15.9) through the driver to a simulated device, on an
 * in-memory network: the priority array of an output (clause 19.2), the
 * relinquish with Null, and what a device refuses.
 */
import { describe, expect, it } from "@effect/vitest"
import { type BacnetDevice, type BacnetPoint, makeMemoryNetwork, parseConfig } from "@plenum/core"
import { Effect, Result } from "effect"
import {
  decodeWriteProperty,
  encodeWriteProperty,
  makeBacnetDriverFromClient,
  makeBacnetNetwork,
  ObjectType,
  PropertyId,
  serveSimulatedDevice,
  simulatedDeviceFor
} from "../src/index.ts"

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ")

describe("WriteProperty codec", () => {
  it("encodes the Annex F.3.9 example: 180.0 to analog value 1's present value", () => {
    const request = {
      object: { objectType: ObjectType["analog-value"], instance: 1 },
      property: PropertyId["present-value"],
      value: { type: "real", value: 180 }
    } as const
    expect(hex(encodeWriteProperty(request))).toBe("0c 00 80 00 01 19 55 3e 44 43 34 00 00 3f")
    expect(decodeWriteProperty(encodeWriteProperty(request))).toEqual(Result.succeed(request))
  })

  it("round-trips a priority and a Null (relinquish), and refuses priority 17", () => {
    const request = {
      object: { objectType: ObjectType["analog-output"], instance: 2 },
      property: PropertyId["present-value"],
      value: { type: "null" },
      priority: 8
    } as const
    expect(decodeWriteProperty(encodeWriteProperty(request))).toEqual(Result.succeed(request))
    expect(Result.isFailure(decodeWriteProperty(encodeWriteProperty({ ...request, priority: 17 })))).toBe(true)
  })
})

const point = (id: string, objectType: string, priority = 8): BacnetPoint => ({
  id,
  name: id,
  writable: true,
  objectType,
  instance: 1,
  property: "present-value",
  priority
})

const setup = Effect.fnUntraced(function* (points: ReadonlyArray<BacnetPoint>) {
  const network = makeMemoryNetwork()
  const device: BacnetDevice = {
    protocol: "bacnet-ip",
    id: "ahu",
    deviceInstance: 2001,
    address: "10.0.2.1",
    cov: false,
    pollIntervalMs: 5_000,
    points
  }
  const simulated = simulatedDeviceFor(device)
  yield* serveSimulatedDevice(yield* network.host("10.0.2.1").udp({ address: "10.0.2.1", port: 47_808 }), simulated)
  const config = yield* parseConfig(
    JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://x" }, devices: [] })
  )
  const client = yield* makeBacnetNetwork(config.bacnet, network.host("10.0.0.1"))
  const driver = yield* makeBacnetDriverFromClient(device, client)
  // The first cycle finds the device; a write before that has nowhere to go.
  const early = yield* Effect.flip(driver.write(points[0]?.id ?? "", 1))
  yield* driver.readAll
  return { driver, simulated, early }
})

const valueOf = (readings: ReadonlyArray<{ readonly pointId: string; readonly value: unknown }>, id: string) =>
  readings.find((reading) => reading.pointId === id)?.value

describe("BACnet writes", () => {
  it.effect("commands an output at the point's priority, and Null hands it back to the relinquish default", () =>
    Effect.gen(function* () {
      const { driver, simulated, early } = yield* setup([
        point("valve", "analog-output"),
        point("fan", "binary-output", 10)
      ])
      expect(early.reason).toBe("connection")

      yield* driver.write("valve", 42.5)
      yield* driver.write("fan", true)
      let readings = yield* driver.readAll
      expect([valueOf(readings, "valve"), valueOf(readings, "fan")]).toEqual([42.5, true])
      expect(simulated.writes.map((write) => [write.value, write.priority])).toEqual([
        [{ type: "real", value: 42.5 }, 8],
        [{ type: "enumerated", value: 1 }, 10]
      ])

      yield* driver.write("valve", null)
      readings = yield* driver.readAll
      expect(valueOf(readings, "valve")).toBe(0)
    }).pipe(Effect.scoped)
  )

  it.effect("refuses a value of the wrong type before sending it, and reports what the device refuses", () =>
    Effect.gen(function* () {
      const { driver, simulated } = yield* setup([point("valve", "analog-output"), point("temp", "analog-input")])
      expect((yield* Effect.flip(driver.write("valve", true))).reason).toBe("configuration")
      expect(simulated.writes).toEqual([])
      // An input in service is not writable (clause 12.2.4): the device says so.
      const refused = yield* Effect.flip(driver.write("temp", 20))
      expect(refused.reason).toBe("protocol")
    }).pipe(Effect.scoped)
  )
})
