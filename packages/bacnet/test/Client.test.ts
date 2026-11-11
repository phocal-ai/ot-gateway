/**
 * The BACnet/IP client over real UDP on loopback, against simulated devices
 * and against hand-written peers that drop, delay or misdirect answers;
 * discovery with several devices on one broadcast, on an in-memory network.
 */
import * as NodeDatagramSocket from "@effect/platform-node/NodeDatagramSocket"
import { describe, expect, it } from "@effect/vitest"
import { driverRequests, makeMemoryNetwork, type MemoryNetwork, withMetricAttributes } from "@ot-gateway/core"
import { Effect, Exit, Fiber, Metric, Queue, Result, Schedule } from "effect"
import { TestClock } from "effect/testing"
import * as NetAddress from "effect/net/NetAddress"
import type * as DatagramSocket from "effect/socket/DatagramSocket"

import {
  type Apdu,
  type BacnetClientOptions,
  checkReadPropertyMultipleAck,
  type CovNotification,
  decodeFrame,
  type DeviceAddress,
  type DiscoveredDevice,
  encodeIAm,
  encodeFrame,
  ErrorCode,
  makeBacnetClient,
  makeDiscoveryCollector,
  makeSimulatedDevice,
  MAX_CONFLICTS,
  MAX_DEVICES,
  type NetworkAddress,
  ObjectType,
  PropertyId,
  serveSimulatedDevice,
  setPresentValue,
  UnconfirmedService
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

/**
 * A client on a free loopback port; "broadcast" goes to `broadcastAddress`.
 * The 1 s timeout is for requests that get an answer; tests that expect a
 * timeout pass a short one.
 */
const startClient = Effect.fnUntraced(function* (
  broadcastAddress: NetAddress.InetAddress,
  options: Partial<BacnetClientOptions> = {}
) {
  const socket = yield* NodeDatagramSocket.make({ bind: loopback })
  return yield* makeBacnetClient(socket, { broadcastAddress, requestTimeout: "1 second", retries: 1, ...options })
})

const short = { requestTimeout: "150 millis" } as const

/** What a peer sends back for one request: an answer, maybe from another socket, maybe after some other datagrams. */
interface PeerResponse {
  readonly apdu: Apdu
  readonly via?: "other-socket"
  readonly before?: ReadonlyArray<Uint8Array>
}

/**
 * A peer that decodes each request and lets `respond` decide what to send
 * back, and from which socket. Returns its address, the invoke IDs of the
 * confirmed requests and every APDU it received.
 */
const startPeer = Effect.fnUntraced(function* (respond: (request: Apdu, count: number) => PeerResponse | undefined) {
  const socket = yield* NodeDatagramSocket.make({ bind: loopback })
  const reader = yield* socket.reader
  const writer = yield* socket.writer
  const other = yield* NodeDatagramSocket.make({ bind: loopback })
  yield* other.reader
  const otherWriter = yield* other.writer
  const invokeIds: Array<number> = []
  const seen: Array<Apdu> = []
  const handle = (datagram: DatagramSocket.Datagram) => {
    const frame = decodeFrame(datagram.payload)
    if (Result.isFailure(frame) || frame.success === undefined) return Effect.void
    seen.push(frame.success.apdu)
    if (frame.success.apdu._tag !== "ConfirmedRequest") return Effect.void
    invokeIds.push(frame.success.apdu.invokeId)
    const response = respond(frame.success.apdu, invokeIds.length)
    if (response === undefined) return Effect.void
    const payload = encodeFrame(response.apdu)
    return Effect.forEach(response.before ?? [], (junk) => writer.write({ payload: junk, address: datagram })).pipe(
      Effect.andThen(
        response.via === "other-socket"
          ? otherWriter.write({ payload, address: datagram.address })
          : writer.write({ payload, address: datagram })
      )
    )
  }
  yield* Effect.forever(Effect.flatMap(reader.pull, (datagrams) => Effect.forEach(datagrams, handle))).pipe(
    Effect.forkScoped
  )
  return { target: { address: reader.address }, invokeIds, seen }
})

const invokeIdOf = (request: Apdu) => (request._tag === "ConfirmedRequest" ? request.invokeId : 0)

/** A ReadProperty answer carrying `value` as present value. */
const presentValueAck = (request: Apdu, value: number): Apdu => ({
  _tag: "ComplexAck",
  invokeId: invokeIdOf(request),
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

/** Requests counted under `device`; each test uses its own, so the counts do not add up across tests. */
const countOf = (device: string, outcome: string) =>
  Metric.value(Metric.withAttributes(driverRequests, { device, outcome })).pipe(Effect.map((state) => state.count))

/** Wait up to 1 s for `condition`, for effects that happen after the call under test returned. */
const eventually = (condition: () => boolean) =>
  Effect.sync(condition).pipe(
    Effect.repeat({ until: (met) => met, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout("1 second")
  )

/** An I-Am frame for instance 7 with `objectType` in place of the device type. */
const iAm = (objectType: number) =>
  encodeFrame({
    _tag: "UnconfirmedRequest",
    service: UnconfirmedService.IAm,
    body: encodeIAm({ device: { objectType, instance: 7 }, maxApdu: 480, segmentation: 3, vendorId: 1 })
  })

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
        .pipe(withMetricAttributes({ device: "bacnet-error" }), Effect.exit)
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
      expect(yield* countOf("bacnet-error", "exception")).toBe(1)
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
      const client = yield* startClient(target.address, short)
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
        message: "device 1002 did not answer Who-Is within 150 ms"
      })
    })
  )

  it.live("locates a device at a given address only by an I-Am from that address", () =>
    Effect.gen(function* () {
      const { target } = yield* startDevice()
      const silent = yield* startPeer(() => undefined)
      const client = yield* startClient(target.address, { ...short, retries: 0 })
      // While the client waits for 1001 at the silent address, the real 1001 answers a broadcast from elsewhere.
      const [located] = yield* Effect.all(
        [client.locate(1001, { target: silent.target }).pipe(Effect.flip), client.discover()],
        { concurrency: "unbounded" }
      )
      expect(located).toMatchObject({ _tag: "BacnetTimeout" })
    })
  )

  it.live("resends a request that got no answer, with the same invoke ID", () =>
    Effect.gen(function* () {
      const peer = yield* startPeer((request, count) =>
        count === 1 ? undefined : { apdu: presentValueAck(request, 19.5) }
      )
      const client = yield* startClient(peer.target.address, short)
      const values = yield* client
        .readProperty(peer.target, { object: supplyTemp, property: presentValue })
        .pipe(withMetricAttributes({ device: "bacnet-resend" }))
      expect(values).toEqual([{ type: "real", value: 19.5 }])
      expect(peer.invokeIds).toHaveLength(2)
      expect(new Set(peer.invokeIds).size).toBe(1)
      // A request counts once, by how it ended.
      expect(yield* countOf("bacnet-resend", "timeout")).toBe(0)
      expect(yield* countOf("bacnet-resend", "ok")).toBe(1)
    })
  )

  it.live("gives up after the retries", () =>
    Effect.gen(function* () {
      const peer = yield* startPeer(() => undefined)
      const client = yield* startClient(peer.target.address, { ...short, retries: 2 })
      const error = yield* client
        .readProperty(peer.target, { object: supplyTemp, property: presentValue })
        .pipe(withMetricAttributes({ device: "bacnet-give-up" }), Effect.flip)
      expect(error).toMatchObject({ _tag: "BacnetTimeout" })
      expect(peer.invokeIds).toHaveLength(3)
      expect(yield* countOf("bacnet-give-up", "timeout")).toBe(1)
    })
  )

  it.live("ignores an answer that comes from another address", () =>
    Effect.gen(function* () {
      const peer = yield* startPeer((request) => ({ apdu: presentValueAck(request, 1), via: "other-socket" }))
      const client = yield* startClient(peer.target.address, { ...short, retries: 0 })
      const error = yield* client
        .readProperty(peer.target, { object: supplyTemp, property: presentValue })
        .pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "BacnetTimeout" })
    })
  )

  it.live("treats a segmented answer as one that did not fit, since it asked for none", () =>
    Effect.gen(function* () {
      const peer = yield* startPeer((request) => ({
        apdu: {
          _tag: "ComplexAck",
          invokeId: invokeIdOf(request),
          service: 12,
          segment: { sequenceNumber: 0, moreFollows: true, windowSize: 1 },
          body: new Uint8Array(0)
        }
      }))
      const client = yield* startClient(peer.target.address)
      const error = yield* client
        .readProperty(peer.target, { object: supplyTemp, property: presentValue })
        .pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "BacnetDeviceError", kind: "abort", code: 4 })
      // The device waits for a SegmentAck; the client ends the transaction instead.
      yield* eventually(() => peer.seen.some((apdu) => apdu._tag === "Abort"))
      expect(peer.seen.find((apdu) => apdu._tag === "Abort")).toMatchObject({
        invokeId: peer.invokeIds[0],
        fromServer: false,
        reason: 4
      })
    })
  )

  it.live("drops datagrams it cannot use and still takes the answer after them", () =>
    Effect.gen(function* () {
      const peer = yield* startPeer((request) => ({
        apdu: presentValueAck(request, 3.5),
        before: [
          Uint8Array.of(0x81, 0x0a, 0x00, 0x05, 0xff),
          iAm(ObjectType["analog-input"]),
          iAm(ObjectType.device).subarray(0, 9),
          // An Abort from a client, and an answer from a device behind a router: neither is for this request.
          encodeFrame({ _tag: "Abort", invokeId: invokeIdOf(request), reason: 0, fromServer: false }),
          encodeFrame(presentValueAck(request, 99), { source: { network: 5, address: Uint8Array.of(9) } })
        ]
      }))
      const client = yield* startClient(peer.target.address, { retries: 0 })
      const read = client.readProperty(peer.target, { object: supplyTemp, property: presentValue })
      expect(yield* read).toEqual([{ type: "real", value: 3.5 }])
      expect(yield* read).toEqual([{ type: "real", value: 3.5 }])
    })
  )

  it.live("reaches a device behind a router by its network address, and only takes its answer", () =>
    Effect.gen(function* () {
      const { target } = yield* startDevice()
      const routed = { address: target.address, network: { network: 5, address: Uint8Array.of(7) } }
      const client = yield* startClient(target.address)
      expect(yield* client.readProperty(routed, { object: supplyTemp, property: presentValue })).toEqual([
        { type: "real", value: 18.5 }
      ])
      // This peer answers as the router itself, without the device's network address.
      const peer = yield* startPeer((request) => ({ apdu: presentValueAck(request, 1) }))
      const strict = yield* startClient(peer.target.address, { ...short, retries: 0 })
      const error = yield* strict
        .readProperty({ ...routed, address: peer.target.address }, { object: supplyTemp, property: presentValue })
        .pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "BacnetTimeout" })
    })
  )

  it.live("refuses an answer about another object than was asked", () =>
    Effect.gen(function* () {
      const peer = yield* startPeer((request) => ({ apdu: presentValueAck(request, 1) }))
      const client = yield* startClient(peer.target.address)
      const error = yield* client.readProperty(peer.target, { object: fan, property: presentValue }).pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "BacnetCodecError",
        message: "answer is for another object or property than was asked"
      })
    })
  )

  it.live("rests the invoke ID of a request it gave up on before using it again", () =>
    Effect.gen(function* () {
      const peer = yield* startPeer((request, count) =>
        count === 1 ? undefined : { apdu: presentValueAck(request, 1) }
      )
      // 255 requests at once on a loaded CI runner need more than the usual short timeout;
      // the ID still rests for 10 s, far longer than the test.
      const client = yield* startClient(peer.target.address, { requestTimeout: "1 second", retries: 0 })
      const read = client.readProperty(peer.target, { object: supplyTemp, property: presentValue })
      expect(yield* read.pipe(Effect.flip)).toMatchObject({ _tag: "BacnetTimeout" })
      // Use up every other ID once, so the next request comes round to the first one again. Only the IDs the peer
      // sees matter here: one of these that times out on a loaded runner has still taken its ID, so its outcome is
      // ignored rather than failing the test.
      yield* Effect.all(
        Array.from({ length: 255 }, () => Effect.ignore(read)),
        { concurrency: "unbounded" }
      )
      yield* read
      expect(peer.invokeIds[0]).toBe(0)
      expect(peer.invokeIds.at(-1)).not.toBe(0)
    })
  )

  it.live("broadcasts Who-Is to every BACnet network", () =>
    Effect.gen(function* () {
      const listener = yield* NodeDatagramSocket.make({ bind: loopback })
      const reader = yield* listener.reader
      const client = yield* startClient(reader.address, { requestTimeout: "20 millis" })
      yield* client.discover()
      const [datagram] = yield* reader.pull
      const frame = decodeFrame(datagram?.payload ?? new Uint8Array(0))
      expect(frame).toMatchObject(
        Result.succeed({
          apdu: { _tag: "UnconfirmedRequest", service: UnconfirmedService.WhoIs },
          destination: { network: 0xffff, address: new Uint8Array(0) }
        })
      )
    })
  )
})

