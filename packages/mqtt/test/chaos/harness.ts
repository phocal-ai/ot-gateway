/**
 * A scriptable MQTT broker for chaos tests: each test decides how the broker
 * answers CONNECT and every PUBLISH, and can write raw bytes after CONNACK.
 */
import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { Effect, Result } from "effect"
import type * as Socket from "effect/socket/Socket"
import type * as SocketServer from "effect/socket/SocketServer"
import { makeMqttClient } from "../../src/Client.ts"
import type { MqttClientOptions } from "../../src/Client.ts"
import { PacketType } from "../../src/Codec.ts"
import {
  decodeDisconnect,
  decodePublish,
  encodeConnack,
  encodeDisconnect,
  encodePingresp,
  encodePuback,
  makeFrameReader
} from "../../src/Packet.ts"

export type PublishAction =
  | { readonly _tag: "ack"; readonly reason?: number }
  | { readonly _tag: "drop" }
  | { readonly _tag: "close" }
  | { readonly _tag: "disconnect"; readonly reason: number }

export interface Received {
  readonly connection: number
  readonly topic: string
  readonly payload: string
  readonly packetId: number | undefined
}

export interface Script {
  connack: (connection: number) => { readonly reason: number; readonly properties?: Map<number, number> }
  onPublish: (message: Received, index: number) => PublishAction
  answerPings: boolean
  /** Raw bytes to write right after CONNACK. */
  afterConnack?: (
    connection: number,
    write: (bytes: Uint8Array) => Effect.Effect<void, Socket.SocketError>
  ) => Effect.Effect<void, Socket.SocketError>
  readonly received: Array<Received>
  /** Reason codes of the DISCONNECTs clients sent. */
  readonly disconnects: Array<number>
  connections: number
}

export const makeScript = (): Script => ({
  connack: () => ({ reason: 0 }),
  onPublish: () => ({ _tag: "ack" }),
  answerPings: true,
  received: [],
  disconnects: [],
  connections: 0
})

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const serve = (script: Script) =>
  Effect.fnUntraced(
    function* (socket: Socket.Socket) {
      const writer = yield* socket.writer
      const { pull } = yield* socket.reader
      const connection = ++script.connections
      const frames = makeFrameReader()
      while (true) {
        for (const chunk of yield* pull) frames.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
        let frame = frames.next()
        while (frame._tag === "Packet") {
          switch (frame.type) {
            case PacketType.CONNECT: {
              const connack = script.connack(connection)
              yield* writer.write(encodeConnack(connack.reason, connack.properties ?? new Map()))
              if (connack.reason >= 0x80) return
              if (script.afterConnack !== undefined) yield* script.afterConnack(connection, writer.write)
              break
            }
            case PacketType.PUBLISH: {
              const publish = decodePublish(frame.flags, frame.body)
              if (Result.isFailure(publish)) return
              const message: Received = {
                connection,
                topic: publish.success.topic,
                payload: decoder.decode(publish.success.payload),
                packetId: publish.success.packetId
              }
              script.received.push(message)
              const action = script.onPublish(message, script.received.length - 1)
              const packetId = publish.success.packetId
              if (packetId === undefined) break
              switch (action._tag) {
                case "ack":
                  yield* writer.write(encodePuback(packetId, action.reason ?? 0))
                  break
                case "drop":
                  break
                case "close":
                  return
                case "disconnect":
                  yield* writer.write(encodeDisconnect(action.reason))
                  return
              }
              break
            }
            case PacketType.PINGREQ:
              if (script.answerPings) yield* writer.write(encodePingresp())
              break
            case PacketType.DISCONNECT: {
              const disconnect = decodeDisconnect(frame.body)
              script.disconnects.push(Result.isSuccess(disconnect) ? disconnect.success.reasonCode : -1)
              return
            }
            default:
              return
          }
          frame = frames.next()
        }
        if (frame._tag !== "Incomplete") return
      }
    },
    Effect.scoped,
    Effect.catchTag("SocketError", () => Effect.void)
  )

const portOf = (server: SocketServer.SocketServer["Service"]) =>
  server.address._tag === "UnixPathAddress" ? 0 : server.address.port

/** Serve `script` on a free local port for the current scope; returns the port. */
export const startScriptedBroker = (script: Script) =>
  Effect.gen(function* () {
    const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
    yield* server.run(serve(script)).pipe(Effect.forkScoped)
    return portOf(server)
  })

export const fastOptions = {
  clientId: "chaos",
  connectTimeout: "1 second",
  publishTimeout: "500 millis",
  reconnectDelay: { initial: "20 millis", max: "100 millis" }
} satisfies MqttClientOptions

export const clientOn = (port: number, options: Partial<MqttClientOptions> = {}) =>
  Effect.flatMap(NodeSocket.makeNet({ host: "127.0.0.1", port, openTimeout: "1 second" }), (socket) =>
    makeMqttClient(socket, { ...fastOptions, ...options })
  )

/** Poll until `condition` holds; returns whether it did within `timeoutMs`. */
export const waitUntil = (condition: () => boolean, timeoutMs = 3000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (Date.now() > deadline) return false
      yield* Effect.sleep("10 millis")
    }
    return true
  })
