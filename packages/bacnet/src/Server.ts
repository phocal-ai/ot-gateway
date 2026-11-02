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
 */
import { describeDatagramSocketError } from "@plenum/core"
import { Effect, Result } from "effect"
import type * as NetAddress from "effect/net/NetAddress"
import type * as DatagramSocket from "effect/socket/DatagramSocket"
import { decodeFrame, encodeFrame } from "./Frame.ts"
import { answer, type SimulatedDevice } from "./Simulator.ts"

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

  const reply = (datagram: DatagramSocket.Datagram): Effect.Effect<void> => {
    const frame = decodeFrame(datagram.payload)
    if (Result.isFailure(frame) || frame.success === undefined) return Effect.void
    const response = answer(device, frame.success.apdu)
    if (response === undefined) return Effect.void
    const { source, destination } = frame.success
    const behindRouter = destination !== undefined && destination.address.length > 0
    return writer
      .write({
        payload: encodeFrame(response, {
          ...(source === undefined ? {} : { destination: source }),
          ...(behindRouter ? { source: destination } : {})
        }),
        address: datagram
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("simulated BACnet device could not answer").pipe(
            Effect.annotateLogs({ device: device.instance, error: describeDatagramSocketError(error) })
          )
        )
      )
  }

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
