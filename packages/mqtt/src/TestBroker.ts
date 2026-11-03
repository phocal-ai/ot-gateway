/**
 * A minimal MQTT 5 broker for tests and local development: it accepts
 * connections, acknowledges publishes and records them, and routes them to
 * subscribers (QoS 0 and 1, retained messages on subscribe, request/response
 * properties passed through). It exists so the client is tested over real
 * TCP (CLAUDE.md rule 8) and `pnpm gateway` has somewhere to publish;
 * `publishToSubscribers` lets a test send a command.
 *
 * A client that goes away without DISCONNECT has its last will published, as
 * a real broker would. `BrokerControl` injects faults: refuse connections,
 * withhold PUBACKs or PINGRESPs, refuse messages, or drop the client on a
 * message above a size limit it never announced.
 */
import { Effect, Queue, Result } from "effect"
import type * as Socket from "effect/socket/Socket"
import type * as SocketServer from "effect/socket/SocketServer"
import { PacketType } from "./Codec.ts"
import {
  decodeConnect,
  decodeDisconnect,
  decodePublish,
  decodeSubscribe,
  encodeConnack,
  encodeDisconnect,
  encodePingresp,
  encodePuback,
  encodePublish,
  encodeSuback,
  makeFrameReader,
  topicMatches
} from "./Packet.ts"
import type { Connect, Subscription, Will } from "./Packet.ts"

export interface ReceivedMessage {
  readonly clientId: string
  readonly topic: string
  readonly payload: string
  readonly qos: 0 | 1
  readonly retain: boolean
  readonly responseTopic?: string
  readonly correlationData?: Uint8Array
}

/** A connected client's subscriptions and its outgoing packets. */
interface Subscriber {
  readonly subscriptions: Array<Subscription>
  readonly outgoing: Queue.Queue<Uint8Array>
  nextPacketId: number
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
  /** Connected clients with their subscriptions. */
  readonly subscribers: Set<Subscriber>
  /** Last retained message per topic, with its properties, for new subscriptions. */
  readonly retainedMessages: Map<string, ReceivedMessage>
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
  disconnectReasons: [],
  subscribers: new Set(),
  retainedMessages: new Map()
})

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/**
 * Queue `message` to a subscriber whose filters match, at the lower of the two
 * QoS levels (§3.8.4). On subscribing a retained message is flagged retained;
 * a live one keeps its flag only for Retain As Published (§3.3.1.3).
 */
const deliver = (subscriber: Subscriber, message: ReceivedMessage, onSubscribe: boolean) => {
  const matching = subscriber.subscriptions.filter((subscription) => topicMatches(subscription.filter, message.topic))
  if (matching.length === 0) return
  const retain =
    onSubscribe || (message.retain && matching.some((subscription) => subscription.retainAsPublished === true))
  const qos = Math.min(message.qos, Math.max(...matching.map((subscription) => subscription.qos))) === 1 ? 1 : 0
  const packetId = qos === 1 ? subscriber.nextPacketId : undefined
  if (packetId !== undefined) subscriber.nextPacketId = (packetId % 0xffff) + 1
  Queue.offerUnsafe(
    subscriber.outgoing,
    encodePublish({
      topic: message.topic,
      payload: encoder.encode(message.payload),
      qos,
      retain,
      ...(packetId === undefined ? {} : { packetId }),
      ...(message.responseTopic === undefined ? {} : { responseTopic: message.responseTopic }),
      ...(message.correlationData === undefined ? {} : { correlationData: message.correlationData })
    })
  )
}

/** Record or hand on an accepted message, keep it if retained, and route it to subscribers. */
const accept = (control: BrokerControl, message: ReceivedMessage) => {
  if (control.onMessage === undefined) control.messages.push(message)
  else control.onMessage(message)
  // An empty retained message clears the topic's retained message (§3.3.1.3).
  if (message.retain && message.payload === "") {
    control.retained.delete(message.topic)
    control.retainedMessages.delete(message.topic)
  } else if (message.retain) {
    control.retained.set(message.topic, message.payload)
    control.retainedMessages.set(message.topic, message)
  }
  for (const subscriber of control.subscribers) deliver(subscriber, message, false)
}

/**
 * Publish as if a client had: recorded, retained if asked, and routed to every
 * matching subscriber. How a test sends a command to the gateway.
 */
export const publishToSubscribers = (control: BrokerControl, message: Omit<ReceivedMessage, "clientId">) =>
  accept(control, { clientId: "test", ...message })

const serveConnection = (control: BrokerControl) =>
  Effect.fnUntraced(
    function* (socket: Socket.Socket) {
      const writer = yield* socket.writer
      const { pull } = yield* socket.reader
      const frames = makeFrameReader(control.dropPacketsOver)
      let clientId: string | undefined
      let will: Will | undefined
      const subscriber: Subscriber = {
        subscriptions: [],
        outgoing: yield* Queue.unbounded<Uint8Array>(),
        nextPacketId: 1
      }
      // Messages routed to this client go out in order, apart from the replies the loop below writes.
      yield* Queue.take(subscriber.outgoing).pipe(
        Effect.flatMap((packet) => writer.write(packet)),
        Effect.forever,
        Effect.catchTag("SocketError", () => Effect.void),
        Effect.forkScoped
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => control.subscribers.delete(subscriber)))
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
              control.subscribers.add(subscriber)
              break
            }
            case PacketType.PUBLISH: {
              const publish = decodePublish(split.flags, split.body)
              if (Result.isFailure(publish) || clientId === undefined) return
              const { topic, qos, retain, packetId, responseTopic, correlationData } = publish.success
              const payload = decoder.decode(publish.success.payload)
              const reasonCode = control.refusedTopics.has(topic) ? 0x87 : control.pubackReason
              if (reasonCode < 0x80) {
                accept(control, {
                  clientId,
                  topic,
                  payload,
                  qos,
                  retain,
                  ...(responseTopic === undefined ? {} : { responseTopic }),
                  ...(correlationData === undefined ? {} : { correlationData })
                })
              }
              if (qos === 1 && packetId !== undefined && control.ackPublishes) {
                yield* writer.write(encodePuback(packetId, reasonCode))
              }
              break
            }
            case PacketType.SUBSCRIBE: {
              const subscribe = decodeSubscribe(split.body)
              if (Result.isFailure(subscribe) || clientId === undefined) return
              subscriber.subscriptions.push(...subscribe.success.subscriptions)
              yield* writer.write(
                encodeSuback({
                  packetId: subscribe.success.packetId,
                  reasonCodes: subscribe.success.subscriptions.map((subscription) => subscription.qos)
                })
              )
              // Retain Handling 0: the retained messages a new subscription matches, flagged as retained (§3.3.1.3).
              const fresh = { ...subscriber, subscriptions: [...subscribe.success.subscriptions] }
              for (const message of control.retainedMessages.values()) deliver(fresh, message, true)
              subscriber.nextPacketId = fresh.nextPacketId
              break
            }
            case PacketType.PUBACK:
              // A subscriber acknowledging a QoS 1 delivery; this broker does not redeliver.
              break
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
              // Anything else (UNSUBSCRIBE, QoS 2 flows) is out of scope: drop the client.
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
