/**
 * The client and driver over real TCP, against the in-memory simulator.
 */
import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { driverConnects, driverRequests, withMetricAttributes } from "@plenum/core"
import type { ModbusDevice, ModbusPoint } from "@plenum/core"
import { Effect, Metric } from "effect"
import type * as SocketServer from "effect/socket/SocketServer"
import {
  appendChunks,
  decodeRequest,
  encodeRegisterResponse,
  FunctionCode,
  makeModbusClient,
  makeModbusDriver,
  makeRegisterBank,
  makeSimulatorControl,
  serveModbus,
  setPointValue,
  takeFrame
} from "../src/index.ts"

const point = (
  id: string,
  table: ModbusPoint["table"],
  address: number,
  dataType: ModbusPoint["dataType"]
): ModbusPoint => ({
  id,
  name: id,
  writable: false,
  table,
  address,
  dataType
})

const supplyTemp = point("supply-temp", "holding", 100, "float32")
const setpoint = point("setpoint", "holding", 102, "int16")
const energy = point("energy", "input", 0, "uint32")
const alarm = point("alarm", "coil", 0, "bool")
const door = point("door", "discrete", 5, "bool")
const points = [supplyTemp, setpoint, energy, alarm, door]

const portOf = (server: SocketServer.SocketServer["Service"]) =>
  server.address._tag === "UnixPathAddress" ? 0 : server.address.port

/** A simulator with every test point set, listening on a free port. */
const startSimulator = Effect.gen(function* () {
  const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
  const bank = makeRegisterBank()
  const control = makeSimulatorControl()
  setPointValue(bank, supplyTemp, 21.5)
  setPointValue(bank, setpoint, -5)
  setPointValue(bank, energy, 123_456)
  setPointValue(bank, alarm, true)
  setPointValue(bank, door, false)
  yield* serveModbus(server, bank, control).pipe(Effect.forkScoped)
  return { port: portOf(server), bank, control }
})

const deviceOn = (port: number, devicePoints: ReadonlyArray<ModbusPoint> = points): ModbusDevice => ({
  protocol: "modbus-tcp",
  id: "test-meter",
  host: "127.0.0.1",
  port,
  unitId: 1,
  pollIntervalMs: 1000,
  points: devicePoints
})

/** Counter value for this test's device. */
const countOf = (metric: Metric.Counter<number>, device: string, outcome: string) =>
  Metric.value(Metric.withAttributes(metric, { device, outcome })).pipe(Effect.map((state) => state.count))

describe("Modbus driver over TCP", () => {
  it.live("reads every table, one request per block", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startSimulator
      const driver = yield* makeModbusDriver(deviceOn(port))
      const readings = yield* driver.readAll

      const values = Object.fromEntries(readings.map((r) => [r.pointId, r.value]))
      expect(values).toEqual({ "supply-temp": 21.5, setpoint: -5, energy: 123_456, alarm: true, door: false })
      // supply-temp and setpoint share one holding block.
      expect(control.requests).toBe(4)
      expect(yield* countOf(driverRequests, "read-all", "ok")).toBe(4)
      expect(yield* countOf(driverConnects, "read-all", "ok")).toBe(1)
    }).pipe(withMetricAttributes({ device: "read-all" }))
  )

  it.live("keeps the other blocks when the device refuses one", () =>
    Effect.gen(function* () {
      const { port } = yield* startSimulator
      const unmapped = point("unmapped", "holding", 500, "uint16")
      const driver = yield* makeModbusDriver(deviceOn(port, [supplyTemp, unmapped, alarm]))
      const readings = yield* driver.readAll

      expect(readings.map((r) => r.pointId)).toEqual(["supply-temp", "alarm"])
      expect(yield* countOf(driverRequests, "refused-one", "exception")).toBe(1)
    }).pipe(withMetricAttributes({ device: "refused-one" }))
  )

  it.live("fails with a protocol error when every block is refused", () =>
    Effect.gen(function* () {
      const { port } = yield* startSimulator
      const driver = yield* makeModbusDriver(deviceOn(port, [point("nowhere", "input", 900, "uint16")]))
      const error = yield* Effect.flip(driver.readAll)

      expect(error).toMatchObject({ _tag: "DriverError", reason: "protocol" })
      expect(error.message).toContain("illegal data address")
    })
  )

  it.live("times out on a silent device, then reconnects once it answers again", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startSimulator
      const driver = yield* makeModbusDriver(deviceOn(port, [setpoint]), { requestTimeout: "150 millis" })

      control.silent = true
      const error = yield* Effect.flip(driver.readAll)
      expect(error).toMatchObject({ _tag: "DriverError", reason: "timeout" })

      control.silent = false
      const readings = yield* driver.readAll
      expect(readings.map((r) => r.value)).toEqual([-5])
      // The timed-out connection was dropped, so the second read dialed again.
      expect(yield* countOf(driverConnects, "silent", "ok")).toBe(2)
      expect(yield* countOf(driverRequests, "silent", "timeout")).toBe(1)
    }).pipe(withMetricAttributes({ device: "silent" }))
  )

  it.live("reports a connection error when nothing listens", () =>
    Effect.gen(function* () {
      // Bind a port, then release it, so the address is valid but closed.
      const port = yield* Effect.scoped(Effect.map(NodeSocketServer.make({ host: "127.0.0.1", port: 0 }), portOf))
      const driver = yield* makeModbusDriver(deviceOn(port, [setpoint]))
      const error = yield* Effect.flip(driver.readAll)

      expect(error).toMatchObject({ _tag: "DriverError", reason: "connection" })
      expect(yield* countOf(driverConnects, "closed-port", "failed")).toBe(1)
    }).pipe(withMetricAttributes({ device: "closed-port" }))
  )
})

describe("Modbus client stream handling", () => {
  it.live("reassembles a response sent byte by byte and skips a stale one", () =>
    Effect.gen(function* () {
      // A misbehaving server: answers a stale transaction first, then the real
      // response one byte per write.
      const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
      const handler = Effect.fnUntraced(
        function* (socket: Parameters<Parameters<typeof server.run>[0]>[0]) {
          const writer = yield* socket.writer
          const { pull } = yield* socket.reader
          let buffer: Uint8Array = new Uint8Array(0)
          while (true) {
            buffer = appendChunks(buffer, yield* pull)
            const split = takeFrame(buffer)
            if (split._tag !== "Frame") continue
            buffer = split.rest
            const decoded = yield* decodeRequest(split.frame)
            if (decoded._tag !== "Read") return
            const { request } = decoded
            yield* writer.write(
              encodeRegisterResponse({ ...request, transactionId: request.transactionId - 1 }, [0xdead])
            )
            for (const byte of encodeRegisterResponse(request, [0x1234])) {
              yield* writer.write(Uint8Array.of(byte))
              yield* Effect.sleep("1 millis")
            }
          }
        },
        Effect.scoped,
        Effect.catchTags({ SocketError: () => Effect.void, ModbusFrameError: () => Effect.void })
      )
      yield* server.run(handler).pipe(Effect.forkScoped)

      const socket = yield* NodeSocket.makeNet({ host: "127.0.0.1", port: portOf(server) })
      const client = yield* makeModbusClient(socket, { unitId: 1 })
      expect(yield* client.readRegisters(FunctionCode.ReadHoldingRegisters, 0, 1)).toEqual([0x1234])
      expect(yield* client.readRegisters(FunctionCode.ReadHoldingRegisters, 0, 1)).toEqual([0x1234])
    })
  )
})