/** A property result with no values, for checking answers against requests. */
const emptyValue = (property: number) => ({ property, _tag: "Value" as const, values: [] })

describe("COV subscriptions", () => {
  it.live("gets a notification on subscribing and on every change, until cancelled", () =>
    Effect.gen(function* () {
      const { device, target } = yield* startDevice()
      const client = yield* startClient(target.address)
      const processId = yield* client.newProcessId
      const received = yield* Queue.unbounded<CovNotification>()
      yield* client.onCovNotification(processId, (notification) => {
        Queue.offerUnsafe(received, notification)
      })
      yield* client.subscribeCov(target, { processId, object: supplyTemp, confirmed: false, lifetime: 60 })
      const first = yield* Queue.take(received).pipe(Effect.timeout("1 second"))
      expect(first).toMatchObject({
        processId,
        initiatingDevice: { objectType: ObjectType.device, instance: 1001 },
        object: supplyTemp,
        values: [{ property: presentValue, values: [{ type: "real", value: 18.5 }] }, { property: 111 }]
      })
      expect(first.timeRemaining).toBeGreaterThan(55)
      setPresentValue(device, { objectType: "analog-input", instance: 1 }, { type: "real", value: 19 })
      expect(yield* Queue.take(received).pipe(Effect.timeout("1 second"))).toMatchObject({
        values: [{ property: presentValue, values: [{ type: "real", value: 19 }] }, { property: 111 }]
      })
      yield* client.subscribeCov(target, { processId, object: supplyTemp })
      setPresentValue(device, { objectType: "analog-input", instance: 1 }, { type: "real", value: 20 })
      expect(yield* Queue.take(received).pipe(Effect.timeout("200 millis"), Effect.option)).toEqual(
        expect.objectContaining({ _tag: "None" })
      )
    })
  )

  it.live("hands out distinct process identifiers and refuses objects without a present value", () =>
    Effect.gen(function* () {
      const { target } = yield* startDevice()
      const client = yield* startClient(target.address)
      const ids = yield* Effect.all([client.newProcessId, client.newProcessId])
      expect(new Set(ids).size).toBe(2)
      const error = yield* client
        .subscribeCov(target, {
          processId: 1,
          object: { objectType: ObjectType.device, instance: 1001 },
          confirmed: false,
          lifetime: 60
        })
        .pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "BacnetDeviceError",
        kind: "error",
        message: "object: optional-functionality-not-supported"
      })
    })
  )
})

