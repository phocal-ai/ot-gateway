/**
 * MQTT publishing client: one broker connection, kept alive and re-opened
 * with jittered exponential backoff for as long as the client's scope lives.
 * It speaks MQTT 5, and MQTT 3.1.1 to a broker that does not: with
 * `protocolVersion: "auto"` (the default) it dials with 5 and, when the broker
 * refuses that protocol level, dials again with 3.1.1 and stays with it.
 *
 * Publishing never queues across outages: while disconnected, a publish
 * waits up to `publishTimeout` for the connection and then fails (or, with
 * `waitForConnection: false`, fails as soon as the first dial is over), so
 * the caller decides what to
 * retry: the pipeline retries `$meta` on the next cycle, and `@ot-gateway/buffer`
 * stores values for later. QoS 1 publishes complete on
 * PUBACK. Publishes go on the wire in the order they were called, also when
 * several wait for the connection at once (§4.6 keeps that order to the
 * subscribers), so values buffered during an outage do not overtake each
 * other when it ends. The session is clean (no session state survives a reconnect), so
 * nothing unacknowledged is resent behind the caller's back.
 *
 * Dead connections are noticed three ways: the broker stays silent past
 * 1.5 keep alives (timed on the monotonic clock, since a Pi without an RTC
 * has its wall clock stepped by NTP), two publishes in a row get no PUBACK,
 * or the broker breaks the protocol.
 */
import { describeSocketError, monotonicMillis, mqttConnected, mqttConnects } from "@ot-gateway/core"
import { Deferred, Duration, Effect, Exit, Latch, Metric, Random, Redacted, Result, Schema, Semaphore } from "effect"
import type * as Socket from "effect/socket/Socket"
import { PacketType } from "./Codec.ts"
import {
  connackReasonName,
  decodeConnack,
  decodeDisconnect,
  decodePuback,
  decodePublish,
  decodeSuback,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePublish,
  encodePuback,
  encodeSubscribe,
  makeFrameReader,
  Property,
  pubackRefusesMessage,
  refusesProtocolLevel
} from "./Packet.ts"
import type { ProtocolVersion, Subscription, Will } from "./Packet.ts"

/** The connection could not be opened, broke, or the broker stopped answering. */
export class MqttConnectionError extends Schema.TaggedError<MqttConnectionError>()("MqttConnectionError", {
  message: Schema.String
}) {}

/** The broker refused the connection (CONNACK reason code 0x80 or above). */
export class MqttRejected extends Schema.TaggedError<MqttRejected>()("MqttRejected", {
  reasonCode: Schema.Int,
  message: Schema.String
}) {}

/** The broker refused MQTT 5 and `auto` is set: dial again, with 3.1.1. Never leaves the client. */
class MqttDowngrade extends Schema.TaggedError<MqttDowngrade>()("MqttDowngrade", {}) {}

/** Which MQTT the client speaks: 5, 3.1.1, or 5 with a fallback to 3.1.1 (`auto`). */
export type MqttVersionSetting = "auto" | "5" | "3.1.1"

/**
 * A message could not be published. `unavailable`: no connection, it broke
 * before the PUBACK, or the broker refused the message for now (quota
 * exceeded, say); trying again later may work. `rejected`: the broker or the
 * protocol refuses this message, so retrying it will not help. `inFlight`:
 * the message was sent and then the connection broke. A missing PUBACK, or a
 * connection the client dropped for missing PUBACKs, is not `inFlight`: that
 * is a slow broker, not a message the broker cannot take.
 */
export class MqttPublishError extends Schema.TaggedError<MqttPublishError>()("MqttPublishError", {
  topic: Schema.String,
  reason: Schema.Literals(["unavailable", "rejected"]),
  message: Schema.String,
  inFlight: Schema.optionalKey(Schema.Boolean)
}) {}

/** A connection that lasted this long resets the reconnect backoff. */
const stableConnectionMs = 30_000

/** Publishes in a row whose PUBACK never came before the connection is presumed dead. */
const maxPubackTimeouts = 2

/** Default Maximum Packet Size announced in CONNECT: OT Gateway only receives small control packets. */
const defaultMaximumPacketSize = 1024 * 1024

