/**
 * A Modbus TCP device on a raw `node:net` server, for the faults the simulator
 * cannot produce: closing after a response, resets, padding, wrong ids.
 */
import * as Net from "node:net"
import type { ModbusDevice, ModbusPoint } from "@plenum/core"
import { Effect, Exit } from "effect"
import { decodeRequest, encodeRegisterResponse, takeFrame } from "../../src/index.ts"
import type { ReadRequest } from "../../src/index.ts"

export interface RawDeviceStats {
  /** Connections accepted so far. */
  connects: number
  /** Read requests received so far, over every connection. */
  requests: number
}

export interface RawDeviceBehaviour {
  /** Called for each read request, with the number of earlier requests on the same connection. */
  readonly onRequest: (socket: Net.Socket, request: ReadRequest, onConnection: number, stats: RawDeviceStats) => void
  /** Called once per accepted connection, before any request. */
  readonly onConnect?: (socket: Net.Socket) => void
}

/** Start a device on a free port; it closes every connection with the scope. */
export const startRawDevice = (behaviour: RawDeviceBehaviour) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly port: number
      readonly stats: RawDeviceStats
      readonly server: Net.Server
      readonly sockets: ReadonlySet<Net.Socket>
    }>((resume) => {
      const stats: RawDeviceStats = { connects: 0, requests: 0 }
      const sockets = new Set<Net.Socket>()
      const server = Net.createServer((socket) => {
        sockets.add(socket)
        socket.on("close", () => sockets.delete(socket))
        socket.on("error", () => {})
        stats.connects++
        behaviour.onConnect?.(socket)
        let buffer: Uint8Array = new Uint8Array(0)
        let onConnection = 0
        socket.on("data", (data) => {
          buffer = Buffer.concat([buffer, data])
          let split = takeFrame(buffer)
          while (split._tag === "Frame") {
            buffer = split.rest
            const decoded = Effect.runSyncExit(decodeRequest(split.frame))
            if (Exit.isSuccess(decoded) && decoded.value._tag === "Read") {
              stats.requests++
              behaviour.onRequest(socket, decoded.value.request, onConnection++, stats)
            }
            split = takeFrame(buffer)
          }
        })
      })
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        resume(
          Effect.succeed({
            port: typeof address === "object" && address !== null ? address.port : 0,
            stats,
            server,
            sockets
          })
        )
      })
    }),
    ({ server, sockets }) =>
      Effect.callback<void>((resume) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resume(Effect.void))
      })
  )

/** A response carrying 42 in every requested register. */
export const answer = (request: ReadRequest): Uint8Array =>
  encodeRegisterResponse(
    request,
    Array.from({ length: request.quantity }, () => 42)
  )

export const point = (id: string, table: ModbusPoint["table"], address: number): ModbusPoint => ({
  id,
  name: id,
  writable: false,
  table,
  address,
  dataType: "uint16",
  byteOrder: "ABCD"
})

export const deviceOn = (port: number, points: ReadonlyArray<ModbusPoint>): ModbusDevice => ({
  protocol: "modbus-tcp",
  id: "chaos",
  host: "127.0.0.1",
  port,
  unitId: 1,
  pollIntervalMs: 1000,
  points
})

/** Two blocks, so every read sends two requests: holding 0 and input 0. */
export const twoBlocks = [point("a", "holding", 0), point("b", "input", 0)]