describe("ReadPropertyMultiple answers", () => {
  const asked = [{ object: supplyTemp, properties: [{ property: presentValue }] }]

  it("accepts the objects and properties that were asked for, expanded or by wildcard", () => {
    const answer = [{ object: supplyTemp, results: [emptyValue(presentValue)] }]
    expect(checkReadPropertyMultipleAck(asked, answer)).toEqual(Result.succeed(answer))
    const all = [{ object: supplyTemp, properties: [{ property: PropertyId.all }] }]
    const expanded = [
      { object: supplyTemp, results: [emptyValue(presentValue), emptyValue(PropertyId["object-name"])] }
    ]
    expect(Result.isSuccess(checkReadPropertyMultipleAck(all, expanded))).toBe(true)
    const wildcard = [
      { object: { objectType: ObjectType.device, instance: 4_194_303 }, properties: [{ property: 75 }] }
    ]
    const device = [{ object: { objectType: ObjectType.device, instance: 1001 }, results: [emptyValue(75)] }]
    expect(Result.isSuccess(checkReadPropertyMultipleAck(wildcard, device))).toBe(true)
  })

  it("refuses other objects, other properties or a different count", () => {
    const failures = [
      [],
      [{ object: fan, results: [emptyValue(presentValue)] }],
      [{ object: supplyTemp, results: [emptyValue(PropertyId["object-name"])] }],
      [{ object: supplyTemp, results: [emptyValue(presentValue), emptyValue(presentValue)] }]
    ].map((answer) => checkReadPropertyMultipleAck(asked, answer))
    expect(failures.every(Result.isFailure)).toBe(true)
  })
})