export interface MqttClientOptions {
  readonly clientId: string
  readonly username?: string
  readonly password?: Redacted.Redacted
  /**
   * `auto` (default): MQTT 5, or 3.1.1 once the broker refuses 5. 3.1.1 has
   * no message expiry, correlation data, No Local or Retain As Published, and
   * the broker announces no limits.
   */
  readonly protocolVersion?: MqttVersionSetting
  /** Keep alive in seconds (default 30). The broker may override it in CONNACK. */
  readonly keepAliveSeconds?: number
  /** Time allowed from dialing to CONNACK (default 10 s). */
  readonly connectTimeout?: Duration.Input
  /**
   * Time a publish may wait for a connection, and then for a free inflight
   * slot (the broker's Receive Maximum) and its PUBACK together (default 10 s each).
   */
  readonly publishTimeout?: Duration.Input
  /**
   * Largest packet accepted from the broker, in bytes (default 1 MiB). It is
   * announced in CONNECT; a larger packet is a protocol error that closes the
   * connection with DISCONNECT 0x95 (§3.1.2.11.4).
   */
  readonly maximumPacketSize?: number
  /**
   * Whether a publish made while disconnected waits for the connection
   * (default true). Turn it off when the caller stores what fails: waiting
   * would stall the caller, and every reading it skips meanwhile is lost.
   * Even then a publish waits for the first dial to finish, so a gateway
   * that has just started does not fail its first messages for nothing.
   */
  readonly waitForConnection?: boolean
  /** Published by the broker if the gateway disappears without a clean DISCONNECT. */
  readonly will?: Will
  /**
   * First and largest delay between reconnect attempts (default 1 s and 15 s,
   * each jittered down by up to half). A low cap keeps the gateway from
   * buffering long after the broker is back.
   */
  readonly reconnectDelay?: { readonly initial: Duration.Input; readonly max: Duration.Input }
  /**
   * Run after every successful connect, in the background, while the
   * connection lasts (it is interrupted if the connection drops). Use it to
   * announce the gateway and restore retained state the broker may have lost.
   */
  readonly onConnect?: (client: MqttClient) => Effect.Effect<void>
  /**
   * Topic filters subscribed on every connect. The session is clean, so
   * nothing sent while the client was away is delivered later: a command
   * reaches the gateway live or not at all.
   */
  readonly subscriptions?: ReadonlyArray<Subscription>
  /**
   * Every message received on a subscription. A QoS 1 message is
   * acknowledged before this runs, so the broker never delivers it twice. It
   * runs on the connection's read loop: hand the message on and return.
   */
  readonly onMessage?: (message: InboundMessage) => Effect.Effect<void>
}

export interface InboundMessage {
  readonly topic: string
  /** The payload as UTF-8 (invalid bytes become U+FFFD). */
  readonly payload: string
  /** Set when the broker sends a retained message on subscribing, not a live one. */
  readonly retain: boolean
  /** What is left of the message's lifetime, in seconds, when the broker sent it (§3.3.2.3.3). */
  readonly messageExpirySeconds?: number
  readonly responseTopic?: string
  readonly correlationData?: Uint8Array
}

export interface PublishOptions {
  readonly qos?: 0 | 1
  readonly retain?: boolean
  /** Echo of a request's correlation data, in an answer (§3.3.2.3.6). */
  readonly correlationData?: Uint8Array
}

/** The live connection: the MQTT spoken and what the broker allowed in CONNACK. */
export interface ConnectionInfo {
  readonly protocolVersion: "5" | "3.1.1"
  /** Unacknowledged QoS 1 publishes the client allows itself (the broker's Receive Maximum, at most 1,000). */
  readonly receiveMaximum: number
  readonly maximumQoS: 0 | 1
  readonly retainAvailable: boolean
  /** Bytes; absent when the broker announced no limit (always in 3.1.1). */
  readonly maximumPacketSize?: number
  /** Seconds, the broker's Server Keep Alive if it sent one. */
  readonly keepAliveSeconds: number
}

