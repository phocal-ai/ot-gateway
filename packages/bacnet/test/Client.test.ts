/**
 * The BACnet/IP client over real UDP on loopback, against simulated devices
 * and against hand-written peers that drop, delay or misdirect answers.
 */
import { NodeDatagramSocket } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { driverRequests, withMetricAttributes } from "@plenum/core"
import { Effect, Exit, Metric, Result } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import type * as DatagramSocket from "effect/socket/DatagramSocket"
import {
  type Apdu,
  type BacnetClientOptions,
  decodeFrame,
  encodeFrame,
  ErrorCode,
  makeBacnetClient,
  makeSimulatedDevice,
  ObjectType,
  PropertyId,
  serveSimulatedDevice,
  setPresentValue
} from "../src/index.ts"

const loopback = { address: "127.0.0.1", port: 0 }

const makeDevice = (instance = 1001, maxApdu?: number) =>
  makeSimulatedDevice({
    instance,
    name: `device-${instance}`,
    vendorId: 260,
    ...(maxApdu === undefined ? {} : { maxApdu }),
    objects: [
      { objectType: "analog-input", instance: 1, name: "supply-temp", presentValue: { type: "real", value: 18.5 } },
      { objectType: "binary-output", instance: 2, name: "fan", presentValue: { type: "enumerated", value: 1 } }
    ]
  })

const supplyTemp = { objectType: ObjectType["analog-input"], instance: 1 }
const fan = { objectType: ObjectType["binary-output"], instance: 2 }
const presentValue = PropertyId["present-value"]

/** A simulated device on a free loopback port. */
const startDevice = Effect.fnUntraced(function* (device = makeDevice()) {
  const socket = yield* NodeDatagramSocket.make({ bind: loopback })
  const address = yield* serveSimulatedDevice(socket, device)
  return { device, target: { address } }
})

/** A client on a free loopback port with short timeouts; "broadcast" goes to `broadcastAddress`. */
const startClient = Effect.fnUntraced(function* (
  broadcastAddress: NetAddress.InetAddress,
  options: Partial<BacnetClientOptions> = {}
) {
  const socket = yield* NodeDatagramSocket.make({ bind: loopback })
  return yield* makeBacnetClient(socket, { broadcastAddress, requestTimeout: "150 millis", retries: 1, ...options })
})

/**
 * A peer that decodes each request and lets `respond` decide what to send
 * back, and from which socket. Returns its address and the invoke IDs it saw.
 */
const startPeer = Effect.fnUntraced(function* (
  respond: (request: Apdu, count: number) => { readonly apdu: Apdu; readonly via?: "other-socket" } | undefined
) {
  const socket = yield* NodeDatagramSocket.make({ bind: loopback })
  const reader = yield* socket.reader
  const writer = yield* socket.writer
  const other = yield* NodeDatagramSocket.make({ bind: loopback })
  yield* other.reader
  const otherWriter = yield* other.writer
  const invokeIds: Array<number> = []
  const handle = (datagram: DatagramSocket.Datagram) => {
    const frame = decodeFrame(datagram.payload)
    if (Result.isFailure(frame) || frame.success?.apdu._tag !== "ConfirmedRequest") return Effect.void
    invokeIds.push(frame.success.apdu.invokeId)
    const response = respond(frame.success.apdu, invokeIds.length)
    if (response === undefined) return Effect.void
    const payload = encodeFrame(response.apdu)
    return response.via === "other-socket"
      ? otherWriter.write({ payload, address: datagram.address })
      : writer.write({ payload, address: datagram })
  }
  yield* Effect.forever(Effect.flatMap(reader.pull, (datagrams) => Effect.forEach(datagrams, handle))).pipe(
    Effect.forkScoped
  )
  return { target: { address: reader.address }, invokeIds }
})

/** A ReadProperty answer carrying `value` as present value. */
const presentValueAck = (request: Apdu, value: number): Apdu => ({
  _tag: "ComplexAck",
  invokeId: request._tag === "ConfirmedRequest" ? request.invokeId : 0,
  service: 12,
  // AI:1 present-value = real `value`
  body: Uint8Array.of(
    0x0c,
    0,
    0,
    0,
    1,
    0x19,
    0x55,
    0x3e,
    0x44,
    ...new Uint8Array(Float32Array.of(value).buffer).toReversed(),
    0x3f
  )
})

const countOf = (outcome: string) =>
  Metric.value(Metric.withAttributes(driverRequests, { device: "bacnet-test", outcome })).pipe(
    Effect.map((state) => state.count)
  )

