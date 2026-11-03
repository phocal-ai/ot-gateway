import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Scope } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import { makeMemoryNetwork } from "../src/index.ts"

const decoder = new TextDecoder()
const text = (chunks: ReadonlyArray<Uint8Array | string>) =>
  chunks.map((chunk) => (typeof chunk === "string" ? chunk : decoder.decode(chunk))).join("")

/** A server on `ip:port` that keeps every accepted connection's reader and writer for the test to drive. */
const serve = Effect.fnUntraced(function* (network: ReturnType<typeof makeMemoryNetwork>, ip: string, port: number) {
  const scope = yield* Scope.make()
  const server = yield* network.listen(ip, port).pipe(Scope.provide(scope))
  const accepted: Array<{ reader: Socket.Reader; writer: Socket.Writer }> = []
  const fiber = yield* server
    .run((socket) =>
      Effect.gen(function* () {
        accepted.push({ reader: yield* socket.reader, writer: yield* socket.writer })
        return yield* Effect.never
      })
    )
    .pipe(Effect.forkChild)
  const crash = Effect.andThen(Fiber.interrupt(fiber), Scope.close(scope, Exit.void))
  return { accepted, crash }
})

const settle = TestClock.adjust("1 millis")

describe("MemoryNetwork, TCP", () => {
  it.effect("carries bytes both ways, and ends the stream after them when a side closes", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      const server = yield* serve(network, "10.0.0.2", 1883)
      const socket = yield* network.host("10.0.0.1").tcp({ host: "10.0.0.2", port: 1883, openTimeout: "1 second" })
      const reader = yield* socket.reader
      const writer = yield* socket.writer
      yield* writer.write("hello")
      yield* settle
      const [peer] = server.accepted
      if (peer === undefined) return expect.fail("not accepted")
      expect(text(yield* peer.reader.pull)).toBe("hello")

      yield* peer.writer.write("bye")
      yield* peer.writer.write(new Socket.CloseEvent(1000))
      expect(text(yield* reader.pull)).toBe("bye")
      const closed = yield* Effect.flip(reader.pull)
      expect(closed.reason._tag).toBe("SocketCloseError")
      expect(network.stats().openEnds.get("10.0.0.1")).toBe(1)
    }).pipe(Effect.scoped)
  )

  it.effect("refuses a connection to a port nobody listens on, and drops connections when the listener crashes", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      const client = network.host("10.0.0.1")
      const nobody = yield* client.tcp({ host: "10.0.0.2", port: 1883, openTimeout: "1 second" })
      const refused = yield* Effect.flip(nobody.reader)
      expect(refused.reason._tag).toBe("SocketOpenError")

      const server = yield* serve(network, "10.0.0.2", 1883)
      const socket = yield* client.tcp({ host: "10.0.0.2", port: 1883, openTimeout: "1 second" })
      const reader = yield* socket.reader
      yield* settle
      yield* server.crash
      const closed = yield* Effect.flip(reader.pull)
      expect(closed.reason._tag).toBe("SocketCloseError")
      expect(network.stats().listeners).toBe(0)
    }).pipe(Effect.scoped)
  )

  it.effect("holds traffic across a partition: connects hang, bytes and closes arrive once it heals", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      const server = yield* serve(network, "10.0.0.2", 1883)
      const client = network.host("10.0.0.1")
      network.partition("10.0.0.2", true)

      const hanging = yield* client.tcp({ host: "10.0.0.2", port: 1883, openTimeout: "5 seconds" })
      const attempt = yield* Effect.flip(hanging.reader).pipe(Effect.forkChild)
      yield* TestClock.adjust("5 seconds")
      expect((yield* Fiber.join(attempt)).reason._tag).toBe("SocketOpenError")

      network.partition("10.0.0.2", false)
      const socket = yield* client.tcp({ host: "10.0.0.2", port: 1883, openTimeout: "5 seconds" })
      const connection = yield* Scope.make()
      yield* socket.reader.pipe(Scope.provide(connection))
      const writer = yield* socket.writer
      yield* settle
      const [peer] = server.accepted
      if (peer === undefined) return expect.fail("not accepted")

      network.partition("10.0.0.2", true)
      yield* writer.write("during")
      // The client gives up on the connection while the server cannot hear it: half-open.
      yield* Scope.close(connection, Exit.void)
      const pulled = yield* peer.reader.pull.pipe(Effect.forkChild)
      yield* TestClock.adjust("1 minute")
      expect(pulled.pollUnsafe()).toBeUndefined()

      network.partition("10.0.0.2", false)
      expect(text(yield* Fiber.join(pulled))).toBe("during")
      expect((yield* Effect.flip(peer.reader.pull)).reason._tag).toBe("SocketCloseError")
    }).pipe(Effect.scoped)
  )
})

describe("MemoryNetwork, UDP", () => {
  it.effect("delivers to the bound address and broadcasts to the port, and loses datagrams as configured", () =>
    Effect.gen(function* () {
      // A fixed sequence: the first draw keeps a datagram at 50 % loss, the second loses it.
      const draws = [0.9, 0.1]
      const network = makeMemoryNetwork(() => draws.shift() ?? 0)
      const gateway = yield* network.host("10.0.0.1").udp({ address: "0.0.0.0", port: 47808 })
      const device = yield* network.host("10.0.0.5").udp({ address: "10.0.0.5", port: 47808 })
      const gatewayReader = yield* gateway.reader
      const deviceReader = yield* device.reader
      const gatewayWriter = yield* gateway.writer
      const deviceWriter = yield* device.writer

      yield* gatewayWriter.write({
        payload: "who-is",
        address: NetAddress.inetAddressFromIpStringUnsafe("255.255.255.255", 47808)
      })
      const [received] = yield* deviceReader.pull
      expect(received && decoder.decode(received.payload)).toBe("who-is")
      // The source is the gateway's host, though it bound 0.0.0.0, so the device can answer it.
      expect(received && NetAddress.formatInet(received.address)).toBe("10.0.0.1:47808")
      if (received === undefined) return
      yield* deviceWriter.write({ payload: "i-am", address: received })
      expect((yield* gatewayReader.pull).map((datagram) => decoder.decode(datagram.payload))).toEqual(["i-am"])

      network.setLoss("10.0.0.5", 0.5)
      yield* deviceWriter.write({ payload: "kept", address: received.address })
      yield* deviceWriter.write({ payload: "lost", address: received.address })
      network.partition("10.0.0.5", true)
      yield* deviceWriter.write({ payload: "cut off", address: received.address })
      expect((yield* gatewayReader.pull).map((datagram) => decoder.decode(datagram.payload))).toEqual(["kept"])
      expect(network.stats().datagramsLost).toBe(2)
    }).pipe(Effect.scoped)
  )

  it.effect("refuses a second endpoint on the same address", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      const first = yield* network.host("10.0.0.1").udp({ address: "0.0.0.0", port: 47808 })
      const second = yield* network.host("10.0.0.1").udp({ address: "10.0.0.1", port: 47808 })
      yield* first.reader
      const error = yield* Effect.flip(second.reader)
      expect(error.reason._tag).toBe("DatagramSocketOpenError")
    }).pipe(Effect.scoped)
  )
})
