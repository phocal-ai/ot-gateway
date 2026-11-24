/**
 * Chaos: the real client over loopback UDP (free ports only), against a
 * third host that forges BBMD-forwarded answers and notifications, floods
 * I-Am, or crowds out the invoke IDs.
 */
import * as NodeDatagramSocket from "@effect/platform-node/NodeDatagramSocket"
import { describe, expect, it } from "@effect/vitest"
import type { BacnetDevice, BacnetSettings } from "@ot-gateway/core"
import { Effect, Fiber, Result, Schedule, Stream } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import { captureLogs } from "./scripted.ts"
import {
  type Apdu,
  type BacnetClientOptions,
  BvlcFunction,
  encodeBvlc,
  encodeCovNotification,
  encodeFrame,
  encodeIAm,
  encodeReadPropertyAck,
  makeBacnetClient,
  makeBacnetDriverFromClient,
  makeBacnetNetwork,
  makeSimulatedDevice,
  ObjectType,
  PropertyId,
  serveSimulatedDevice,
  UnconfirmedService
} from "../../src/index.ts"

const loopback = { address: "127.0.0.1", port: 0 }
const nowhere = NetAddress.inetAddressUnsafe(NetAddress.ipv4FromBytesUnsafe(Uint8Array.of(127, 0, 0, 1)), 9)
const analogInput1 = { objectType: ObjectType["analog-input"], instance: 1 }

/** Wrap a frame as a BBMD's Forwarded-NPDU naming `origin` as its sender (Annex J.2.5). */
const forwarded = (apdu: Apdu, origin: NetAddress.InetAddress) => {
  const npdu = encodeFrame(apdu).subarray(4)
  const ip = NetAddress.isIpv4Address(origin.address) ? NetAddress.ipv4ToOctets(origin.address) : [127, 0, 0, 1]
  return encodeBvlc(BvlcFunction.ForwardedNpdu, Uint8Array.from([...ip, origin.port >> 8, origin.port & 0xff, ...npdu]))
}

const startClient = Effect.fnUntraced(function* (options: Partial<BacnetClientOptions> = {}) {
  const socket = yield* NodeDatagramSocket.make({ bind: loopback })
  return yield* makeBacnetClient(socket, {
    broadcastAddress: nowhere,
    requestTimeout: "500 millis",
    retries: 1,
    ...options
  })
})

/** A socket that receives and can send; its reader's address is where it listens. */
const peer = Effect.fnUntraced(function* () {
  const socket = yield* NodeDatagramSocket.make({ bind: loopback })
  const reader = yield* socket.reader
  const writer = yield* socket.writer
  return { reader, writer, address: reader.address }
})

/** A present-value answer of 666 for every invoke ID, forwarded in the name of `device`. */
const forgedAnswers = (device: NetAddress.InetAddress) =>
  Array.from({ length: 256 }, (_, invokeId) =>
    forwarded(
      {
        _tag: "ComplexAck",
        invokeId,
        service: 12,
        body: encodeReadPropertyAck({
          object: analogInput1,
          property: PropertyId["present-value"],
          values: [{ type: "real", value: 666 }]
        })
      },
      device
    )
  )

/** Read AI 1 from a device that never answers, while `sender` sends forged answers to the client. */
const readWhileForging = Effect.fnUntraced(function* (options: Partial<BacnetClientOptions>, sender: "third" | "bbmd") {
  const silent = yield* peer()
  const third = yield* peer()
  const client = yield* startClient(sender === "bbmd" ? { ...options, bbmdAddress: third.address } : options)
  const read = yield* client
    .readProperty({ address: silent.address }, { object: analogInput1, property: PropertyId["present-value"] })
    .pipe(Effect.result, Effect.forkScoped)
  // The request tells the silent device where the client is; the forger only needs that address.
  const [request] = yield* silent.reader.pull
  if (request === undefined) return yield* Effect.die("no request")
  for (const payload of forgedAnswers(silent.address)) yield* third.writer.write({ address: request.address, payload })
  return yield* Fiber.join(read)
})