export interface MqttClient {
  /** Publish a UTF-8 payload (QoS 1 by default). */
  readonly publish: (topic: string, payload: string, options?: PublishOptions) => Effect.Effect<void, MqttPublishError>
  readonly isConnected: Effect.Effect<boolean>
  /** The live connection, if there is one. */
  readonly connection: Effect.Effect<ConnectionInfo | undefined>
  /** Waits for the first dial: done once it connected, failed with why it did not (later dials go on retrying). */
  readonly firstDial: Effect.Effect<void, MqttConnectionError | MqttRejected>
}

/** What the broker allowed in CONNACK, plus the live connection's writer. */
interface Session {
  readonly version: ProtocolVersion
  readonly info: ConnectionInfo
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, MqttConnectionError>
  readonly inflight: Map<number, Deferred.Deferred<number, MqttConnectionError>>
  readonly inflightLimit: Semaphore.Semaphore
  readonly maximumQoS: 0 | 1
  readonly retainAvailable: boolean
  readonly maximumPacketSize: number
  /** Failing it ends the connection, from outside the read and ping loops. */
  readonly abort: Deferred.Deferred<never, MqttConnectionError>
  nextPacketId: number
  /** Publishes in a row whose PUBACK did not come in time; any PUBACK resets it. */
  pubackTimeouts: number
  /** Set when the client itself dropped the connection for missing PUBACKs: a slow broker, not a bad message. */
  droppedForSilence: boolean
}

const encoder = new TextEncoder()
const lenientDecoder = new TextDecoder()

const numberProperty = (
  properties: ReadonlyMap<number, number | string | Uint8Array>,
  id: number,
  fallback: number
) => {
  const value = properties.get(id)
  return typeof value === "number" ? value : fallback
}

const countConnect = (outcome: "ok" | "failed" | "rejected") =>
  Metric.update(Metric.withAttributes(mqttConnects, { outcome }), 1)

/** A topic name a client may publish to (§4.7): non-empty, no wildcards, at most 65,535 bytes. */
const topicProblem = (topic: string): string | undefined => {
  if (topic.length === 0) return "topic is empty"
  if (topic.includes("+") || topic.includes("#")) return "topic contains a wildcard"
  // A UTF-16 code unit is at most 3 bytes of UTF-8: only a topic that long can be over, so most skip the encoding.
  if (topic.length > 0xffff / 3 && encoder.encode(topic).length > 0xffff) return "topic is longer than 65,535 bytes"
  return undefined
}

/**
 * Start a client on `socket` (for production, `NodeSocket.makeNet` or
 * `makeTls`). The connection loop runs until the surrounding scope closes,
 * which sends DISCONNECT so the broker discards the will.
 */
