/**
 * The BACnet driver over real UDP on loopback, against simulated devices.
 */
import { NodeDatagramSocket } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { BacnetDevice, BacnetPoint } from "@plenum/core"
import { type Duration, Effect, Result } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import type * as DatagramSocket from "effect/socket/DatagramSocket"
import {
  type Apdu,
  answer,
  batchSizeFor,
  ConfirmedService,
  decodeFrame,
  encodeFrame,
  makeBacnetClient,
  makeBacnetDriverFromClient,
  parseDeviceAddress,
  RejectReason,
  resolvePoint,
  type SimulatedDevice,
  serveSimulatedDevice,
  setPresentValue,
  setProperty,
  simulatedDeviceFor,
  toPointValue
} from "../src/index.ts"

const loopback = { address: "127.0.0.1", port: 0 }

const point = (id: string, objectType: string, instance: number, property?: string): BacnetPoint => ({
  id,
  name: id,
  writable: false,
  objectType,
  instance,
  property: property ?? "present-value"
})

const formatted = (text: string) => Result.map(parseDeviceAddress(text), NetAddress.formatInet)

const supplyTemp = point("supply-temp", "analog-input", 1)
const fanRunning = point("fan-running", "binary-output", 2)
const setpoint = point("setpoint", "analog-value", 3)

const deviceConfig = (points: ReadonlyArray<BacnetPoint>, address?: string): BacnetDevice => ({
  protocol: "bacnet-ip",
  id: "ahu-2",
  deviceInstance: 2001,
  cov: false,
  pollIntervalMs: 1000,
  ...(address === undefined ? {} : { address }),
  points
})

/**
 * Serve `simulated` on a free port, answering through `respond` (the
 * simulator itself by default), and return a client and the device config
 * pointing at it.
 */
const setUp = Effect.fnUntraced(function* (
  points: ReadonlyArray<BacnetPoint>,
  options: {
    readonly simulated?: SimulatedDevice
    readonly respond?: (device: SimulatedDevice, request: Apdu) => Apdu | undefined
    /** 1 s, for requests that get an answer; tests that expect a timeout pass a short one. */
    readonly requestTimeout?: Duration.Input
  } = {}
) {
  const simulated = options.simulated ?? simulatedDeviceFor(deviceConfig(points))
  const serverSocket = yield* NodeDatagramSocket.make({ bind: loopback })
  let address: NetAddress.InetAddress
  if (options.respond === undefined) address = yield* serveSimulatedDevice(serverSocket, simulated)
  else {
    const respond = options.respond
    const reader = yield* serverSocket.reader
    const writer = yield* serverSocket.writer
    const reply = (datagram: DatagramSocket.Datagram) => {
      const frame = decodeFrame(datagram.payload)
      if (Result.isFailure(frame) || frame.success === undefined) return Effect.void
      const response = respond(simulated, frame.success.apdu)
      return response === undefined ? Effect.void : writer.write({ payload: encodeFrame(response), address: datagram })
    }
    yield* Effect.forever(Effect.flatMap(reader.pull, (datagrams) => Effect.forEach(datagrams, reply))).pipe(
      Effect.forkScoped
    )
    address = reader.address
  }
  const clientSocket = yield* NodeDatagramSocket.make({ bind: loopback })
  const client = yield* makeBacnetClient(clientSocket, {
    broadcastAddress: address,
    requestTimeout: options.requestTimeout ?? "1 second",
    retries: 1
  })
  return { client, simulated, config: deviceConfig(points, NetAddress.formatInet(address)) }
})

describe("point values", () => {
  it("resolves names and numbers, and refuses unknown ones", () => {
    expect(resolvePoint(supplyTemp)).toMatchObject(
      Result.succeed({ object: { objectType: 0, instance: 1 }, property: 85, binary: false })
    )
    expect(resolvePoint(fanRunning)).toMatchObject(Result.succeed({ binary: true }))
    expect(resolvePoint(point("vendor", "130", 1, "1000"))).toMatchObject(
      Result.succeed({ object: { objectType: 130 }, property: 1000 })
    )
    expect(resolvePoint(point("typo", "analog-inptu", 1))).toEqual(Result.fail('unknown object type "analog-inptu"'))
    expect(resolvePoint(point("typo", "analog-input", 1, "presentvalue"))).toEqual(
      Result.fail('unknown property "presentvalue"')
    )
  })

  it("turns numbers, enumerations and booleans into point values", () => {
    expect(toPointValue({ binary: false }, [{ type: "real", value: 21.5 }])).toEqual(Result.succeed(21.5))
    expect(toPointValue({ binary: false }, [{ type: "enumerated", value: 3 }])).toEqual(Result.succeed(3))
    expect(toPointValue({ binary: true }, [{ type: "enumerated", value: 1 }])).toEqual(Result.succeed(true))
    expect(toPointValue({ binary: false }, [{ type: "boolean", value: false }])).toEqual(Result.succeed(false))
    expect(toPointValue({ binary: false }, [{ type: "null" }])).toEqual(Result.fail("the property has no value (null)"))
    expect(toPointValue({ binary: false }, [{ type: "character-string", value: "x" }])).toEqual(
      Result.fail("a character-string is not a number or boolean")
    )
    expect(toPointValue({ binary: false }, [])).toEqual(Result.fail("expected one value, got 0"))
  })

  it("parses device addresses with the BACnet port as default", () => {
    expect(formatted("192.168.1.20")).toEqual(Result.succeed("192.168.1.20:47808"))
    expect(formatted("192.168.1.20:47809")).toEqual(Result.succeed("192.168.1.20:47809"))
    expect(Result.isFailure(parseDeviceAddress("192.168.1.20:99999"))).toBe(true)
  })

  it("sizes batches so the answer fits the device's largest APDU", () => {
    expect([50, 128, 206, 480, 1476].map(batchSizeFor)).toEqual([2, 5, 9, 22, 70])
  })
})

