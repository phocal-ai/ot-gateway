/**
 * A minimal MQTT 5 broker for tests and local development: it accepts
 * connections, acknowledges publishes and records them. There is no
 * subscription routing; it exists so the client is tested over real TCP
 * (CLAUDE.md rule 8) and `pnpm gateway` has somewhere to publish.
 *
 * A client that goes away without DISCONNECT has its last will published, as
 * a real broker would. `BrokerControl` injects faults: refuse connections,
 * withhold PUBACKs or PINGRESPs, refuse messages, or drop the client on a
 * message above a size limit it never announced.
 */
import { Effect, Result } from "effect"
import type * as Socket from "effect/socket/Socket"
import type * as SocketServer from "effect/socket/SocketServer"
import { PacketType } from "./Codec.ts"
import {
  decodeConnect,
  decodeDisconnect,
  decodePublish,
  encodeConnack,
  encodeDisconnect,
  encodePingresp,
  encodePuback,
  makeFrameReader
} from "./Packet.ts"
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
  /** Topics refused with 0x87 (not authorized), whatever `pubackReason` says. */
  readonly refusedTopics: Set<string>
  /** Answer PINGREQ. With pings unanswered and nothing else sent, the client sees a dead broker. */
  answerPings: boolean
  readonly connects: Array<Omit<Connect, "password"> & { readonly hasPassword: boolean }>
  readonly messages: Array<ReceivedMessage>
  /** Last retained payload per topic. */
  readonly retained: Map<string, string>
  /**
   * Packets larger than this many bytes get DISCONNECT 0x95 (packet too large)
   * and the connection is closed. Not announced in CONNACK, as with brokers
   * that only enforce their limit.
   */
  dropPacketsOver?: number
  /** Clients that closed with DISCONNECT 0x00. */
  cleanDisconnects: number
  /** Reason codes of every DISCONNECT a client sent. */
  readonly disconnectReasons: Array<number>
  /** Called for every accepted message. When set, messages are passed here instead of kept in `messages`. */
  onMessage?: (message: ReceivedMessage) => void
}

export const makeBrokerControl = (): BrokerControl => ({
  connackReason: 0,
  connackProperties: new Map(),
  ackPublishes: true,
  pubackReason: 0,
  refusedTopics: new Set(),
  answerPings: true,
  connects: [],
  messages: [],
  retained: new Map(),
  cleanDisconnects: 0,
  disconnectReasons: []
})

const decoder = new TextDecoder()
const encoder = new TextEncoder()

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
      const frames = makeFrameReader(control.dropPacketsOver)
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
        for (const chunk of yield* pull) frames.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
        let split = frames.next()
        while (split._tag === "Packet") {
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
              const reasonCode = control.refusedTopics.has(topic) ? 0x87 : control.pubackReason
              if (reasonCode < 0x80) accept(control, { clientId, topic, payload, qos, retain })
              if (qos === 1 && packetId !== undefined && control.ackPublishes) {
                yield* writer.write(encodePuback(packetId, reasonCode))
              }
              break
            }
            case PacketType.PINGREQ:
              if (control.answerPings) yield* writer.write(encodePingresp())
              break
            case PacketType.DISCONNECT: {
              const disconnect = decodeDisconnect(split.body)
              const reasonCode = Result.isSuccess(disconnect) ? disconnect.success.reasonCode : 0x81
              control.disconnectReasons.push(reasonCode)
              // A normal disconnection discards the will (§3.14.4); any other reason publishes it.
              if (reasonCode !== 0) return
              will = undefined
              control.cleanDisconnects++
              return
            }
            default:
              // Anything else (SUBSCRIBE, QoS 2 flows) is out of scope: drop the client.
              return
          }
          split = frames.next()
        }
        if (split._tag === "TooLarge") {
          yield* writer.write(encodeDisconnect(0x95))
          return
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