describe("chaos: client over UDP", () => {
  it.live("drops an answer a third host forwards in the device's name", () =>
    Effect.gen(function* () {
      const result = yield* readWhileForging({}, "third")
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "BacnetTimeout" } })
    }).pipe(Effect.scoped)
  )

  it.live("warns once about a host forwarding without being the BBMD, however often it sends", () => {
    const logs = captureLogs()
    return Effect.gen(function* () {
      yield* readWhileForging({}, "third")
      const warnings = logs.lines.filter((line) => line.level === "Warn" && line.message.includes("Forwarded-NPDU"))
      expect(warnings).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(logs.layer))
  })

  it.live("takes an answer the configured BBMD forwards", () =>
    Effect.gen(function* () {
      const result = yield* readWhileForging({}, "bbmd")
      expect(result).toMatchObject({ _tag: "Success", success: [{ type: "real", value: 666 }] })
    }).pipe(Effect.scoped)
  )

  it.live("drops a COV notification a third host forwards in the device's name, even with the right process id", () =>
    Effect.gen(function* () {
      const client = yield* startClient()
      const simulated = makeSimulatedDevice({
        instance: 2001,
        name: "dev",
        objects: [{ objectType: "analog-input", instance: 1, name: "t", presentValue: { type: "real", value: 21 } }]
      })
      const deviceSocket = yield* NodeDatagramSocket.make({ bind: loopback })
      const deviceAddress = yield* serveSimulatedDevice(deviceSocket, simulated)
      const config: BacnetDevice = {
        protocol: "bacnet-ip",
        id: "dev",
        deviceInstance: 2001,
        cov: true,
        pollIntervalMs: 1000,
        address: NetAddress.formatInet(deviceAddress),
        points: [
          {
            id: "t",
            name: "t",
            writable: false,
            objectType: "analog-input",
            instance: 1,
            property: "present-value",
            priority: 8
          }
        ]
      }
      const driver = yield* makeBacnetDriverFromClient(config, client, { cov: { checkMs: 50 } })
      yield* driver.readAll
      const pushed: Array<unknown> = []
      if (driver.changes !== undefined) {
        yield* Stream.runForEach(driver.changes, (reading) => Effect.sync(() => pushed.push(reading.value))).pipe(
          Effect.forkScoped
        )
      }
      const subscription = yield* Effect.sync(() => [...simulated.subscriptions.values()][0]).pipe(
        Effect.repeat({ until: (found) => found !== undefined, schedule: Schedule.spaced("20 millis") }),
        Effect.timeout("2 seconds")
      )
      if (subscription === undefined) return yield* Effect.die("not subscribed")
      // The process identifier is random, but even the right one does not get a forged notification in.
      const [host = "", port = ""] = subscription.subscriber.split(":")
      const subscriber = Result.getOrThrow(NetAddress.inetAddressFromIpString(host, Number(port)))
      const third = yield* peer()
      yield* third.writer.write({
        address: subscriber,
        payload: forwarded(
          {
            _tag: "UnconfirmedRequest",
            service: UnconfirmedService.UnconfirmedCovNotification,
            body: encodeCovNotification({
              processId: subscription.processId,
              initiatingDevice: { objectType: ObjectType.device, instance: 2001 },
              object: analogInput1,
              timeRemaining: 300,
              values: [{ property: PropertyId["present-value"], values: [{ type: "real", value: 666 }] }]
            })
          },
          deviceAddress
        )
      })
      yield* Effect.sleep("200 millis")
      expect(pushed).toContain(21)
      expect(pushed).not.toContain(666)
    }).pipe(Effect.scoped)
  )

  it.live(
    "discovering one address keeps only that address's I-Am, through a flood from another host",
    () =>
      Effect.gen(function* () {
        const client = yield* startClient({ requestTimeout: "1 second" })
        const simulated = makeSimulatedDevice({
          instance: 7,
          name: "d",
          objects: [{ objectType: "analog-input", instance: 1, name: "t", presentValue: { type: "real", value: 1 } }]
        })
        const deviceSocket = yield* NodeDatagramSocket.make({ bind: loopback })
        const deviceAddress = yield* serveSimulatedDevice(deviceSocket, simulated)
        // Learn the client's address from a Who-Is it sends to a peer.
        const flooder = yield* peer()
        const located = yield* client.locate(1, { target: { address: flooder.address } }).pipe(Effect.forkScoped)
        const [whoIs] = yield* flooder.reader.pull
        yield* Fiber.interrupt(located)
        if (whoIs === undefined) return yield* Effect.die("no Who-Is")
        const discovering = yield* client
          .discover({ target: { address: deviceAddress }, within: "1 second" })
          .pipe(Effect.forkScoped)
        const flood = Effect.forEach(
          Array.from({ length: 20_000 }, (_, instance) => instance),
          (instance) =>
            flooder.writer.write({
              address: whoIs.address,
              payload: encodeFrame({
                _tag: "UnconfirmedRequest",
                service: UnconfirmedService.IAm,
                body: encodeIAm({ device: { objectType: 8, instance }, maxApdu: 1476, segmentation: 3, vendorId: 1 })
              })
            }),
          { discard: true }
        )
        const reads = Effect.forEach(
          Array.from({ length: 10 }, (_, index) => index),
          () =>
            Effect.result(
              client.readProperty(
                { address: deviceAddress },
                { object: analogInput1, property: PropertyId["present-value"] }
              )
            ),
          { concurrency: 1 }
        )
        const [, results] = yield* Effect.all([flood, reads], { concurrency: 2 })
        // The flood can overflow the socket's receive buffer and take the device's one I-Am with it
        // (kernel loss, not the filter), so during it only "no other device" is certain.
        const found = yield* Fiber.join(discovering)
        expect(found.filter((device) => device.instance !== 7)).toEqual([])
        const after = yield* client.discover({ target: { address: deviceAddress }, within: "500 millis" })
        expect(after.map((device) => device.instance)).toEqual([7])
        expect(results.filter(Result.isSuccess).length).toBeGreaterThan(0)
      }).pipe(Effect.scoped),
    30_000
  )

  it.live("a request that finds no free invoke ID fails within its timeout instead of queueing", () =>
    Effect.gen(function* () {
      const silent = yield* peer()
      const client = yield* startClient({ requestTimeout: "1 second", retries: 0 })
      const started = Date.now()
      // Four times the 256 invoke IDs, all to a device that never answers.
      const timed = yield* Effect.forEach(
        Array.from({ length: 1024 }, (_, index) => index),
        () =>
          Effect.gen(function* () {
            const begun = Date.now()
            const result = yield* Effect.result(
              client.readProperty(
                { address: silent.address },
                { object: analogInput1, property: PropertyId["present-value"] }
              )
            )
            return { result, took: Date.now() - begun }
          }),
        { concurrency: "unbounded" }
      )
      const elapsed = Date.now() - started
      const results = timed.map(({ result }) => result)
      // Queued, the last quarter would wait three timeouts first and end after four seconds.
      expect(elapsed).toBeLessThan(3000)
      // Each request, its wait for an invoke ID included, ends near its 1 s deadline: one that gets an ID
      // freed just before its deadline must not start a fresh 1 s exchange on top (two seconds in all).
      // The bound sits midway: a CI runner busy with every package's tests delays timers by ~350 ms.
      expect(Math.max(...timed.map(({ took }) => took))).toBeLessThan(1600)
      expect(
        results.some(
          (result) =>
            Result.isFailure(result) && result.failure.message.startsWith("too many BACnet requests in flight")
        )
      ).toBe(true)
      // Every failure says which it was: no invoke ID in time, or the device that did not answer.
      const unexplained = results.filter(
        (result) =>
          Result.isFailure(result) &&
          !result.failure.message.startsWith("too many BACnet requests in flight") &&
          !result.failure.message.startsWith(`no reply from 127.0.0.1:${silent.address.port} within`)
      )
      expect(unexplained).toEqual([])
    }).pipe(Effect.scoped)
  )

  it.live("a port in use and an unassigned bind address fail makeBacnetNetwork with a typed error", () =>
    Effect.gen(function* () {
      const holder = yield* peer()
      const settings: BacnetSettings = {
        bindAddress: "127.0.0.1",
        port: holder.address.port,
        broadcastAddress: "127.0.0.255",
        requestTimeoutMs: 500,
        retries: 0,
        covLifetimeSeconds: 300
      }
      const inUse = yield* Effect.flip(Effect.scoped(makeBacnetNetwork(settings)))
      const unassigned = yield* Effect.flip(
        Effect.scoped(makeBacnetNetwork({ ...settings, port: 0, bindAddress: "10.255.255.77" }))
      )
      expect(inUse._tag).toBe("BacnetSocketError")
      expect(unassigned._tag).toBe("BacnetSocketError")
    }).pipe(Effect.scoped)
  )
})