const at = (ip: string) => NetAddress.inetAddressFromIpStringUnsafe(ip, 47_808)

/** An I-Am for `instance`, from a device behind a router when `source` is given. */
const iAmFrame = (instance: number, source?: NetworkAddress) =>
  encodeFrame(
    {
      _tag: "UnconfirmedRequest",
      service: UnconfirmedService.IAm,
      body: encodeIAm({
        device: { objectType: ObjectType.device, instance },
        maxApdu: 480,
        segmentation: 3,
        vendorId: 1
      })
    },
    source === undefined ? {} : { source }
  )

const routed = (network: number, mac: number): NetworkAddress => ({ network, address: new Uint8Array([mac]) })

/** Sent after the test's frames: once the client has located it, it has read every frame before it. */
const SENTINEL = 4_000_000

/**
 * Discover from 10.0.0.1 on `network`, under the test clock, while a peer at
 * 10.0.2.9 (a device, or a router for the devices behind it) sends the
 * client `frames`. The window closes only after the client has read them.
 */
const discoverHearing = Effect.fnUntraced(function* (network: MemoryNetwork, frames: ReadonlyArray<Uint8Array>) {
  const peer = yield* network.host("10.0.2.9").udp({ address: "10.0.2.9", port: 47_808 })
  yield* peer.reader
  const peerWriter = yield* peer.writer
  const socket = yield* network.host("10.0.0.1").udp({ address: "10.0.0.1", port: 47_808 })
  const client = yield* makeBacnetClient(socket, {
    broadcastAddress: at("255.255.255.255"),
    requestTimeout: "1 second"
  })
  const discovering = yield* client.discover({ within: "1 second" }).pipe(Effect.forkChild)
  const located = yield* client.locate(SENTINEL).pipe(Effect.forkChild)
  yield* TestClock.adjust("10 millis")
  yield* Effect.forEach([...frames, iAmFrame(SENTINEL)], (payload) =>
    peerWriter.write({ payload, address: at("10.0.0.1") })
  )
  yield* Fiber.join(located)
  yield* TestClock.adjust("1 second")
  const found = yield* Fiber.join(discovering)
  return found.filter((device) => device.instance !== SENTINEL)
})

