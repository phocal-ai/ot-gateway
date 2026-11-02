/**
 * MQTT 5 publishing client: one broker connection, kept alive and re-opened
 * with jittered exponential backoff for as long as the client's scope lives.
 *
 * Publishing never queues across outages: while disconnected, a publish
 * waits up to `publishTimeout` for the connection and then fails, so the
 * caller decides what to retry (the pipeline retries a value on the next
 * cycle; durable store-and-forward is v0.2). QoS 1 publishes complete on
 * PUBACK. The session is clean (no session state survives a reconnect), so
 * nothing unacknowledged is resent behind the caller's back.
 */
import { describeSocketError, mqttConnected, mqttConnects } from "@plenum/core"
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Latch,
  Metric,
  Random,
  Redacted,
  Result,
  Schema,
  Semaphore
} from "effect"
import type * as Socket from "effect/socket/Socket"
import { PacketType } from "./Codec.ts"
import {
  connackReasonName,
  decodeConnack,
  decodeDisconnect,
  decodePuback,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePublish,
  Property,
  takePacket
} from "./Packet.ts"
import type { Will } from "./Packet.ts"

/** The connection could not be opened, broke, or the broker stopped answering. */
export class MqttConnectionError extends Schema.TaggedError<MqttConnectionError>()("MqttConnectionError", {
  message: Schema.String
}) {}

/** The broker refused the connection (CONNACK reason code 0x80 or above). */
export class MqttRejected extends Schema.TaggedError<MqttRejected>()("MqttRejected", {
  reasonCode: Schema.Int,
  message: Schema.String
}) {}

/** A message could not be published. */
export class MqttPublishError extends Schema.TaggedError<MqttPublishError>()("MqttPublishError", {
  topic: Schema.String,
  message: Schema.String
}) {}

export interface MqttClientOptions {
  readonly clientId: string
  readonly username?: string
  readonly password?: Redacted.Redacted
  /** Keep alive in seconds (default 30). The broker may override it in CONNACK. */
  readonly keepAliveSeconds?: number
  /** Time allowed from dialing to CONNACK (default 10 s). */
  readonly connectTimeout?: Duration.Input
  /** Time a publish may wait for a connection, and then for its PUBACK (default 10 s each). */
  readonly publishTimeout?: Duration.Input
  /** Published by the broker if the gateway disappears without a clean DISCONNECT. */
  readonly will?: Will
  /** First and largest delay between reconnect attempts (default 1 s and 60 s). */
  readonly reconnectDelay?: { readonly initial: Duration.Input; readonly max: Duration.Input }
}

export interface PublishOptions {
  readonly qos?: 0 | 1
  readonly retain?: boolean
}

export interface MqttClient {
  /** Publish a UTF-8 payload (QoS 1 by default). */
  readonly publish: (topic: string, payload: string, options?: PublishOptions) => Effect.Effect<void, MqttPublishError>
  readonly isConnected: Effect.Effect<boolean>
}

/** What the broker allowed in CONNACK, plus the live connection's writer. */
interface Session {
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, MqttConnectionError>
  readonly inflight: Map<number, Deferred.Deferred<number, MqttConnectionError>>
  readonly inflightLimit: Semaphore.Semaphore
  readonly maximumQoS: 0 | 1
  readonly retainAvailable: boolean
  readonly maximumPacketSize: number
  nextPacketId: number
}

const encoder = new TextEncoder()

