/**
 * `ot-gateway probe`: one read against the Modbus simulator over real TCP, every type and byte order decoded as a
 * point with those settings would be, the refusals and the silence as typed errors, and the JSON an agent reads.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { describe, expect, it } from "@effect/vitest"
import { ByteOrder, DataType, type ModbusPoint, registerWidth } from "@ot-gateway/core"
import {
  encodeValue,
  makeRegisterBank,
  makeSimulatorControl,
  type RegisterBank,
  serveModbus,
  setPointValue
} from "@ot-gateway/modbus"
import { Effect } from "effect"
import { TestConsole } from "effect/testing"
import { runCli } from "../src/Cli.ts"
import { devicesFromPointsList } from "../src/PointsList.ts"
import {
  checkRequest,
  exampleRow,
  formatProbeReport,
  interpretRegisters,
  modiconRegister,
  parseEndpoint,
  probe,
  type ProbeRequest,
  probeJson,
  suggest
} from "../src/Probe.ts"

/** A known value for each type, one that fills its width and shows its sign. */
const known: Readonly<Record<Exclude<DataType, "bool">, number>> = {
  int16: -1234,
  uint16: 54321,
  int32: -123456,
  uint32: 3_000_000_000,
  float32: 21.5,
  int64: -1_234_567_890_123,
  uint64: 1_234_567_890_123,
  float64: 1234.5678
}

const point = (address: number, dataType: DataType, byteOrder: ByteOrder = "ABCD"): ModbusPoint => ({
  id: "p",
  name: "p",
  writable: false,
  table: "holding",
  address,
  dataType,
  byteOrder
})

/** A device whose holding registers hold each known value in each byte order, 10 registers apart, and a few more. */
const deviceBank = () => {
  const bank = makeRegisterBank()
  const layout: Array<{
    readonly address: number
    readonly type: Exclude<DataType, "bool">
    readonly order: ByteOrder
  }> = []
  let address = 1000
  for (const type of DataType.literals) {
    if (type === "bool") continue
    for (const order of ByteOrder.literals) {
      setPointValue(bank, point(address, type, order), known[type])
      layout.push({ address, type, order })
      address += 10
    }
  }
  setPointValue(bank, point(100, "float32"), 12.5)
  setPointValue(bank, point(300, "uint32", "CDAB"), 70000)
  setPointValue(bank, point(400, "int16"), -5)
  bank.holding.set(500, 0x7fc0)
  bank.holding.set(501, 0)
  bank.holding.set(600, 0)
  bank.holding.set(601, 0)
  bank.input.set(0, 7)
  bank.coil.set(3, true)
  return { bank, layout }
}

const startDevice = (units: RegisterBank | ReadonlyMap<number, RegisterBank>) =>
  Effect.gen(function* () {
    const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
    const control = makeSimulatorControl()
    yield* serveModbus(server, units, control).pipe(Effect.forkScoped)
    const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port
    return { port, control }
  })

const request = (port: number, address: number, rest: Partial<ProbeRequest> = {}): ProbeRequest => ({
  host: "127.0.0.1",
  port,
  unitId: 1,
  table: "holding",
  address,
  count: 2,
  ...rest
})