const sourceOf = (source: DeviceAddress) => ({ at: NetAddress.formatInet(source.address), network: source.network })

describe("discover on an in-memory network", () => {
  it.effect("keeps every other address that answered for an instance, and an answer resent from one only once", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      const serve = (ip: string, instance: number) =>
        Effect.flatMap(network.host(ip).udp({ address: ip, port: 47_808 }), (socket) =>
          serveSimulatedDevice(socket, makeDevice(instance))
        )
      yield* serve("10.0.2.1", 2001)
      yield* serve("10.0.2.2", 2001)
      yield* serve("10.0.2.3", 3001)
      // 4001 says I-Am twice from one address, as a device does when it hears Who-Is twice.
      const found = yield* discoverHearing(network, [iAmFrame(4001), iAmFrame(4001)])

      const byInstance = new Map(found.map((device) => [device.instance, device]))
      expect([...byInstance.keys()].toSorted((left, right) => left - right)).toEqual([2001, 3001, 4001])
      const claimed = byInstance.get(2001)
      const sources = claimed === undefined ? [] : [claimed, ...claimed.conflicts]
      expect(sources.map((source) => NetAddress.formatInet(source.address)).toSorted()).toEqual([
        "10.0.2.1:47808",
        "10.0.2.2:47808"
      ])
      expect(byInstance.get(3001)?.conflicts).toEqual([])
      expect(byInstance.get(4001)?.conflicts).toEqual([])
    }).pipe(Effect.scoped)
  )

  it.effect("tells sources behind one router apart by network and address there", () =>
    Effect.gen(function* () {
      const found = yield* discoverHearing(makeMemoryNetwork(), [
        iAmFrame(5001, routed(5, 7)),
        iAmFrame(5001, routed(5, 7)),
        iAmFrame(5001, routed(5, 8)),
        iAmFrame(5001, routed(6, 7)),
        iAmFrame(5001)
      ])
      expect(found).toHaveLength(1)
      const [device] = found
      expect(device === undefined ? undefined : sourceOf(device)).toEqual({
        at: "10.0.2.9:47808",
        network: routed(5, 7)
      })
      expect(device?.conflicts.map(sourceOf)).toEqual([
        { at: "10.0.2.9:47808", network: routed(5, 8) },
        { at: "10.0.2.9:47808", network: routed(6, 7) },
        { at: "10.0.2.9:47808", network: undefined }
      ])
    }).pipe(Effect.scoped)
  )
})

