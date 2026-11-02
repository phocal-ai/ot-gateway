/**
 * A minimal MQTT 5 broker for tests and local development: it accepts
 * connections, acknowledges publishes and records them. There is no
 * subscription routing; it exists so the client is tested over real TCP
 * (CLAUDE.md rule 8) and `pnpm gateway` has somewhere to publish.
 *
 * A client that goes away without DISCONNECT has its last will published, as
 * a real broker would. `BrokerControl` injects faults: refuse connections,
 * withhold PUBACKs or PINGRESPs, refuse messages.
 */
import { Effect, Result } from "effect"
import type * as Socket from "effect/socket/Socket"
import type * as SocketServer from "effect/socket/SocketServer"
import { PacketType } from "./Codec.ts"
import { decodeConnect, decodePublish, encodeConnack, encodePingresp, encodePuback, takePacket } from "./Packet.ts"
import type { Connect, Will } from "./Packet.ts"

export interface ReceivedMessage {
  readonly clientId: string
  readonly topic: string
  readonly payload: string
  readonly qos: 0 | 1
  readonly retain: boolean
}

export interface BrokerControl {
  /** CONNACK reason code; 0x80 and above refuses the connection. */
  connackReason: number
  /** Numeric CONNACK properties, e.g. Receive Maximum or Server Keep Alive. */
  connackProperties: Map<number, number>
  /** Send PUBACK for QoS 1 messages. */
  ackPublishes: boolean
  /** PUBACK reason code; 0x80 and above refuses the message. */
  pubackReason: number
  /** Answer PINGREQ. With pings unanswered and nothing else sent, the client sees a dead broker. */
  answerPings: boolean
  readonly connects: Array<Omit<Connect, "password"> & { readonly hasPassword: boolean }>
  readonly messages: Array<ReceivedMessage>
  /** Last retained payload per topic. */
  readonly retained: Map<string, string>
  /** Clients that closed with DISCONNECT. */
  cleanDisconnects: number
  /** Called for every accepted message. When set, messages are passed here instead of kept in `messages`. */
  onMessage?: (message: ReceivedMessage) => void
}

export const makeBrokerControl = (): BrokerControl => ({
  connackReason: 0,
  connackProperties: new Map(),
  ackPublishes: true,
  pubackReason: 0,
  answerPings: true,
  connects: [],
  messages: [],
  retained: new Map(),
  cleanDisconnects: 0
})

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const append = (buffer: Uint8Array, chunks: ReadonlyArray<Uint8Array | string>): Uint8Array => {
  const bytes = chunks.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk))
  const out = new Uint8Array(buffer.length + bytes.reduce((n, b) => n + b.length, 0))
  out.set(buffer, 0)
  let offset = buffer.length
  for (const b of bytes) {
    out.set(b, offset)
    offset += b.length
  }
  return out
}

/** Record or hand on an accepted message, and keep it if retained. */
const accept = (control: BrokerControl, message: ReceivedMessage) => {
  if (control.onMessage === undefined) control.messages.push(message)
  else control.onMessage(message)
  if (message.retain) control.retained.set(message.topic, message.payload)
}

const serveConnection = (control: BrokerControl) =>
  Effect.fnUntraced(
    function* (socket: Socket.Socket) {
      const writer = yield* socket.writer
      const { pull } = yield* socket.reader
      let buffer: Uint8Array = new Uint8Array(0)
      let clientId: string | undefined
      let will: Will | undefined
      // A connection that ends without DISCONNECT publishes its will (§3.1.2.5),
      // whether the client vanished, broke the protocol or the broker dropped it.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (will === undefined || clientId === undefined) return
          accept(control, { clientId, topic: will.topic, payload: will.payload, qos: will.qos, retain: will.retain })
        })
      )
      while (true) {
        buffer = append(buffer, yield* pull)
        let split = takePacket(buffer)
        while (split._tag === "Packet") {
          buffer = split.rest
          switch (split.type) {
            case PacketType.CONNECT: {
              const connect = decodeConnect(split.body)
              if (Result.isFailure(connect)) return
              const { password, ...rest } = connect.success
              control.connects.push({ ...rest, hasPassword: password !== undefined })
              yield* writer.write(encodeConnack(control.connackReason, control.connackProperties))
              // A refused client is disconnected right after its CONNACK (§3.2.2.2).
              if (control.connackReason >= 0x80) return
              clientId = connect.success.clientId
              will = connect.success.will
              break
            }
            case PacketType.PUBLISH: {
              const publish = decodePublish(split.flags, split.body)
              if (Result.isFailure(publish) || clientId === undefined) return
              const { topic, qos, retain, packetId } = publish.success
              const payload = decoder.decode(publish.success.payload)
              if (control.pubackReason < 0x80) accept(control, { clientId, topic, payload, qos, retain })
              if (qos === 1 && packetId !== undefined && control.ackPublishes) {
                yield* writer.write(encodePuback(packetId, control.pubackReason))
              }
              break
            }
            case PacketType.PINGREQ:
              if (control.answerPings) yield* writer.write(encodePingresp())
              break
            case PacketType.DISCONNECT:
              // A normal disconnection discards the will (§3.14.4).
              will = undefined
              control.cleanDisconnects++
              return
            default:
              // Anything else (SUBSCRIBE, QoS 2 flows) is out of scope: drop the client.
              return
          }
          split = takePacket(buffer)
        }
        if (split._tag === "Invalid") return
      }
    },
    Effect.scoped,
    // A client going away ends its connection only.
    Effect.catchTag("SocketError", () => Effect.void)
  )

/** Serve MQTT clients on `server` until the surrounding scope closes. */
export const serveMqtt = (
  server: SocketServer.SocketServer["Service"],
  control: BrokerControl = makeBrokerControl()
): Effect.Effect<never, SocketServer.SocketServerError> => server.run(serveConnection(control))