describe("BACnet driver over UDP", () => {
  it.live("finds the device and reads every point, binary objects as booleans", () =>
    Effect.gen(function* () {
      const { client, simulated, config } = yield* setUp([supplyTemp, fanRunning, setpoint])
      setPresentValue(simulated, { objectType: "analog-input", instance: 1 }, { type: "real", value: 18.5 })
      setPresentValue(simulated, { objectType: "binary-output", instance: 2 }, { type: "enumerated", value: 1 })
      setPresentValue(simulated, { objectType: "analog-value", instance: 3 }, { type: "real", value: 21 })
      const driver = yield* makeBacnetDriverFromClient(config, client)
      const readings = yield* driver.readAll
      expect(readings.map(({ pointId, value }) => [pointId, value])).toEqual([
        ["supply-temp", 18.5],
        ["fan-running", true],
        ["setpoint", 21]
      ])
    })
  )

  it.live("skips a point the device cannot read and keeps the others", () =>
    Effect.gen(function* () {
      const missing = point("missing", "analog-input", 99)
      const text = point("name", "analog-input", 1, "object-name")
      const simulated = simulatedDeviceFor(deviceConfig([supplyTemp]))
      const { client, config } = yield* setUp([supplyTemp, missing, text], { simulated })
      const driver = yield* makeBacnetDriverFromClient(config, client)
      expect((yield* driver.readAll).map((reading) => reading.pointId)).toEqual(["supply-temp"])
      // The failures are logged once; a second read behaves the same.
      expect((yield* driver.readAll).map((reading) => reading.pointId)).toEqual(["supply-temp"])
    })
  )

  it.live("fails when no point can be read", () =>
    Effect.gen(function* () {
      const simulated = simulatedDeviceFor(deviceConfig([supplyTemp]))
      const { client, config } = yield* setUp([point("missing", "analog-input", 99)], { simulated })
      const error = yield* makeBacnetDriverFromClient(config, client).pipe(
        Effect.flatMap((driver) => driver.readAll),
        Effect.flip
      )
      expect(error).toMatchObject({ reason: "protocol", message: "no point could be read (object: unknown-object)" })
    })
  )

  it.live("halves the batch when the device aborts an answer as too large", () =>
    Effect.gen(function* () {
      const points = Array.from({ length: 12 }, (_, index) => point(`temp-${index}`, "analog-input", index + 1))
      const simulated = simulatedDeviceFor(deviceConfig(points))
      const small = { ...simulated, maxApdu: 128 }
      const { client, config } = yield* setUp(points, { simulated: small })
      // Start too big on purpose: 12 points do not fit in 128 bytes.
      const driver = yield* makeBacnetDriverFromClient(config, client, { batchSize: 12 })
      expect(yield* driver.readAll).toHaveLength(12)
      expect(yield* driver.readAll).toHaveLength(12)
    })
  )

  it.live("falls back to ReadProperty for a device without ReadPropertyMultiple", () =>
    Effect.gen(function* () {
      let multipleRequests = 0
      const { client, simulated, config } = yield* setUp([supplyTemp, fanRunning], {
        respond: (device, request) => {
          if (request._tag === "ConfirmedRequest" && request.service === ConfirmedService.ReadPropertyMultiple) {
            multipleRequests++
            return { _tag: "Reject", invokeId: request.invokeId, reason: RejectReason.UnrecognizedService }
          }
          return answer(device, request)
        }
      })
      setProperty(simulated, { objectType: "analog-input", instance: 1 }, 85, { type: "real", value: 7 })
      const driver = yield* makeBacnetDriverFromClient(config, client)
      expect((yield* driver.readAll).map((reading) => reading.value)).toEqual([7, false])
      expect((yield* driver.readAll).map((reading) => reading.value)).toEqual([7, false])
      expect(multipleRequests).toBe(1)
    })
  )

  it.live("reports a device that does not answer as a timeout", () =>
    Effect.gen(function* () {
      const { client, config } = yield* setUp([supplyTemp], { respond: () => undefined, requestTimeout: "150 millis" })
      const driver = yield* makeBacnetDriverFromClient(config, client)
      expect(yield* driver.readAll.pipe(Effect.flip)).toMatchObject({
        _tag: "DriverError",
        reason: "timeout",
        message: "device 2001 did not answer Who-Is within 150ms"
      })
    })
  )

  it.live("refuses a point with an unknown object type before reading", () =>
    Effect.gen(function* () {
      const { client, config } = yield* setUp([supplyTemp])
      const error = yield* makeBacnetDriverFromClient(
        { ...config, points: [point("typo", "analog-inptu", 1)] },
        client
      ).pipe(Effect.flip)
      expect(error).toMatchObject({
        reason: "configuration",
        message: 'point typo: unknown object type "analog-inptu"'
      })
    })
  )
})