/** An I-Am as the client hands it to the collector: from 10.0.2.9, or from behind it as a router. */
const answer = (instance: number, mac?: number): DiscoveredDevice => ({
  instance,
  address: at("10.0.2.9"),
  ...(mac === undefined ? {} : { network: routed(5, mac) }),
  maxApdu: 480,
  segmentation: 3,
  vendorId: 1
})

describe("makeDiscoveryCollector", () => {
  it("keeps the first instances up to its device limit, and other sources up to its conflict limit", () => {
    const collector = makeDiscoveryCollector({ maxDevices: 4, maxConflicts: 2 })
    for (const mac of [1, 2, 3, 4]) collector.add(answer(6001, mac))
    for (const instance of [7001, 7002, 7003, 7004, 7005]) collector.add(answer(instance))
    // An instance already kept still collects sources once the device limit is reached.
    collector.add(answer(7001, 9))
    const devices = collector.devices()
    expect(devices.map((device) => device.instance)).toEqual([6001, 7001, 7002, 7003])
    expect(devices[0]?.network).toEqual(routed(5, 1))
    expect(devices[0]?.conflicts.map((source) => source.network)).toEqual([routed(5, 2), routed(5, 3)])
    expect(devices[1]?.conflicts.map((source) => source.network)).toEqual([routed(5, 9)])
  })

  it("defaults to MAX_DEVICES instances and MAX_CONFLICTS other sources", () => {
    expect([MAX_DEVICES, MAX_CONFLICTS]).toEqual([4_096, 16])
    const collector = makeDiscoveryCollector()
    for (let mac = 0; mac < MAX_CONFLICTS + 3; mac++) collector.add(answer(6001, mac))
    for (let instance = 0; instance < MAX_DEVICES + 3; instance++) collector.add(answer(10_000 + instance))
    const devices = collector.devices()
    expect(devices).toHaveLength(MAX_DEVICES)
    expect(devices[0]?.conflicts).toHaveLength(MAX_CONFLICTS)
  })
})
