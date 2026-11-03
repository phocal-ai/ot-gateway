/**
 * An in-memory network for simulating the whole gateway under the test
 * clock: TCP connections, TCP listeners and UDP endpoints between named hosts,
 * implementing Effect's `Socket`, `SocketServer` and `DatagramSocket` the way
 * the Node adapters behave, so the real drivers, broker and simulators run on
 * it unchanged.
 *
 * - A connection to a port nobody listens on is refused at once.
 * - Closing one end (its reader's scope, or writing a `CloseEvent`) delivers
 *   the bytes already sent and then end-of-stream to the other end. A
 *   listener whose scope closes (a crash) closes every connection it accepted.
 * - A partitioned host is unreachable, as when its cable is pulled: bytes and
 *   closes on its connections are held, not lost, and arrive in order once it
 *   heals (TCP retransmits), so a peer that closed meanwhile is only noticed
 *   then (a half-open connection). Connecting to or from it hangs until it
 *   heals or the open timeout passes. Its datagrams are lost.
 * - A host can lose a share of its datagrams, drawn from the `random`
 *   function the network was made with, so a seeded run is reproducible.
 *
 * Delivery is immediate: time only passes in the programs using the network.
 */
import { Effect, Latch, Scope } from "effect"
import * as Arr from "effect/Array"
import * as NetAddress from "effect/net/NetAddress"
import * as DatagramSocket from "effect/socket/DatagramSocket"
import * as Socket from "effect/socket/Socket"
import * as SocketServer from "effect/socket/SocketServer"
import type { Network, TcpOptions, UdpOptions } from "./Network.ts"

/** One direction of a connection, or a UDP endpoint's receive queue: items in order, then the end. */
interface Inbox<A, E> {
  readonly push: (item: A) => void
  /** End after the items already queued (EOF). */
  readonly end: (error: E) => void
  /** End now, discarding what is queued (teardown). */
  readonly reset: (error: E) => void
  readonly pull: Effect.Effect<Arr.NonEmptyReadonlyArray<A>, E>
}

const makeInbox = <A, E>(): Inbox<A, E> => {
  let items: Array<A> = []
  let ended: E | undefined
  let waiter: ((effect: Effect.Effect<Arr.NonEmptyReadonlyArray<A>, E>) => void) | undefined
  const wake = () => {
    const resume = waiter
    if (resume === undefined) return
    const batch = items
    if (Arr.isReadonlyArrayNonEmpty(batch)) {
      items = []
      waiter = undefined
      resume(Effect.succeed(batch))
    } else if (ended !== undefined) {
      waiter = undefined
      resume(Effect.fail(ended))
    }
  }
  return {
    push: (item) => {
      if (ended !== undefined) return
      items.push(item)
      wake()
    },
    end: (error) => {
      ended ??= error
      wake()
    },
    reset: (error) => {
      ended ??= error
      items = []
      wake()
    },
    pull: Effect.callback<Arr.NonEmptyReadonlyArray<A>, E>((resume) => {
      waiter = resume
      wake()
      return Effect.sync(() => {
        if (waiter === resume) waiter = undefined
      })
    })
  }
}

interface Side {
  readonly host: string
  readonly inbox: Inbox<Uint8Array, Socket.SocketError>
  closed: boolean
}

type Segment = { readonly _tag: "data"; readonly bytes: Uint8Array } | { readonly _tag: "end" }

interface Connection {
  readonly client: Side
  readonly server: Side
  /** Segments waiting for a partition to heal, in the order they were sent. */
  readonly held: Array<{ readonly to: Side; readonly from: Side; readonly segment: Segment }>
}

interface Binding {
  readonly host: string
  readonly port: number
  readonly address: NetAddress.InetAddress
  readonly inbox: Inbox<DatagramSocket.Datagram, DatagramSocket.DatagramSocketError>
}

export interface MemoryNetworkStats {
  /** Connections with at least one end still open. */
  readonly connections: number
  /** Open connection ends per host. */
  readonly openEnds: ReadonlyMap<string, number>
  readonly listeners: number
  readonly udpEndpoints: number
  readonly datagramsDelivered: number
  readonly datagramsLost: number
}

export interface MemoryNetwork {
  /** The network as one host sees it: its connections and datagrams come from `ip`. */
  readonly host: (ip: string) => Network
  /** Listen for TCP connections on `ip:port` until the scope closes, which drops every connection (a crash). */
  readonly listen: (ip: string, port: number) => Effect.Effect<SocketServer.SocketServer["Service"], never, Scope.Scope>
  /** Cut a host off (or reconnect it). */
  readonly partition: (ip: string, partitioned: boolean) => void
  /** The share of datagrams to or from `ip` that is lost, 0 to 1. */
  readonly setLoss: (ip: string, loss: number) => void
  readonly stats: () => MemoryNetworkStats
}

const encoder = new TextEncoder()
const bytesOf = (chunk: Uint8Array | string) =>
  typeof chunk === "string" ? encoder.encode(chunk) : new Uint8Array(chunk)
const keyOf = (ip: string, port: number) => `${ip}:${port}`