export const makeMqttClient = Effect.fn("makeMqttClient")(function* (
  socket: Socket.Socket,
  options: MqttClientOptions
) {
  const keepAliveSeconds = options.keepAliveSeconds ?? 30
  const connectTimeout = options.connectTimeout ?? "10 seconds"
  const publishTimeout = options.publishTimeout ?? "10 seconds"
  const maximumPacketSize = options.maximumPacketSize ?? defaultMaximumPacketSize
  const initialDelay = Duration.toMillis(Duration.fromInputUnsafe(options.reconnectDelay?.initial ?? "1 second"))
  const maxDelay = Duration.toMillis(Duration.fromInputUnsafe(options.reconnectDelay?.max ?? "15 seconds"))
  const connected = yield* Latch.make(false)
  // Opens once the first dial has connected or failed.
  const firstDialDone = yield* Latch.make(false)
  // The first dial's outcome, for a caller that wants to know why it failed (`ot-gateway broker`).
  const firstDial = Deferred.makeUnsafe<void, MqttConnectionError | MqttRejected>()
  let session: Session | undefined
  // Starts at 5 unless told otherwise; `auto` moves it to 4 for good when the broker refuses 5.
  let version: ProtocolVersion = options.protocolVersion === "3.1.1" ? 4 : 5
  // Wire order: each publish waits until the one called before it has written its packet or given up.
  let lastTurn: Deferred.Deferred<void> = Deferred.makeUnsafe<void>()
  Deferred.doneUnsafe(lastTurn, Effect.void)

  /** One connection, from dialing until it fails. Never succeeds. */
  /** `onConnected` returns how many dials failed before this one, for the log. */
  const runSession = (onConnected: (at: number) => number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { pull } = yield* socket.reader
        const writer = yield* socket.writer
        // Every write of this session loses the race once the session ends, so a
        // publish suspended on a dead connection never lands on the next one.
        const closed = yield* Deferred.make<never, MqttConnectionError>()
        yield* Effect.addFinalizer(() =>
          Deferred.fail(closed, new MqttConnectionError({ message: "connection closed" }))
        )
        const write = (bytes: Uint8Array) =>
          Effect.raceFirst(
            writer
              .write(bytes)
              .pipe(
                Effect.catchTag("SocketError", (error) =>
                  Effect.fail(new MqttConnectionError({ message: describeSocketError(error) }))
                )
              ),
            Deferred.await(closed)
          )

        /**
         * A protocol error closes the connection: DISCONNECT with the reason
         * first, if it can still be sent (§4.13.1, §4.13.2).
         */
        const protocolError = (reasonCode: number, message: string) =>
          // 3.1.1 has no reason to send, and its DISCONNECT discards the will: there, only close (3.1.1 §4.8).
          (version === 4 ? Effect.void : write(encodeDisconnect(reasonCode))).pipe(
            Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
            Effect.catchTag("MqttConnectionError", () => Effect.void),
            Effect.andThen(Effect.fail(new MqttConnectionError({ message })))
          )

        const frames = makeFrameReader(maximumPacketSize)
        const nextPacket = Effect.gen(function* () {
          while (true) {
            const frame = frames.next()
            switch (frame._tag) {
              case "Packet":
                return frame
              case "Invalid":
                return yield* protocolError(0x81, `unreadable packet: ${frame.message}`)
              case "TooLarge":
                return yield* protocolError(
                  0x95,
                  `broker sent a ${frame.size}-byte packet, above the ${maximumPacketSize}-byte limit`
                )
              case "Incomplete":
                for (const chunk of yield* pull) frames.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
            }
          }
        }).pipe(
          Effect.catchTag("SocketError", (error) =>
            Effect.fail(new MqttConnectionError({ message: describeSocketError(error) }))
          )
        )

        const dialedWith = version
        yield* write(
          encodeConnect({
            protocolVersion: dialedWith,
            clientId: options.clientId,
            keepAliveSeconds,
            cleanStart: true,
            sessionExpirySeconds: 0,
            maximumPacketSize,
            ...(options.username === undefined ? {} : { username: options.username }),
            ...(options.password === undefined ? {} : { password: Redacted.value(options.password) }),
            ...(options.will === undefined ? {} : { will: options.will })
          })
        )
        const connack = yield* Effect.gen(function* () {
          const packet = yield* nextPacket
          if (packet.type !== PacketType.CONNACK) {
            return yield* new MqttConnectionError({ message: `expected CONNACK, got packet type ${packet.type}` })
          }
          const decoded = decodeConnack(packet.body, dialedWith)
          if (Result.isFailure(decoded)) {
            return yield* new MqttConnectionError({ message: `unreadable CONNACK: ${decoded.failure.message}` })
          }
          return decoded.success
        }).pipe(
          Effect.timeoutOrElse({
            duration: connectTimeout,
            orElse: () => Effect.fail(new MqttConnectionError({ message: "no CONNACK in time" }))
          })
        )
        if (dialedWith === 5 && refusesProtocolLevel(connack)) {
          if (options.protocolVersion === "5") {
            return yield* new MqttRejected({
              reasonCode: 0x84,
              message: "broker refused the connection: it does not speak MQTT 5 (set mqtt.version to 3.1.1 or auto)"
            })
          }
          version = 4
          return yield* new MqttDowngrade()
        }
        if (connack.reasonCode >= 0x80) {
          return yield* new MqttRejected({
            reasonCode: connack.reasonCode,
            message: `broker refused the connection: ${connackReasonName(connack.reasonCode)}`
          })
        }

        const props = connack.properties
        // A Receive Maximum or Maximum Packet Size of 0 is a protocol error (§3.2.2.3.3,
        // §3.2.2.3.6); taken at its word, it would leave every QoS 1 publish waiting for good.
        if (props.get(Property.ReceiveMaximum) === 0) {
          return yield* protocolError(0x82, "broker sent Receive Maximum 0 in CONNACK, a protocol error")
        }
        if (props.get(Property.MaximumPacketSize) === 0) {
          return yield* protocolError(0x82, "broker sent Maximum Packet Size 0 in CONNACK, a protocol error")
        }
        const receiveMaximum = Math.min(numberProperty(props, Property.ReceiveMaximum, 65_535), 1_000)
        const announcedPacketSize = props.get(Property.MaximumPacketSize)
        // The broker's Server Keep Alive replaces ours (§3.2.2.3.14). At 0 the broker stops
        // checking on us, but a client may ping whenever it likes (§3.1.2.10), and it still has
        // to notice a dead broker: keep pinging at our own interval then.
        const effectiveKeepAlive = numberProperty(props, Property.ServerKeepAlive, keepAliveSeconds)
        const current: Session = {
          version: dialedWith,
          info: {
            protocolVersion: dialedWith === 5 ? "5" : "3.1.1",
            receiveMaximum,
            maximumQoS: numberProperty(props, Property.MaximumQoS, 2) === 0 ? 0 : 1,
            retainAvailable: numberProperty(props, Property.RetainAvailable, 1) === 1,
            ...(typeof announcedPacketSize === "number" ? { maximumPacketSize: announcedPacketSize } : {}),
            keepAliveSeconds: effectiveKeepAlive
          },
          write,
          inflight: new Map(),
          // Receive Maximum bounds unacknowledged QoS 1 publishes (§3.2.2.3.3).
          inflightLimit: yield* Semaphore.make(receiveMaximum),
          maximumQoS: numberProperty(props, Property.MaximumQoS, 2) === 0 ? 0 : 1,
          retainAvailable: numberProperty(props, Property.RetainAvailable, 1) === 1,
          maximumPacketSize: numberProperty(props, Property.MaximumPacketSize, Number.POSITIVE_INFINITY),
          abort: yield* Deferred.make<never, MqttConnectionError>(),
          nextPacketId: 1,
          pubackTimeouts: 0,
          droppedForSilence: false
        }
        const pingSeconds = effectiveKeepAlive > 0 ? effectiveKeepAlive : keepAliveSeconds

        yield* Effect.addFinalizer((exit) =>
          Effect.gen(function* () {
            session = undefined
            yield* Latch.close(connected)
            yield* Metric.update(mqttConnected, 0)
            const lost = new MqttConnectionError({ message: "connection lost before PUBACK" })
            yield* Effect.forEach(current.inflight.values(), (deferred) => Deferred.fail(deferred, lost), {
              discard: true
            })
            // Only a deliberate close (the client's scope ending) says goodbye: a clean
            // DISCONNECT tells the broker not to publish the will. A broken connection
            // cannot carry it, and the writer would wait for the next one.
            if (Exit.hasInterrupts(exit)) {
              yield* writer.write(encodeDisconnect()).pipe(
                Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.logDebug("DISCONNECT timed out") }),
                Effect.catchTag("SocketError", (error) =>
                  Effect.logDebug("DISCONNECT not sent").pipe(
                    Effect.annotateLogs({ error: describeSocketError(error) })
                  )
                )
              )
            }
          })
        )
        session = current
        const failedBefore = onConnected(yield* monotonicMillis)
        yield* countConnect("ok")
        yield* Metric.update(mqttConnected, 1)
        yield* Latch.open(connected)
        yield* Latch.open(firstDialDone)
        yield* Effect.logInfo("connected to MQTT broker").pipe(
          Effect.annotateLogs({
            keepAlive: effectiveKeepAlive,
            ...(dialedWith === 4 ? { mqtt: "3.1.1" } : {}),
            ...(failedBefore > 0 ? { failedDials: failedBefore } : {})
          })
        )
        if (options.onConnect !== undefined) yield* Effect.forkScoped(options.onConnect(client))
        const subscriptions = options.subscriptions ?? []
        if (subscriptions.length > 0) {
          const packetId = current.nextPacketId
          current.nextPacketId = (packetId % 0xffff) + 1
          yield* write(encodeSubscribe({ packetId, subscriptions }, dialedWith))
        }

        let lastReceived = yield* monotonicMillis
        const readLoop = Effect.gen(function* () {
          while (true) {
            const packet = yield* nextPacket
            lastReceived = yield* monotonicMillis
            switch (packet.type) {
              case PacketType.PUBACK: {
                const puback = decodePuback(packet.body)
                if (Result.isSuccess(puback)) {
                  current.pubackTimeouts = 0
                  const deferred = current.inflight.get(puback.success.packetId)
                  if (deferred !== undefined) yield* Deferred.succeed(deferred, puback.success.reasonCode)
                }
                break
              }
              case PacketType.DISCONNECT: {
                const disconnect = decodeDisconnect(packet.body)
                const reason = Result.isSuccess(disconnect)
                  ? `0x${disconnect.success.reasonCode.toString(16)}${disconnect.success.reasonString === undefined ? "" : ` ${disconnect.success.reasonString}`}`
                  : "unreadable reason"
                return yield* new MqttConnectionError({ message: `broker disconnected: ${reason}` })
              }
              case PacketType.PUBLISH: {
                const publish = decodePublish(packet.flags, packet.body, dialedWith)
                if (Result.isFailure(publish)) {
                  return yield* protocolError(0x81, `unreadable PUBLISH: ${publish.failure.message}`)
                }
                const { topic, payload, retain, packetId, messageExpirySeconds, responseTopic, correlationData } =
                  publish.success
                // Acknowledged on receipt: once the broker has the PUBACK it never sends this again.
                if (packetId !== undefined) yield* write(encodePuback(packetId, 0, dialedWith))
                if (options.onMessage !== undefined) {
                  yield* options.onMessage({
                    topic,
                    payload: lenientDecoder.decode(payload),
                    retain,
                    ...(messageExpirySeconds === undefined ? {} : { messageExpirySeconds }),
                    ...(responseTopic === undefined ? {} : { responseTopic }),
                    ...(correlationData === undefined ? {} : { correlationData })
                  })
                }
                break
              }
              case PacketType.SUBACK: {
                const suback = decodeSuback(packet.body, dialedWith)
                const refused = Result.isSuccess(suback)
                  ? subscriptions.filter((_, index) => (suback.success.reasonCodes[index] ?? 0x80) >= 0x80)
                  : subscriptions
                if (refused.length > 0) {
                  yield* Effect.logError(
                    "MQTT broker refused a subscription; nothing published on it will arrive"
                  ).pipe(
                    Effect.annotateLogs({ filters: refused.map((subscription) => subscription.filter).join(", ") })
                  )
                }
                break
              }
              // PINGRESP only refreshes lastReceived; anything else is unexpected and ignored.
              default:
            }
          }
        })
        // Ping at half the keep alive; give up when the broker has been silent
        // for 1.5 keep alives (§3.1.2.10 lets the broker wait that long too).
        const pingLoop = Effect.gen(function* () {
          if (pingSeconds === 0) return yield* Effect.never
          while (true) {
            yield* Effect.sleep(Duration.seconds(pingSeconds / 2))
            const silentFor = (yield* monotonicMillis) - lastReceived
            if (silentFor > pingSeconds * 1500) {
              return yield* new MqttConnectionError({ message: `broker silent for ${Math.round(silentFor / 1000)} s` })
            }
            // A write stuck on a half-open connection would keep the silence check from ever running.
            yield* write(encodePingreq()).pipe(
              Effect.timeoutOrElse({
                duration: Duration.seconds(pingSeconds / 2),
                orElse: () => Effect.fail(new MqttConnectionError({ message: "could not send PINGREQ" }))
              })
            )
          }
        })
        return yield* Effect.raceFirst(readLoop, Effect.raceFirst(pingLoop, Deferred.await(current.abort)))
      })
    ).pipe(
      Effect.catchTag("SocketError", (error) =>
        Effect.fail(new MqttConnectionError({ message: describeSocketError(error) }))
      )
    )

  const connectionLoop = Effect.gen(function* () {
    let failures = 0
    /**
     * Why the last dial failed, while the broker cannot be reached. A broker
     * that stays down fails every redial (every 15 s at most): each one is
     * counted, but only a new reason is logged, and the next connect says
     * how many dials it took.
     */
    let unreachable: string | undefined
    let failedDials = 0
    const dialFailed = (reason: string, log: Effect.Effect<void>) =>
      Effect.suspend(() => {
        failedDials++
        if (reason === unreachable) return Effect.logDebug("MQTT dial failed again")
        unreachable = reason
        return log
      })
    while (true) {
      let connectedAt: number | undefined
      const outcome = yield* runSession((at) => {
        connectedAt = at
        Deferred.doneUnsafe(firstDial, Effect.void)
        unreachable = undefined
        const dials = failedDials
        failedDials = 0
        return dials
      }).pipe(
        Effect.catchTags({
          MqttDowngrade: () =>
            Effect.as(
              Effect.logInfo("MQTT broker does not speak MQTT 5, connecting with MQTT 3.1.1"),
              "redial" as const
            ),
          MqttRejected: (error) =>
            Effect.sync(() => Deferred.doneUnsafe(firstDial, Effect.fail(error))).pipe(
              Effect.andThen(countConnect("rejected")),
              Effect.andThen(
                dialFailed(
                  `rejected ${error.reasonCode}`,
                  Effect.logError("MQTT broker refused the connection").pipe(
                    Effect.annotateLogs({ reason: error.message, reasonCode: error.reasonCode })
                  )
                )
              )
            ),
          MqttConnectionError: (error) =>
            connectedAt !== undefined
              ? Effect.logWarning("MQTT connection lost").pipe(Effect.annotateLogs({ error: error.message }))
              : Effect.sync(() => Deferred.doneUnsafe(firstDial, Effect.fail(error))).pipe(
                  Effect.andThen(countConnect("failed")),
                  Effect.andThen(
                    dialFailed(
                      "unreachable",
                      Effect.logWarning("MQTT connect failed, retrying").pipe(
                        Effect.annotateLogs({ error: error.message })
                      )
                    )
                  )
                )
        })
      )
      // Straight back with 3.1.1: the broker answered, so this is no failed dial.
      if (outcome === "redial") continue
      yield* Latch.open(firstDialDone)
      // Back off unless the connection held for a while: a broker that accepts and then
      // drops the client at once (a session taken over by a twin with the same client
      // id, a quota) must not be redialed every second.
      const heldFor = connectedAt === undefined ? 0 : (yield* monotonicMillis) - connectedAt
      failures = heldFor >= stableConnectionMs ? 0 : failures + 1
      const base = Math.min(maxDelay, initialDelay * 2 ** Math.max(0, failures - 1))
      // Full jitter between half and all of the delay, so many gateways do not reconnect in step.
      yield* Effect.sleep(Duration.millis(base * (0.5 + (yield* Random.next) / 2)))
    }
  })

  const publish: MqttClient["publish"] = (topic, payload, publishOptions = {}) =>
    Effect.suspend(() => {
      // Set once the PUBLISH is on the wire, so a failure after it is reported as in flight.
      // `inFlight` blames the message for a broken connection. A missing PUBACK is a slow or
      // overloaded broker, which says nothing about the message, so it never counts.
      let sent = false
      let blameless = false
      let used: Session | undefined
      const previousTurn = lastTurn
      const turn = Deferred.makeUnsafe<void>()
      lastTurn = turn
      const passTurn = Effect.sync(() => Deferred.doneUnsafe(turn, Effect.void))
      return Effect.gen(function* () {
        const rejected = (message: string) => new MqttPublishError({ topic, reason: "rejected", message })
        const problem = topicProblem(topic)
        if (problem !== undefined) return yield* rejected(problem)
        const notConnected = () => new MqttConnectionError({ message: "not connected to the broker" })
        const withinPublishTimeout = Effect.timeoutOrElse({
          duration: publishTimeout,
          orElse: () => Effect.fail(notConnected())
        })
        if (options.waitForConnection === false) {
          // Told not to wait: once the first dial is over, no connection fails now instead of queueing behind others.
          yield* firstDialDone.await.pipe(withinPublishTimeout)
          if (session === undefined) return yield* notConnected()
          yield* Deferred.await(previousTurn).pipe(withinPublishTimeout)
        } else {
          yield* Deferred.await(previousTurn).pipe(Effect.andThen(connected.await), withinPublishTimeout)
        }
        const current = session
        if (current === undefined) return yield* new MqttConnectionError({ message: "not connected to the broker" })
        used = current
        const retain = publishOptions.retain === true
        if (retain && !current.retainAvailable) {
          return yield* rejected("the broker does not support retained messages")
        }
        // The broker's Maximum QoS caps what the client may send (§3.2.2.3.4).
        const qos = Math.min(publishOptions.qos ?? 1, current.maximumQoS) === 0 ? 0 : 1
        const bytes = encoder.encode(payload)
        const correlation =
          publishOptions.correlationData === undefined ? {} : { correlationData: publishOptions.correlationData }

        if (qos === 0) {
          const packet = encodePublish({ topic, payload: bytes, qos: 0, retain, ...correlation }, current.version)
          if (packet.length > current.maximumPacketSize) {
            return yield* rejected(`message exceeds the broker's ${current.maximumPacketSize} byte limit`)
          }
          return yield* current.write(packet).pipe(Effect.ensuring(passTurn))
        }

        // One deadline covers waiting for an inflight slot (Receive Maximum), sending and the PUBACK.
        const reasonCode = yield* Semaphore.withPermit(
          current.inflightLimit,
          Effect.gen(function* () {
            let packetId = current.nextPacketId
            while (current.inflight.has(packetId)) packetId = (packetId % 0xffff) + 1
            current.nextPacketId = (packetId % 0xffff) + 1
            const packet = encodePublish(
              { topic, payload: bytes, qos: 1, retain, packetId, ...correlation },
              current.version
            )
            if (packet.length > current.maximumPacketSize) {
              return yield* rejected(`message exceeds the broker's ${current.maximumPacketSize} byte limit`)
            }
            const acked = yield* Deferred.make<number, MqttConnectionError>()
            current.inflight.set(packetId, acked)
            return yield* Effect.gen(function* () {
              yield* current.write(packet).pipe(Effect.ensuring(passTurn))
              sent = true
              return yield* Deferred.await(acked)
            }).pipe(Effect.ensuring(Effect.sync(() => current.inflight.delete(packetId))))
          })
        ).pipe(
          Effect.timeoutOrElse({
            duration: publishTimeout,
            orElse: () =>
              Effect.gen(function* () {
                if (!sent) return yield* new MqttConnectionError({ message: "no free inflight slot in time" })
                blameless = true
                // A connection that answers pings but acknowledges nothing is no use: after a few
                // PUBACKs in a row fail to come, drop it and dial again.
                current.pubackTimeouts++
                if (current.pubackTimeouts >= maxPubackTimeouts) {
                  current.droppedForSilence = true
                  yield* Deferred.fail(
                    current.abort,
                    new MqttConnectionError({ message: `no PUBACK for ${current.pubackTimeouts} publishes in a row` })
                  )
                }
                return yield* new MqttConnectionError({ message: "no PUBACK in time" })
              })
          })
        )
        if (reasonCode >= 0x80) {
          const message = `broker refused the message: reason 0x${reasonCode.toString(16)}`
          // Only some codes refuse the message itself; the rest (quota exceeded, say) may pass later.
          if (pubackRefusesMessage(reasonCode)) return yield* rejected(message)
          return yield* new MqttPublishError({ topic, reason: "unavailable", message })
        }
      }).pipe(
        Effect.ensuring(passTurn),
        Effect.catchTag("MqttConnectionError", (error) =>
          Effect.fail(
            new MqttPublishError({
              topic,
              reason: "unavailable",
              message: error.message,
              ...(sent && !blameless && used?.droppedForSilence !== true ? { inFlight: true } : {})
            })
          )
        )
      )
    })

  const client: MqttClient = {
    publish,
    isConnected: Effect.sync(() => session !== undefined),
    connection: Effect.sync(() => session?.info),
    firstDial: Deferred.await(firstDial)
  }
  // Started last, so `onConnect` always receives a finished client.
  yield* Effect.forkScoped(connectionLoop)
  return client
})