const appendBytes = (buffer: Uint8Array, chunks: ReadonlyArray<Uint8Array | string>): Uint8Array => {
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

const numberProperty = (properties: ReadonlyMap<number, number | string>, id: number, fallback: number) => {
  const value = properties.get(id)
  return typeof value === "number" ? value : fallback
}

const countConnect = (outcome: "ok" | "failed" | "rejected") =>
  Metric.update(Metric.withAttributes(mqttConnects, { outcome }), 1)

/** A topic name a client may publish to (§4.7): non-empty, no wildcards, at most 65,535 bytes. */
const topicProblem = (topic: string): string | undefined => {
  if (topic.length === 0) return "topic is empty"
  if (topic.includes("+") || topic.includes("#")) return "topic contains a wildcard"
  if (encoder.encode(topic).length > 0xffff) return "topic is longer than 65,535 bytes"
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
  const initialDelay = Duration.toMillis(Duration.fromInputUnsafe(options.reconnectDelay?.initial ?? "1 second"))
  const maxDelay = Duration.toMillis(Duration.fromInputUnsafe(options.reconnectDelay?.max ?? "60 seconds"))
  const connected = yield* Latch.make(false)
  let session: Session | undefined

  /** One connection, from dialing until it fails. Never succeeds. */
  const runSession = (onConnected: () => void) =>
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

        let buffer: Uint8Array = new Uint8Array(0)
        const nextPacket = Effect.gen(function* () {
          while (true) {
            const split = takePacket(buffer)
            switch (split._tag) {
              case "Packet":
                buffer = split.rest
                return split
              case "Invalid":
                return yield* new MqttConnectionError({ message: `unreadable packet: ${split.message}` })
              case "Incomplete":
                buffer = appendBytes(buffer, yield* pull)
            }
          }
        }).pipe(
          Effect.catchTag("SocketError", (error) =>
            Effect.fail(new MqttConnectionError({ message: describeSocketError(error) }))
          )
        )

        yield* write(
          encodeConnect({
            clientId: options.clientId,
            keepAliveSeconds,
            cleanStart: true,
            sessionExpirySeconds: 0,
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
          const decoded = decodeConnack(packet.body)
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
        if (connack.reasonCode >= 0x80) {
          return yield* new MqttRejected({
            reasonCode: connack.reasonCode,
            message: `broker refused the connection: ${connackReasonName(connack.reasonCode)}`
          })
        }

        const props = connack.properties
        const current: Session = {
          write,
          inflight: new Map(),
          // Receive Maximum bounds unacknowledged QoS 1 publishes (§3.2.2.3.3).
          inflightLimit: yield* Semaphore.make(Math.min(numberProperty(props, Property.ReceiveMaximum, 65_535), 1_000)),
          maximumQoS: numberProperty(props, Property.MaximumQoS, 2) === 0 ? 0 : 1,
          retainAvailable: numberProperty(props, Property.RetainAvailable, 1) === 1,
          maximumPacketSize: numberProperty(props, Property.MaximumPacketSize, Number.POSITIVE_INFINITY),
          nextPacketId: 1
        }
        const effectiveKeepAlive = numberProperty(props, Property.ServerKeepAlive, keepAliveSeconds)

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
              yield* writer.write(encodeDisconnect()).pipe(Effect.timeout("1 second"), Effect.ignore)
            }
          })
        )
        session = current
        onConnected()
        yield* countConnect("ok")
        yield* Metric.update(mqttConnected, 1)
        yield* Latch.open(connected)
        yield* Effect.logInfo("connected to MQTT broker").pipe(Effect.annotateLogs({ keepAlive: effectiveKeepAlive }))

        let lastReceived = yield* Clock.currentTimeMillis
        const readLoop = Effect.gen(function* () {
          while (true) {
            const packet = yield* nextPacket
            lastReceived = yield* Clock.currentTimeMillis
            switch (packet.type) {
              case PacketType.PUBACK: {
                const puback = decodePuback(packet.body)
                if (Result.isSuccess(puback)) {
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
              // PINGRESP only refreshes lastReceived. Nothing is subscribed yet,
              // so any other packet is unexpected and ignored.
              default:
            }
          }
        })
        // Ping at half the keep alive; give up when the broker has been silent
        // for 1.5 keep alives (§3.1.2.10 lets the broker wait that long too).
        const pingLoop = Effect.gen(function* () {
          if (effectiveKeepAlive === 0) return yield* Effect.never
          while (true) {
            yield* Effect.sleep(Duration.seconds(effectiveKeepAlive / 2))
            const silentFor = (yield* Clock.currentTimeMillis) - lastReceived
            if (silentFor > effectiveKeepAlive * 1500) {
              return yield* new MqttConnectionError({ message: `broker silent for ${Math.round(silentFor / 1000)} s` })
            }
            yield* write(encodePingreq())
          }
        })
        return yield* Effect.raceFirst(readLoop, pingLoop)
      })
    ).pipe(
      Effect.catchTag("SocketError", (error) =>
        Effect.fail(new MqttConnectionError({ message: describeSocketError(error) }))
      )
    )

  const connectionLoop = Effect.gen(function* () {
    let failures = 0
    while (true) {
      let wasConnected = false
      yield* runSession(() => {
        wasConnected = true
      }).pipe(
        Effect.catchTags({
          MqttRejected: (error) =>
            countConnect("rejected").pipe(
              Effect.andThen(Effect.logError("MQTT broker refused the connection")),
              Effect.annotateLogs({ reason: error.message, reasonCode: error.reasonCode })
            ),
          MqttConnectionError: (error) =>
            wasConnected
              ? Effect.logWarning("MQTT connection lost").pipe(Effect.annotateLogs({ error: error.message }))
              : countConnect("failed").pipe(
                  Effect.andThen(Effect.logWarning("MQTT connect failed")),
                  Effect.annotateLogs({ error: error.message })
                )
        })
      )
      failures = wasConnected ? 0 : failures + 1
      const base = Math.min(maxDelay, initialDelay * 2 ** Math.max(0, failures - 1))
      // Full jitter between half and all of the delay, so many gateways do not reconnect in step.
      yield* Effect.sleep(Duration.millis(base * (0.5 + (yield* Random.next) / 2)))
    }
  })
  yield* Effect.forkScoped(connectionLoop)

  const publish: MqttClient["publish"] = (topic, payload, publishOptions = {}) =>
    Effect.gen(function* () {
      const problem = topicProblem(topic)
      if (problem !== undefined) return yield* new MqttConnectionError({ message: problem })
      yield* connected.await.pipe(
        Effect.timeoutOrElse({
          duration: publishTimeout,
          orElse: () => Effect.fail(new MqttConnectionError({ message: "not connected to the broker" }))
        })
      )
      const current = session
      if (current === undefined) return yield* new MqttConnectionError({ message: "not connected to the broker" })
      const retain = publishOptions.retain === true
      if (retain && !current.retainAvailable) {
        return yield* new MqttConnectionError({ message: "the broker does not support retained messages" })
      }
      // The broker's Maximum QoS caps what the client may send (§3.2.2.3.4).
      const qos = Math.min(publishOptions.qos ?? 1, current.maximumQoS) === 0 ? 0 : 1
      const bytes = encoder.encode(payload)

      if (qos === 0) {
        const packet = encodePublish({ topic, payload: bytes, qos: 0, retain })
        if (packet.length > current.maximumPacketSize) {
          return yield* new MqttConnectionError({
            message: `message exceeds the broker's ${current.maximumPacketSize} byte limit`
          })
        }
        return yield* current.write(packet)
      }

      return yield* Semaphore.withPermit(
        current.inflightLimit,
        Effect.gen(function* () {
          let packetId = current.nextPacketId
          while (current.inflight.has(packetId)) packetId = (packetId % 0xffff) + 1
          current.nextPacketId = (packetId % 0xffff) + 1
          const packet = encodePublish({ topic, payload: bytes, qos: 1, retain, packetId })
          if (packet.length > current.maximumPacketSize) {
            return yield* new MqttConnectionError({
              message: `message exceeds the broker's ${current.maximumPacketSize} byte limit`
            })
          }
          const acked = yield* Deferred.make<number, MqttConnectionError>()
          current.inflight.set(packetId, acked)
          const reasonCode = yield* current.write(packet).pipe(
            Effect.andThen(Deferred.await(acked)),
            Effect.timeoutOrElse({
              duration: publishTimeout,
              orElse: () => Effect.fail(new MqttConnectionError({ message: "no PUBACK in time" }))
            }),
            Effect.ensuring(Effect.sync(() => current.inflight.delete(packetId)))
          )
          if (reasonCode >= 0x80) {
            return yield* new MqttConnectionError({
              message: `broker refused the message: reason 0x${reasonCode.toString(16)}`
            })
          }
        })
      )
    }).pipe(
      Effect.catchTag("MqttConnectionError", (error) =>
        Effect.fail(new MqttPublishError({ topic, message: error.message }))
      )
    )

  const client: MqttClient = { publish, isConnected: Effect.sync(() => session !== undefined) }
  return client
})
