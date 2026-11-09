/**
 * The BACnet driver over real UDP on loopback, against simulated devices.
 */
import * as NodeDatagramSocket from "@effect/platform-node/NodeDatagramSocket"
import { describe, expect, it } from "@effect/vitest"
import type { BacnetDevice, BacnetPoint, Reading } from "@ot-gateway/core"
import { type Duration, Effect, Fiber, Result, Schedule, Stream } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import type * as DatagramSocket from "effect/socket/DatagramSocket"
import {
  type Apdu,
  answer,
  batchSizeFor,
  ConfirmedService,
  decodeFrame,
  encodeErrorBody,
  ErrorClass,
  ErrorCode,
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
  toPointValue,
  UnconfirmedService
} from "../src/index.ts"

const loopback = { address: "127.0.0.1", port: 0 }

const point = (id: string, objectType: string, instance: number, property?: string): BacnetPoint => ({
  id,
  name: id,
  writable: false,
  priority: 8,
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
  id: "ventilation-2",
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
      Result.succeed({ object: { objectType: 0, instance: 1 }, property: 85, binary: false, multiState: false })
    )
    expect(resolvePoint(fanRunning)).toMatchObject(Result.succeed({ binary: true }))
    expect(resolvePoint(point("vendor", "130", 1, "1000"))).toMatchObject(
      Result.succeed({ object: { objectType: 130 }, property: 1000 })
    )
    expect(resolvePoint(point("typo", "analog-inptu", 1))).toEqual(Result.fail('unknown object type "analog-inptu"'))
    expect(resolvePoint(point("typo", "analog-input", 1, "presentvalue"))).toEqual(
      Result.fail('unknown property "presentvalue"')
    )
    expect(resolvePoint(point("all", "analog-input", 1, "all"))).toEqual(
      Result.fail('"all" reads several properties; name one')
    )
    expect(resolvePoint(point("proto", "constructor", 1))).toEqual(Result.fail('unknown object type "constructor"'))
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
    expect(toPointValue({ binary: false }, [{ type: "real", value: Number.NaN }])).toEqual(
      Result.fail("not a finite number (NaN)")
    )
    expect(toPointValue({ binary: false }, [{ type: "double", value: Number.POSITIVE_INFINITY }])).toEqual(
      Result.fail("not a finite number (Infinity)")
    )
  })

  it("parses device addresses with the BACnet port as default", () => {
    expect(formatted("192.168.1.20")).toEqual(Result.succeed("192.168.1.20:47808"))
    expect(formatted("192.168.1.20:47809")).toEqual(Result.succeed("192.168.1.20:47809"))
    expect(Result.isFailure(parseDeviceAddress("192.168.1.20:99999"))).toBe(true)
  })

  it("sizes batches so the answer fits the device's largest APDU", () => {
    expect([50, 128, 206, 480, 1476].map(batchSizeFor)).toEqual([2, 5, 9, 21, 66])
    // A device claiming more than BACnet/IP carries gets what fits in one datagram.
    expect(batchSizeFor(65_535)).toBe(66)
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

  it.live("halves the batch when the device aborts an answer as too large, and keeps the smaller size", () =>
    Effect.gen(function* () {
      const points = Array.from({ length: 12 }, (_, index) => point(`temp-${index}`, "analog-input", index + 1))
      const simulated = { ...simulatedDeviceFor(deviceConfig(points)), maxApdu: 128 }
      let requests = 0
      let aborts = 0
      const { client, config } = yield* setUp(points, {
        simulated,
        respond: (device, request) => {
          const response = answer(device, request)
          if (request._tag === "ConfirmedRequest") requests++
          if (response?._tag === "Abort") aborts++
          return response
        }
      })
      // Start too big on purpose: 12 points do not fit in 128 bytes.
      const driver = yield* makeBacnetDriverFromClient(config, client, { batchSize: 12 })
      expect(yield* driver.readAll).toHaveLength(12)
      expect(aborts).toBeGreaterThan(0)
      const [abortsBefore, requestsBefore] = [aborts, requests]
      expect(yield* driver.readAll).toHaveLength(12)
      // The second cycle starts at the size that worked: no more aborts, and no more requests than batches of 3.
      expect(aborts).toBe(abortsBefore)
      expect(requests - requestsBefore).toBeLessThanOrEqual(4)
    })
  )

  it.live("reads point by point when the device refuses the whole batch", () =>
    Effect.gen(function* () {
      const missing = point("missing", "analog-input", 99)
      const simulated = simulatedDeviceFor(deviceConfig([supplyTemp, setpoint]))
      const { client, config } = yield* setUp([supplyTemp, missing, setpoint], {
        simulated,
        // Like some older devices: one unknown object fails the whole ReadPropertyMultiple.
        respond: (device, request) =>
          request._tag === "ConfirmedRequest" && request.service === ConfirmedService.ReadPropertyMultiple
            ? {
                _tag: "Error",
                invokeId: request.invokeId,
                service: request.service,
                body: encodeErrorBody({ errorClass: ErrorClass.object, errorCode: ErrorCode["unknown-object"] })
              }
            : answer(device, request)
      })
      const driver = yield* makeBacnetDriverFromClient(config, client)
      expect((yield* driver.readAll).map((reading) => reading.pointId)).toEqual(["supply-temp", "setpoint"])
    })
  )

  it.live("keeps what it read before a request timed out", () =>
    Effect.gen(function* () {
      let multipleRequests = 0
      const { client, config } = yield* setUp([supplyTemp, setpoint], {
        requestTimeout: "150 millis",
        respond: (device, request) => {
          if (request._tag === "ConfirmedRequest" && request.service === ConfirmedService.ReadPropertyMultiple) {
            multipleRequests++
            // The second batch (and its resend) goes unanswered.
            if (multipleRequests > 1) return undefined
          }
          return answer(device, request)
        }
      })
      const driver = yield* makeBacnetDriverFromClient(config, client, { batchSize: 1 })
      expect((yield* driver.readAll).map((reading) => reading.pointId)).toEqual(["supply-temp"])
    })
  )

  it.live("reads a device at a fixed address that never answers Who-Is", () =>
    Effect.gen(function* () {
      const { client, simulated, config } = yield* setUp([supplyTemp], {
        requestTimeout: "150 millis",
        respond: (device, request) =>
          request._tag === "UnconfirmedRequest" && request.service === UnconfirmedService.WhoIs
            ? undefined
            : answer(device, request)
      })
      setPresentValue(simulated, { objectType: "analog-input", instance: 1 }, { type: "real", value: 4.5 })
      const driver = yield* makeBacnetDriverFromClient(config, client)
      expect((yield* driver.readAll).map((reading) => reading.value)).toEqual([4.5])
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
        // The last attempt gets 150 ms, or what is left of the request's 300 ms when the first ran late.
        message: expect.stringMatching(
          /^no answer from 127\.0\.0\.1:\d+ within (150ms$|\d+ms, what was left of its 300ms)/
        )
      })
    })
  )

  it.live("broadcasts Who-Is for a device without an address at most once per backoff", () =>
    Effect.gen(function* () {
      let whoIs = 0
      const { client, config } = yield* setUp([supplyTemp], {
        requestTimeout: "150 millis",
        respond: (_device, request) => {
          if (request._tag === "UnconfirmedRequest" && request.service === UnconfirmedService.WhoIs) whoIs++
          return undefined
        }
      })
      const { address: _address, ...broadcastOnly } = config
      const driver = yield* makeBacnetDriverFromClient(broadcastOnly, client)
      expect(yield* driver.readAll.pipe(Effect.flip)).toMatchObject({
        reason: "timeout",
        message: "device 2001 did not answer Who-Is; asking again in 30 s"
      })
      const sent = whoIs
      // The first attempt and its resend reached the device.
      expect(sent).toBe(2)
      expect(yield* driver.readAll.pipe(Effect.flip)).toMatchObject({ reason: "timeout" })
      expect(whoIs).toBe(sent)
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

const eventually = (condition: () => boolean) =>
  Effect.sync(condition).pipe(
    Effect.repeat({ until: (met) => met, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout("2 seconds")
  )

/** Short COV timing, so subscriptions are made within a test. */
const quickCov = { checkMs: 20, retryMs: 100, renewMs: 10_000, lifetimeSeconds: 60 }

/** Collect what the driver pushes, until the returned fiber is interrupted. */
const collectPushes = (changes: Stream.Stream<Reading> | undefined) =>
  Effect.gen(function* () {
    const pushed: Array<readonly [string, Reading["value"]]> = []
    if (changes === undefined) return { pushed, fiber: undefined }
    const fiber = yield* Stream.runForEach(changes, (reading) =>
      Effect.sync(() => {
        pushed.push([reading.pointId, reading.value])
      })
    ).pipe(Effect.forkChild)
    return { pushed, fiber }
  })

const objectType = point("ai-type", "analog-input", 1, "object-type")

describe("BACnet change of value", () => {
  it.live("subscribes present values, pushes their changes and stops polling them", () =>
    Effect.gen(function* () {
      const { client, simulated, config } = yield* setUp([supplyTemp, fanRunning, objectType])
      const driver = yield* makeBacnetDriverFromClient({ ...config, cov: true }, client, { cov: quickCov })
      // The first cycle finds the device and reads everything; nothing is subscribed yet.
      expect(yield* driver.readAll).toHaveLength(3)
      const { pushed, fiber } = yield* collectPushes(driver.changes)
      // Each subscription starts with a notification of the current value (clause 13.1).
      yield* eventually(() => pushed.length === 2)
      expect(pushed).toEqual([
        ["supply-temp", 0],
        ["fan-running", false]
      ])
      expect(simulated.subscriptions.size).toBe(2)

      setPresentValue(simulated, { objectType: "analog-input", instance: 1 }, { type: "real", value: 30.5 })
      setPresentValue(simulated, { objectType: "binary-output", instance: 2 }, { type: "enumerated", value: 1 })
      yield* eventually(() => pushed.length === 4)
      expect(pushed.slice(2)).toEqual([
        ["supply-temp", 30.5],
        ["fan-running", true]
      ])
      // Only the point no subscription covers is polled now.
      expect((yield* driver.readAll).map((reading) => reading.pointId)).toEqual(["ai-type"])

      // Stopping cancels the subscriptions on the device.
      if (fiber !== undefined) yield* Fiber.interrupt(fiber)
      yield* eventually(() => simulated.subscriptions.size === 0)
    })
  )

  it.live("still reads one point per cycle when every point is pushed", () =>
    Effect.gen(function* () {
      const { client, config } = yield* setUp([supplyTemp])
      const driver = yield* makeBacnetDriverFromClient({ ...config, cov: true }, client, { cov: quickCov })
      yield* driver.readAll
      const { pushed } = yield* collectPushes(driver.changes)
      yield* eventually(() => pushed.length === 1)
      expect((yield* driver.readAll).map((reading) => reading.pointId)).toEqual(["supply-temp"])
    })
  )

  it.live("polls an object the device refuses a subscription for", () =>
    Effect.gen(function* () {
      let subscribes = 0
      const { client, config } = yield* setUp([supplyTemp, fanRunning], {
        respond: (device, request) => {
          if (request._tag === "ConfirmedRequest" && request.service === ConfirmedService.SubscribeCov) {
            subscribes++
            return {
              _tag: "Error",
              invokeId: request.invokeId,
              service: request.service,
              body: encodeErrorBody({
                errorClass: ErrorClass.services,
                errorCode: ErrorCode["optional-functionality-not-supported"]
              })
            }
          }
          return answer(device, request)
        }
      })
      const driver = yield* makeBacnetDriverFromClient({ ...config, cov: true }, client, { cov: quickCov })
      yield* driver.readAll
      const { pushed } = yield* collectPushes(driver.changes)
      yield* eventually(() => subscribes === 2)
      // Several checks later the refusals were not repeated: they are retried after an hour.
      yield* Effect.sleep("100 millis")
      expect(subscribes).toBe(2)
      expect(pushed).toEqual([])
      expect(yield* driver.readAll).toHaveLength(2)
    })
  )

  it.live("leaves a device alone when change of value is off", () =>
    Effect.gen(function* () {
      const { client, config } = yield* setUp([supplyTemp])
      const driver = yield* makeBacnetDriverFromClient(config, client, { cov: quickCov })
      expect(driver.changes).toBeUndefined()
    })
  )
})