const closeError = (code: 1000 | 1006) => new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) })
const refused = (target: string) =>
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({ kind: "Unknown", cause: new Error(`connect ECONNREFUSED ${target}`) })
  })
const openTimeout = new Socket.SocketError({
  reason: new Socket.SocketOpenError({ kind: "Timeout", cause: new Error("Connection timed out") })
})
const writeClosed = new Socket.SocketError({
  reason: new Socket.SocketWriteError({ cause: new Error("socket closed") })
})
const datagramClosed = new DatagramSocket.DatagramSocketError({
  reason: new DatagramSocket.DatagramSocketClosedError({})
})

/** Hand a segment to the end it was sent to; an end that closed takes nothing. */
const apply = (to: Side, segment: Segment) => {
  if (to.closed) return
  if (segment._tag === "data") to.inbox.push(segment.bytes)
  else to.inbox.end(closeError(1000))
}

/** A network of hosts named by IPv4 address; `random` draws datagram losses (pass a seeded one). */
export const makeMemoryNetwork = (random: () => number = Math.random): MemoryNetwork => {
  const listeners = new Map<string, (connection: Connection) => void>()
  const connections = new Set<Connection>()
  const bindings = new Map<string, Binding>()
  const partitioned = new Set<string>()
  const loss = new Map<string, number>()
  let datagramsDelivered = 0
  let datagramsLost = 0

  const reachable = (...hosts: ReadonlyArray<string>) => hosts.every((host) => !partitioned.has(host))

  const send = (connection: Connection, from: Side, segment: Segment) => {
    const to = from === connection.client ? connection.server : connection.client
    if (connection.held.length > 0 || !reachable(from.host, to.host)) connection.held.push({ to, from, segment })
    else apply(to, segment)
  }
  const flush = (connection: Connection) => {
    while (connection.held.length > 0) {
      const next = connection.held[0]
      if (next === undefined || !reachable(next.from.host, next.to.host)) return
      connection.held.shift()
      apply(next.to, next.segment)
    }
  }
  const close = (connection: Connection, side: Side) => {
    if (side.closed) return
    side.closed = true
    side.inbox.reset(closeError(1006))
    send(connection, side, { _tag: "end" })
    if (connection.client.closed && connection.server.closed) connections.delete(connection)
  }
  const writerFor = (current: () => { readonly connection: Connection; readonly side: Side } | undefined) => {
    const write = (chunk: Uint8Array | string | Socket.CloseEvent): Effect.Effect<void, Socket.SocketError> =>
      Effect.suspend(() => {
        const end = current()
        if (end === undefined) return Effect.fail(writeClosed)
        if (Socket.isCloseEvent(chunk)) {
          close(end.connection, end.side)
          return Effect.void
        }
        if (end.side.closed) return Effect.fail(writeClosed)
        send(end.connection, end.side, { _tag: "data", bytes: bytesOf(chunk) })
        return Effect.void
      })
    const writeAll = (chunks: Arr.NonEmptyReadonlyArray<Uint8Array | string>) =>
      Effect.forEach(chunks, write, { discard: true })
    return { write, writeAll }
  }

  /** Open a connection from `from`, as `Net.createConnection` would: refused, hanging, or accepted. */
  const connect = (from: string, options: TcpOptions) =>
    Effect.gen(function* () {
      // SYNs to or from a partitioned host are retransmitted until it heals or the caller gives up.
      while (!reachable(from, options.host)) yield* Effect.sleep("1 second")
      const accept = listeners.get(keyOf(options.host, options.port))
      if (accept === undefined) return yield* refused(keyOf(options.host, options.port))
      const connection: Connection = {
        client: { host: from, inbox: makeInbox(), closed: false },
        server: { host: options.host, inbox: makeInbox(), closed: false },
        held: []
      }
      connections.add(connection)
      accept(connection)
      return connection
    })

  const tcp =
    (from: string) =>
    (options: TcpOptions): Effect.Effect<Socket.Socket> =>
      Effect.sync(() => {
        // One socket is reconnected by acquiring its reader again, like Node's: each acquisition is a new connection.
        let current: { readonly connection: Connection; readonly side: Side } | undefined
        const latch = Latch.makeUnsafe(false)
        const reader = Effect.gen(function* () {
          const scope = yield* Effect.scope
          const connection = yield* connect(from, options).pipe(
            Effect.timeoutOrElse({ duration: options.openTimeout, orElse: () => Effect.fail(openTimeout) })
          )
          const end = { connection, side: connection.client }
          current = end
          latch.openUnsafe()
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              close(connection, connection.client)
              if (current === end) current = undefined
              latch.closeUnsafe()
            })
          )
          return { pull: connection.client.inbox.pull, upgrade: Socket.SocketUpgradeError.unsupported }
        })
        const { write, writeAll } = writerFor(() => current)
        return Socket.make({
          reader,
          writer: Effect.succeed({
            // Like Node's adapter, writes before the connection is open wait for it.
            write: (chunk) => (current === undefined ? latch.whenOpen(write(chunk)) : write(chunk)),
            writeAll: (chunks) => (current === undefined ? latch.whenOpen(writeAll(chunks)) : writeAll(chunks))
          })
        })
      })

  const accepted = (connection: Connection): Socket.Socket => {
    const end = { connection, side: connection.server }
    return Socket.make({
      reader: Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => close(connection, connection.server)))
        return { pull: connection.server.inbox.pull, upgrade: Socket.SocketUpgradeError.unsupported }
      }),
      writer: Effect.succeed(writerFor(() => end))
    })
  }

  const listen = (ip: string, port: number) =>
    Effect.gen(function* () {
      const key = keyOf(ip, port)
      if (listeners.has(key)) return yield* Effect.die(new Error(`${key} is already listening`))
      const incoming = makeInbox<Connection, never>()
      const open = new Set<Connection>()
      listeners.set(key, (connection) => {
        open.add(connection)
        incoming.push(connection)
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          listeners.delete(key)
          for (const connection of open) close(connection, connection.server)
        })
      )
      return SocketServer.SocketServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe(ip, port),
        run: (handler) =>
          incoming.pull.pipe(
            Effect.flatMap((batch) =>
              Effect.forEach(
                batch,
                (connection) =>
                  handler(accepted(connection)).pipe(
                    Effect.scoped,
                    Effect.exit,
                    Effect.ensuring(
                      Effect.sync(() => {
                        close(connection, connection.server)
                        open.delete(connection)
                      })
                    ),
                    Effect.forkChild
                  ),
                { discard: true }
              )
            ),
            Effect.forever
          )
      })
    })

  const deliver = (from: Binding, to: NetAddress.InetAddress, payload: Uint8Array) => {
    const ip = NetAddress.formatIp(to.address)
    const targets =
      ip === "255.255.255.255" || ip.endsWith(".255")
        ? [...bindings.values()].filter((binding) => binding.port === to.port && binding !== from)
        : [bindings.get(keyOf(ip, to.port))].filter((binding) => binding !== undefined)
    for (const target of targets) {
      const lossRate = Math.max(loss.get(from.host) ?? 0, loss.get(target.host) ?? 0)
      if (!reachable(from.host, target.host) || (lossRate > 0 && random() < lossRate)) {
        datagramsLost++
        continue
      }
      datagramsDelivered++
      target.inbox.push({ payload: new Uint8Array(payload), address: from.address })
    }
  }

  const udp =
    (host: string) =>
    (options: UdpOptions): Effect.Effect<DatagramSocket.DatagramSocket> =>
      Effect.sync(() => {
        let current: Binding | undefined
        const latch = Latch.makeUnsafe(false)
        const reader = Effect.gen(function* () {
          const ip = options.address === "0.0.0.0" ? host : options.address
          const key = keyOf(ip, options.port)
          if (bindings.has(key)) {
            return yield* new DatagramSocket.DatagramSocketError({
              reason: new DatagramSocket.DatagramSocketOpenError({
                kind: "AddressInUse",
                cause: new Error(`bind EADDRINUSE ${key}`)
              })
            })
          }
          const binding: Binding = {
            host,
            port: options.port,
            address: NetAddress.inetAddressFromIpStringUnsafe(ip, options.port),
            inbox: makeInbox()
          }
          bindings.set(key, binding)
          current = binding
          latch.openUnsafe()
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              bindings.delete(key)
              binding.inbox.reset(datagramClosed)
              current = undefined
              latch.closeUnsafe()
            })
          )
          return {
            pull: binding.inbox.pull,
            address: binding.address,
            dropped: () => 0,
            joinMulticast: () => Effect.void
          }
        })
        const transmit = (datagram: DatagramSocket.OutgoingDatagram) =>
          Effect.sync(() => {
            const from = current
            const target = datagram.address
            if (from === undefined || target === undefined) return
            deliver(from, NetAddress.isInetAddress(target) ? target : target.address, bytesOf(datagram.payload))
          })
        const write = (datagram: DatagramSocket.OutgoingDatagram): Effect.Effect<void> =>
          current === undefined ? latch.whenOpen(transmit(datagram)) : transmit(datagram)
        return DatagramSocket.make({
          reader,
          writer: Effect.succeed({
            write,
            writeAll: (datagrams) => Effect.forEach(datagrams, write, { discard: true })
          })
        })
      })

  return {
    host: (ip) => ({ tcp: tcp(ip), udp: udp(ip) }),
    listen,
    partition: (ip, isPartitioned) => {
      if (isPartitioned) {
        partitioned.add(ip)
        return
      }
      partitioned.delete(ip)
      for (const connection of connections) flush(connection)
    },
    setLoss: (ip, share) => {
      loss.set(ip, share)
    },
    stats: () => {
      const openEnds = new Map<string, number>()
      for (const { client, server } of connections) {
        for (const side of [client, server]) {
          if (!side.closed) openEnds.set(side.host, (openEnds.get(side.host) ?? 0) + 1)
        }
      }
      return {
        connections: connections.size,
        openEnds,
        listeners: listeners.size,
        udpEndpoints: bindings.size,
        datagramsDelivered,
        datagramsLost
      }
    }
  }
}
