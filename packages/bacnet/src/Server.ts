/**
 * Puts a simulated device on the network: every datagram that arrives on
 * `socket` is answered by `answer` from Simulator.ts. Used by tests and the
 * bench, so the client runs against real UDP without hardware.
 *
 * I-Am goes back to whoever asked, not to the broadcast address. A real device
 * usually broadcasts it, which the client also handles; answering directly
 * lets several simulators share one host on different ports.
 *
 * A request addressed to a device on another network (an NPDU destination
 * with a MAC address) is answered as that device behind a router would: with
 * the destination as the answer's source.
 *
 * COV subscribers get a notification right after subscribing and then
 * whenever a subscribed object changes (clause 13.1), at the address and
 * through the routing they subscribed from.
 */
import { describeDatagramSocketError } from "@plenum/core"
import { Clock, Effect, Queue, Result } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import type * as DatagramSocket from "effect/socket/DatagramSocket"
import { type Apdu, ConfirmedService } from "./Apdu.ts"
import type { ObjectId } from "./Encoding.ts"
import { decodeFrame, type EncodeOptions, encodeFrame } from "./Frame.ts"
import { decodeSubscribeCov } from "./Services.ts"
import { answer, covNotifications, type SimulatedDevice } from "./Simulator.ts"

/** Where to reach a requester again, and how to route to it. */
interface Peer {
  readonly address: NetAddress.InetAddress
  readonly routing: EncodeOptions
}

/**
 * Serve `device` on `socket` until the surrounding scope closes. Returns the
 * bound address, so a test can bind port 0 and learn the port.
 */
export const serveSimulatedDevice = Effect.fn("serveSimulatedDevice")(function* (
  socket: DatagramSocket.DatagramSocket,
  device: SimulatedDevice
) {
  const reader = yield* socket.reader
  const writer = yield* socket.writer
  const peers = new Map<string, Peer>()

  const send = (apdu: Apdu, peer: Peer) =>
    writer
      .write({ payload: encodeFrame(apdu, peer.routing), address: peer.address })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("simulated BACnet device could not answer").pipe(
            Effect.annotateLogs({ device: device.instance, error: describeDatagramSocketError(error) })
          )
        )
      )

  const notify = (object: ObjectId, subscriber?: string) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.forEach(
        covNotifications(device, object, now, subscriber),
        (notification) => {
          const peer = peers.get(notification.subscriber)
          return peer === undefined ? Effect.void : send(notification.apdu, peer)
        },
        { discard: true }
      )
    )

  const reply = Effect.fnUntraced(function* (datagram: DatagramSocket.Datagram) {
    const frame = decodeFrame(datagram.payload)
    if (Result.isFailure(frame) || frame.success === undefined) return
    const { apdu, source, destination } = frame.success
    const behindRouter = destination !== undefined && destination.address.length > 0
    const peer: Peer = {
      address: datagram.address,
      routing: {
        ...(source === undefined ? {} : { destination: source }),
        ...(behindRouter ? { source: destination } : {})
      }
    }
    const subscriber =
      source === undefined
        ? NetAddress.formatInet(datagram.address)
        : `${NetAddress.formatInet(datagram.address)}/${source.network}:${source.address.join(".")}`
    const now = yield* Clock.currentTimeMillis
    const response = answer(device, apdu, { subscriber, now })
    if (response === undefined) return
    yield* send(response, peer)
    if (
      response._tag === "SimpleAck" &&
      response.service === ConfirmedService.SubscribeCov &&
      apdu._tag === "ConfirmedRequest"
    ) {
      // Only subscribers are remembered, so other requesters cost nothing.
      peers.set(subscriber, peer)
      const subscription = decodeSubscribeCov(apdu.body)
      if (Result.isSuccess(subscription)) yield* notify(subscription.success.object, subscriber)
    }
  })

  // Changes are made synchronously (by a test or the bench); they are sent from here.
  const changed = yield* Queue.unbounded<ObjectId>()
  const listener = (object: ObjectId) => {
    Queue.offerUnsafe(changed, object)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => device.onChange.add(listener)),
    () => Effect.sync(() => device.onChange.delete(listener))
  )
  yield* Effect.forever(Effect.flatMap(Queue.take(changed), (object) => notify(object))).pipe(Effect.forkScoped)

  yield* Effect.forever(
    Effect.flatMap(reader.pull, (datagrams) => Effect.forEach(datagrams, reply, { discard: true }))
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("simulated BACnet device stopped").pipe(
        Effect.annotateLogs({ device: device.instance, error: describeDatagramSocketError(error) })
      )
    ),
    Effect.forkScoped
  )
  const address: NetAddress.InetAddress = reader.address
  return address
})
