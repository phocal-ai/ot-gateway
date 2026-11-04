/**
 * Several devices behind one Modbus TCP gateway: one connection, one request
 * at a time, one request gap for the bus, and a dead device that does not
 * take the others' connection down with it. Over real TCP, against the
 * simulator playing a gateway that accepts a single connection.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { describe, expect, it } from "@effect/vitest"
import type { ModbusDevice, ModbusPoint } from "@plenum/core"
import { Duration, Effect } from "effect"
import type * as SocketServer from "effect/socket/SocketServer"
import {
  endpointOf,
  FunctionCode,
  makeModbusDriverFromClient,
  makeModbusLink,
  makeModbusLinks,
  makeRegisterBank,
  makeSimulatorControl,
  type ModbusClient,
  type RegisterBank,
  serveModbus,
  setPointValue
} from "../src/index.ts"

const power: ModbusPoint = {
  id: "power",
  name: "Power",
  writable: false,
  table: "holding",
  address: 0,
  dataType: "uint16",
  byteOrder: "ABCD"
}

const portOf = (server: SocketServer.SocketServer["Service"]) =>
  server.address._tag === "UnixPathAddress" ? 0 : server.address.port

/** A gateway with meters at units 1 and 2 (power 101 and 202), accepting one connection at a time. */
const startGateway = Effect.gen(function* () {
  const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
  const units = new Map<number, RegisterBank>()
  for (const [unitId, value] of [
    [1, 101],
    [2, 202]
  ] as const) {
    const bank = makeRegisterBank()
    setPointValue(bank, power, value)
    units.set(unitId, bank)
  }
  const control = makeSimulatorControl()
  control.maxConnections = 1
  yield* serveModbus(server, units, control).pipe(Effect.forkScoped)
  return { port: portOf(server), control }
})

const linkTo = (port: number, options: { readonly requestGap?: Duration.Input } = {}) =>
  Effect.flatMap(NodeSocket.makeNet({ host: "127.0.0.1", port, openTimeout: "1 second" }), (socket) =>
    makeModbusLink(socket, { requestTimeout: "200 millis", ...options })
  )

const readPower = (client: ModbusClient) =>
  Effect.map(client.readRegisters(FunctionCode.ReadHoldingRegisters, 0, 1), ([value]) => value)

const meter = (id: string, port: number, unitId: number, requestGapMs = 0): ModbusDevice => ({
  protocol: "modbus-tcp",
  id,
  host: "127.0.0.1",
  port,
  unitId,
  pollIntervalMs: 1000,
  requestGapMs,
  maxRegistersPerRead: 125,
  maxBitsPerRead: 2000,
  points: [power]
})

describe("a link shared by several units", () => {
  it.live("reads every unit behind a gateway that takes one connection", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startGateway
      const link = yield* linkTo(port)
      const [first, second] = [link.unit(1), link.unit(2)]
      // Concurrent callers queue for the one connection instead of opening their own.
      const values = yield* Effect.all([readPower(first), readPower(second), readPower(first), readPower(second)], {
        concurrency: "unbounded"
      })
      expect(values).toEqual([101, 202, 101, 202])
      expect(control.accepted).toBe(1)
    }).pipe(Effect.scoped)
  )

  it.live("keeps the connection when one unit stops answering, and replaces it when every unit has", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startGateway
      const link = yield* linkTo(port)
      const [dead, alive] = [link.unit(1), link.unit(2)]
      expect(yield* readPower(alive)).toBe(202)
      expect(yield* readPower(dead)).toBe(101)

      // Meter 1 dies on the bus, and this gateway says nothing for it.
      control.silentUnits.add(1)
      for (let round = 0; round < 3; round++) {
        expect((yield* Effect.flip(readPower(dead)))._tag).toBe("ModbusTimeout")
        expect(yield* readPower(alive)).toBe(202)
      }
      expect(control.accepted).toBe(1)

      // Now the gateway itself goes quiet: once no unit answers, the connection is replaced.
      control.silent = true
      expect((yield* Effect.flip(readPower(alive)))._tag).toBe("ModbusTimeout")
      control.silent = false
      // A gateway with one slot frees it once it has seen the old connection close (a reconnect before
      // that is refused, and the next poll cycle tries again).
      while (control.open > 0) yield* Effect.sleep("10 millis")
      expect(yield* readPower(alive)).toBe(202)
      expect(control.accepted).toBe(2)
    }).pipe(Effect.scoped)
  )

  it.live("fails fast, without a timeout, when the gateway has no connection slot left", () =>
    Effect.gen(function* () {
      const { port } = yield* startGateway
      const [first, second] = [yield* linkTo(port), yield* linkTo(port)]
      expect(yield* readPower(first.unit(1))).toBe(101)
      const started = Date.now()
      expect((yield* Effect.flip(readPower(second.unit(2))))._tag).toBe("ModbusConnectionError")
      expect(Date.now() - started).toBeLessThan(200)
    }).pipe(Effect.scoped)
  )

  it.live("takes a gateway's refusal for a unit it does not have as an answer, not a broken connection", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startGateway
      const link = yield* linkTo(port)
      const error = yield* Effect.flip(readPower(link.unit(7)))
      expect(error._tag === "ModbusException" ? error.exceptionCode : undefined).toBe(0x0b)
      expect(yield* readPower(link.unit(1))).toBe(101)
      expect(control.accepted).toBe(1)
    }).pipe(Effect.scoped)
  )

  it.live("spaces requests by the gap whichever unit they are for", () =>
    Effect.gen(function* () {
      const { port } = yield* startGateway
      const link = yield* linkTo(port, { requestGap: "120 millis" })
      const started = Date.now()
      yield* readPower(link.unit(1))
      yield* readPower(link.unit(2))
      yield* readPower(link.unit(1))
      // Two gaps between three requests; a lower bound only, so a slow runner cannot fail it.
      expect(Date.now() - started).toBeGreaterThanOrEqual(240)
    }).pipe(Effect.scoped)
  )
})

describe("makeModbusLinks", () => {
  it.live("gives devices on one endpoint one link, with the largest gap among them", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startGateway
      const devices = [meter("meter-1", port, 1, 0), meter("meter-2", port, 2, 120), meter("elsewhere", port + 1, 1)]
      const links = yield* makeModbusLinks(devices, { requestTimeout: "200 millis" })
      expect([...links.keys()]).toEqual([`127.0.0.1:${port}`, `127.0.0.1:${port + 1}`])
      expect(endpointOf({ host: "Meter.local", port: 502 })).toBe("meter.local:502")

      const link = links.get(endpointOf(devices[0] ?? meter("", 0, 0)))
      if (link === undefined) return expect.fail("no link for the gateway")
      const drivers = devices.slice(0, 2).map((device) => makeModbusDriverFromClient(device, link.unit(device.unitId)))
      const started = Date.now()
      const readings = yield* Effect.forEach(drivers, (driver) => driver.readAll, { concurrency: "unbounded" })
      yield* Effect.forEach(drivers, (driver) => driver.readAll)
      expect(readings.map((reading) => reading.map(({ value }) => value))).toEqual([[101], [202]])
      // Meter 2's 120 ms gap protects the bus for meter 1's requests too: three gaps between four requests.
      expect(Date.now() - started).toBeGreaterThanOrEqual(Duration.toMillis(Duration.millis(360)))
      expect(control.accepted).toBe(1)
    }).pipe(Effect.scoped)
  )
})
