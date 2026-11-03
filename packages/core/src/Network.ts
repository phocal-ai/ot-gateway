/**
 * How the gateway reaches its devices and its broker: TCP connections and UDP
 * endpoints. The drivers and the MQTT publisher open their sockets through a
 * `Network` when one is given and through Node's otherwise, so the whole
 * gateway can run against an in-memory network (`MemoryNetwork.ts`) under the
 * test clock.
 */
import type { Duration, Effect } from "effect"
import type * as DatagramSocket from "effect/socket/DatagramSocket"
import type * as Socket from "effect/socket/Socket"

export interface TcpOptions {
  readonly host: string
  readonly port: number
  /** How long opening the connection may take before the reader fails with a `Timeout` open error. */
  readonly openTimeout: Duration.Input
}

export interface UdpOptions {
  /** The local address to bind; `0.0.0.0` is every address of the host. */
  readonly address: string
  readonly port: number
}

export interface Network {
  /** A TCP connection, opened when its reader is acquired (like `NodeSocket.makeNet`). */
  readonly tcp: (options: TcpOptions) => Effect.Effect<Socket.Socket>
  /** A UDP endpoint with broadcast enabled, bound when its reader is acquired (like `NodeDatagramSocket.make`). */
  readonly udp: (options: UdpOptions) => Effect.Effect<DatagramSocket.DatagramSocket>
}