describe("probe against the simulator", () => {
  it.effect("reads each known value back for its type and byte order, as a point with them decodes it", () =>
    Effect.gen(function* () {
      const { bank, layout } = deviceBank()
      const { port, control } = yield* startDevice(bank)
      for (const { address, type, order } of layout) {
        const report = yield* probe(request(port, address, { count: registerWidth(type) }))
        const reading = report.interpretations.find((each) => each.type === type && each.byteOrder === order)
        // A single register has no word order: CDAB reads as ABCD and DCBA as BADC.
        const sameAs =
          registerWidth(type) === 1 ? (order === "CDAB" ? "ABCD" : order === "DCBA" ? "BADC" : order) : order
        const shown = reading ?? report.interpretations.find((each) => each.type === type && each.byteOrder === sameAs)
        expect(shown?.value, `${type} ${order} at ${address}`).toBe(known[type])
      }
      // Read-only: one request per probe, never a write.
      expect(control.writes).toEqual([])
      expect(control.requests).toBe(layout.length)
    }).pipe(Effect.scoped)
  )

  it.effect("names the likeliest reading: a float in its order, a word-swapped counter, a negative int16", () =>
    Effect.gen(function* () {
      const { port } = yield* startDevice(deviceBank().bank)
      const float = yield* probe(request(port, 100))
      expect(float.registers).toEqual([0x4148, 0])
      expect(float.suggestion).toMatchObject({ type: "float32", byteOrder: "ABCD", value: 12.5 })
      expect(float.interpretations.find((each) => each.type === "float32" && each.byteOrder === "CDAB")?.flag).toBe(
        "implausible"
      )
      const counter = yield* probe(request(port, 300))
      expect(counter.suggestion).toMatchObject({ type: "uint32", byteOrder: "CDAB", value: 70000 })
      const negative = yield* probe(request(port, 400, { count: 1 }))
      expect(negative.suggestion).toMatchObject({ type: "int16", byteOrder: "ABCD", value: -5 })
      const swappedFloat = yield* probe(request(port, 1000 + 10 * 4 * 4 + 10))
      expect(swappedFloat.suggestion).toMatchObject({ type: "float32", byteOrder: "CDAB", value: 21.5 })
    }).pipe(Effect.scoped)
  )

  it.effect("marks NaN, and says when every register is 0", () =>
    Effect.gen(function* () {
      const { port } = yield* startDevice(deviceBank().bank)
      const nan = yield* probe(request(port, 500))
      const reading = nan.interpretations.find((each) => each.type === "float32" && each.byteOrder === "ABCD")
      expect(reading?.flag).toBe("nan")
      expect(formatProbeReport(nan)).toContain("NaN: the gateway counts a failed read")
      const zeros = yield* probe(request(port, 600))
      expect(zeros.notes.join(" ")).toContain("every register read is 0")
    }).pipe(Effect.scoped)
  )

  it.effect("reads input registers and coils", () =>
    Effect.gen(function* () {
      const { port } = yield* startDevice(deviceBank().bank)
      const input = yield* probe(request(port, 0, { table: "input", count: 1 }))
      expect(input.suggestion).toMatchObject({ type: "uint16", value: 7 })
      const coil = yield* probe(request(port, 3, { table: "coil", count: 1 }))
      expect(coil.bits).toEqual([true])
      expect(coil.suggestion).toMatchObject({ type: "bool", value: true })
      expect(exampleRow(coil, coil.interpretations[0] ?? { type: "bool", byteOrder: "ABCD", value: true })[1]).toBe(
        `My device,My point,127.0.0.1,${port},1,3,coil,bool,`
      )
    }).pipe(Effect.scoped)
  )
})

describe("probe failures", () => {
  it.effect("an address the device does not have is its refusal, named", () =>
    Effect.gen(function* () {
      const { port } = yield* startDevice(deviceBank().bank)
      const error = yield* Effect.flip(probe(request(port, 7000)))
      expect(error.reason).toBe("exception")
      expect(error.exceptionCode).toBe(2)
      expect(error.message).toContain("refused the read: illegal data address (exception 2)")
      expect(error.message).toContain("a datasheet that counts from 1 means 6999")
    }).pipe(Effect.scoped)
  )

  it.effect("a unit nobody answers for behind a gateway is named with --unit-id", () =>
    Effect.gen(function* () {
      const { port } = yield* startDevice(new Map([[1, deviceBank().bank]]))
      const error = yield* Effect.flip(probe(request(port, 100, { unitId: 9 })))
      expect(error.reason).toBe("exception")
      expect(error.exceptionCode).toBe(11)
      expect(error.message).toContain("gateway target failed to respond")
      expect(error.message).toContain("--unit-id")
    }).pipe(Effect.scoped)
  )

  it.effect("a port nothing listens on is unreachable", () =>
    Effect.gen(function* () {
      const port = yield* Effect.scoped(
        Effect.map(NodeSocketServer.make({ host: "127.0.0.1", port: 0 }), (server) =>
          server.address._tag === "UnixPathAddress" ? 0 : server.address.port
        )
      )
      const error = yield* Effect.flip(probe(request(port, 100), { connectTimeout: "1 second" }))
      expect(error.reason).toBe("unreachable")
      expect(error.message).toContain(`cannot reach 127.0.0.1:${port}`)
    })
  )

  it.live("a device that never answers times out", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startDevice(deviceBank().bank)
      control.silent = true
      const error = yield* Effect.flip(probe(request(port, 100), { requestTimeout: "200 millis" }))
      expect(error.reason).toBe("timeout")
      expect(error.message).toContain("no reply from")
    }).pipe(Effect.scoped)
  )

  it("refuses a request out of range before sending, a datasheet's 400101 with the register it means", () => {
    expect(checkRequest(request(502, 400101))?.message).toContain("holding register 100")
    expect(checkRequest(request(502, 65535))?.message).toContain("run past 65535")
    expect(checkRequest(request(502, 0, { count: 126 }))?.message).toContain("--count takes 1 to 125")
    expect(checkRequest(request(502, 0, { table: "coil", count: 2000 }))).toBeUndefined()
    expect(checkRequest(request(502, 0, { unitId: 256 }))?.reason).toBe("usage")
    expect(modiconRegister(40101)).toEqual({ table: "holding", register: 100 })
    expect(modiconRegister(30001)).toEqual({ table: "input", register: 0 })
    expect(modiconRegister(100)).toBeUndefined()
  })
})