describe("BACnet/IP client", () => {
  it.live("reads properties from a simulated device", () =>
    Effect.gen(function* () {
      const { device, target } = yield* startDevice()
      const client = yield* startClient(target.address)
      expect(yield* client.readProperty(target, { object: supplyTemp, property: presentValue })).toEqual([
        { type: "real", value: 18.5 }
      ])
      setPresentValue(device, { objectType: "analog-input", instance: 1 }, { type: "real", value: 21 })
      const results = yield* client.readPropertyMultiple(target, [
        { object: supplyTemp, properties: [{ property: presentValue }] },
        { object: fan, properties: [{ property: presentValue }, { property: PropertyId["object-name"] }] }
      ])
      expect(results.flatMap((result) => result.results)).toEqual([
        { property: presentValue, _tag: "Value", values: [{ type: "real", value: 21 }] },
        { property: presentValue, _tag: "Value", values: [{ type: "enumerated", value: 1 }] },
        { property: PropertyId["object-name"], _tag: "Value", values: [{ type: "character-string", value: "fan" }] }
      ])
    })
  )

  it.live("keeps concurrent requests apart by invoke ID", () =>
    Effect.gen(function* () {
      const { target } = yield* startDevice()
      const client = yield* startClient(target.address)
      const reads = Array.from({ length: 40 }, (_, index) =>
        index % 2 === 0
          ? client.readProperty(target, { object: supplyTemp, property: presentValue })
          : client.readProperty(target, { object: fan, property: PropertyId["object-name"] })
      )
      const values = yield* Effect.all(reads, { concurrency: "unbounded" })
      values.forEach((value, index) =>
        expect(value).toEqual(
          index % 2 === 0 ? [{ type: "real", value: 18.5 }] : [{ type: "character-string", value: "fan" }]
        )
      )
    })
  )

  it.live("fails with the device's error class and code, and counts it", () =>
    Effect.gen(function* () {
      const { target } = yield* startDevice()
      const client = yield* startClient(target.address)
      const exit = yield* client
        .readProperty(target, { object: supplyTemp, property: PropertyId["cov-increment"] })
        .pipe(withMetricAttributes({ device: "bacnet-test" }), Effect.exit)
      expect(exit).toEqual(
        Exit.fail(
          expect.objectContaining({
            _tag: "BacnetDeviceError",
            kind: "error",
            code: ErrorCode["unknown-property"],
            message: "property: unknown-property"
          })
        )
      )
      expect(yield* countOf("exception")).toBe(1)
    })
  )

  it.live("reports an abort when the answer would need segmentation", () =>
    Effect.gen(function* () {
      const { target } = yield* startDevice(makeDevice(1001, 128))
      const client = yield* startClient(target.address)
      const error = yield* client
        .readPropertyMultiple(target, [
          { object: { objectType: ObjectType.device, instance: 1001 }, properties: [{ property: PropertyId.all }] }
        ])
        .pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "BacnetDeviceError",
        kind: "abort",
        message: "aborted: SegmentationNotSupported"
      })
    })
  )

  it.live("discovers a device with Who-Is and locates one by instance", () =>
    Effect.gen(function* () {
      const { target } = yield* startDevice()
      const client = yield* startClient(target.address)
      const found = yield* client.discover()
      expect(found).toHaveLength(1)
      expect(found[0]).toMatchObject({ instance: 1001, maxApdu: 1476, segmentation: 3, vendorId: 260 })
      expect(found[0] === undefined ? "" : NetAddress.formatInet(found[0].address)).toBe(
        NetAddress.formatInet(target.address)
      )
      expect(yield* client.discover({ range: { low: 2000, high: 3000 } })).toEqual([])
      expect(yield* client.locate(1001)).toMatchObject({ instance: 1001 })
      expect(yield* client.locate(1002).pipe(Effect.flip)).toMatchObject({
        _tag: "BacnetTimeout",
        message: "device 1002 did not answer Who-Is within 150ms"
      })
    })
  )

  it.live("resends a request that got no answer, with the same invoke ID", () =>
    Effect.gen(function* () {
      const peer = yield* startPeer((request, count) =>
        count === 1 ? undefined : { apdu: presentValueAck(request, 19.5) }
      )
      const client = yield* startClient(peer.target.address)
      const values = yield* client
        .readProperty(peer.target, { object: supplyTemp, property: presentValue })
        .pipe(withMetricAttributes({ device: "bacnet-test" }))
      expect(values).toEqual([{ type: "real", value: 19.5 }])
      expect(peer.invokeIds).toHaveLength(2)
      expect(new Set(peer.invokeIds).size).toBe(1)
      expect(yield* countOf("timeout")).toBe(1)
      expect(yield* countOf("ok")).toBe(1)
    })
  )

  it.live("gives up after the retries", () =>
    Effect.gen(function* () {
      const peer = yield* startPeer(() => undefined)
      const client = yield* startClient(peer.target.address, { retries: 2 })
      const error = yield* client
        .readProperty(peer.target, { object: supplyTemp, property: presentValue })
        .pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "BacnetTimeout" })
      expect(peer.invokeIds).toHaveLength(3)
    })
  )

  it.live("ignores an answer that comes from another address", () =>
    Effect.gen(function* () {
      const peer = yield* startPeer((request) => ({ apdu: presentValueAck(request, 1), via: "other-socket" }))
      const client = yield* startClient(peer.target.address, { retries: 0 })
      const error = yield* client
        .readProperty(peer.target, { object: supplyTemp, property: presentValue })
        .pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "BacnetTimeout" })
    })
  )

  it.live("treats a segmented answer as invalid, since it asked for none", () =>
    Effect.gen(function* () {
      const peer = yield* startPeer((request) => ({
        apdu: {
          _tag: "ComplexAck",
          invokeId: request._tag === "ConfirmedRequest" ? request.invokeId : 0,
          service: 12,
          segment: { sequenceNumber: 0, moreFollows: true, windowSize: 1 },
          body: new Uint8Array(0)
        }
      }))
      const client = yield* startClient(peer.target.address)
      const error = yield* client
        .readProperty(peer.target, { object: supplyTemp, property: presentValue })
        .pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "BacnetCodecError" })
    })
  )
})