describe("parseEndpoint", () => {
  it("takes a host, host:port and IPv6 in brackets, with 502 as the port", () => {
    expect(parseEndpoint("192.168.1.50")).toEqual({ host: "192.168.1.50", port: 502 })
    expect(parseEndpoint("meter.lan:5020")).toEqual({ host: "meter.lan", port: 5020 })
    expect(parseEndpoint("[fd00::5]:503")).toEqual({ host: "fd00::5", port: 503 })
    expect(parseEndpoint("fd00::5")).toEqual({ host: "fd00::5", port: 502 })
    expect(parseEndpoint("host:0")).toBeUndefined()
    expect(parseEndpoint("host:http")).toBeUndefined()
    expect(parseEndpoint("")).toBeUndefined()
  })
})

describe("the output", () => {
  it.effect("the example row imports as a point with the same register, table, type and byte order", () =>
    Effect.gen(function* () {
      const registers = encodeValue(70000, "uint32", "CDAB")
      const interpretations = interpretRegisters("holding", 300, registers)
      const reading = suggest(interpretations, registers.length)
      expect(reading).toMatchObject({ type: "uint32", byteOrder: "CDAB" })
      if (reading === undefined) return
      const report = {
        host: "10.0.0.5",
        port: 5020,
        unitId: 3,
        table: "holding" as const,
        address: 300,
        count: 2,
        registers,
        interpretations,
        suggestion: reading,
        notes: []
      }
      const [device] = yield* devicesFromPointsList(exampleRow(report, reading).join("\n"))
      expect(device).toMatchObject({ protocol: "modbus-tcp", host: "10.0.0.5", port: 5020, unitId: 3 })
      expect(device?.points[0]).toMatchObject({ table: "holding", address: 300, dataType: "uint32", byteOrder: "CDAB" })
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("--json: ok, the registers in hex, NaN as null with its flag, each reading's row", () =>
    Effect.gen(function* () {
      const { port } = yield* startDevice(deviceBank().bank)
      const json = probeJson(yield* probe(request(port, 500)))
      expect(json).toMatchObject({
        ok: true,
        endpoint: `127.0.0.1:${port}`,
        table: "holding",
        address: 500,
        count: 2,
        registers: [
          { address: 500, hex: "0x7FC0", value: 0x7fc0 },
          { address: 501, hex: "0x0000", value: 0 }
        ]
      })
      const nan = json.interpretations.find((each) => each.type === "float32" && each.byteOrder === "ABCD")
      expect(nan).toEqual({
        type: "float32",
        byteOrder: "ABCD",
        value: null,
        flag: "nan",
        row: {
          host: "127.0.0.1",
          port,
          unit_id: 1,
          register: 500,
          table: "holding",
          type: "float32",
          byte_order: "ABCD"
        }
      })
      // JSON survives the round trip: no NaN or Infinity in it.
      expect(JSON.parse(JSON.stringify(json))).toEqual(json)
    }).pipe(Effect.scoped)
  )

  it.effect("the command: --json prints the report, and a failure as {ok: false, reason, error} with exit 1", () =>
    Effect.gen(function* () {
      const { port } = yield* startDevice(deviceBank().bank)
      yield* runCli(["probe", `127.0.0.1:${port}`, "100", "--json"])
      const [printed] = yield* TestConsole.logLines
      expect(JSON.parse(String(printed))).toMatchObject({ ok: true, suggestion: { type: "float32", value: 12.5 } })
      const error = yield* Effect.flip(runCli(["probe", `127.0.0.1:${port}`, "7000", "--json"]))
      expect(error).toMatchObject({ _tag: "ProbeError", reason: "exception" })
      const [, failure] = yield* TestConsole.logLines
      expect(JSON.parse(String(failure))).toMatchObject({
        ok: false,
        device: `127.0.0.1:${port}`,
        reason: "exception",
        exceptionCode: 2
      })
      const usage = yield* Effect.flip(runCli(["probe", "not a host", "100", "--json"]))
      expect(usage).toMatchObject({ _tag: "ProbeError", reason: "usage" })
    }).pipe(Effect.scoped, Effect.provide([TestConsole.layer, NodeServices.layer]))
  )

  it.effect("the command's text: the registers, the table and a row to copy", () =>
    Effect.gen(function* () {
      const { port } = yield* startDevice(deviceBank().bank)
      yield* runCli(["probe", `127.0.0.1:${port}`, "100"])
      const text = (yield* TestConsole.logLines).join("\n")
      expect(text).toContain("holding registers 100 to 101")
      expect(text).toContain("100       0x4148  16712")
      expect(text).toMatch(/float32 {2}ABCD {8}12\.5 +<- likeliest/)
      expect(text).toContain("device,point,host,port,unit_id,register,table,type,byte_order")
      expect(text).toContain(`My device,My point,127.0.0.1,${port},1,100,holding,float32,ABCD`)
    }).pipe(Effect.scoped, Effect.provide([TestConsole.layer, NodeServices.layer]))
  )
})
