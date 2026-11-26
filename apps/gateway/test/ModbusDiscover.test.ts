/**
 * `ot-gateway discover modbus`: ranges and unit ids as typed, then a scan on an in-memory network of simulated
 * devices (one that answers on any unit id, a Modbus gateway with meters behind it, one without holding register
 * 0, a port with nothing behind it, a silent one, one that is not Modbus), read-only and at the rate asked, and the
 * draft points list it writes, which import reads.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { makeMemoryNetwork, type MemoryNetwork } from "@ot-gateway/core"
import {
  answerRead,
  appendChunks,
  decodeRequest,
  makeRegisterBank,
  makeSimulatorControl,
  type SimulatedUnits,
  serveModbus,
  takeFrame
} from "@ot-gateway/modbus"
import { type Duration, Effect, Fiber, FileSystem, Result } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { runCli } from "../src/Cli.ts"
import {
  foundUnits,
  formatScan,
  type ModbusScanRequest,
  modbusDraftPointsList,
  nothingFound,
  parseRange,
  parseUnitIds,
  scanJson,
  scanModbus,
  scanCommand,
  scanToPointsList,
  unitIdsText
} from "../src/ModbusDiscover.ts"
import { suggestedModbusRange } from "../src/Init.ts"
import { devicesFromPointsList } from "../src/PointsList.ts"

const hosts = (text: string, port?: number) =>
  Result.map(parseRange(text, port), (targets) => targets.map((target) => `${target.host}:${target.port}`))

describe("parseRange", () => {
  it("reads an address, a network, first and last, and several with commas", () => {
    expect(hosts("192.168.1.20")).toEqual(Result.succeed(["192.168.1.20:502"]))
    expect(hosts("192.168.1.20:5020")).toEqual(Result.succeed(["192.168.1.20:5020"]))
    expect(hosts("192.168.1.20", 5020)).toEqual(Result.succeed(["192.168.1.20:5020"]))
    expect(hosts("192.168.1.10-12")).toEqual(
      Result.succeed(["192.168.1.10:502", "192.168.1.11:502", "192.168.1.12:502"])
    )
    expect(hosts("10.0.0.254-10.0.1.1")).toEqual(
      Result.succeed(["10.0.0.254:502", "10.0.0.255:502", "10.0.1.0:502", "10.0.1.1:502"])
    )
    expect(hosts("192.168.1.20, 192.168.1.20 ,192.168.1.21")).toEqual(
      Result.succeed(["192.168.1.20:502", "192.168.1.21:502"])
    )
  })

  it("leaves out a network's own address and its broadcast", () => {
    const network = Result.getOrThrow(parseRange("192.168.1.77/24"))
    expect(network).toHaveLength(254)
    expect(network[0]?.host).toBe("192.168.1.1")
    expect(network.at(-1)?.host).toBe("192.168.1.254")
    expect(hosts("10.0.0.4/31")).toEqual(Result.succeed(["10.0.0.4:502", "10.0.0.5:502"]))
    expect(hosts("10.0.0.4/32")).toEqual(Result.succeed(["10.0.0.4:502"]))
  })

  it("refuses what is not a range, and more than a /22", () => {
    expect(Result.isFailure(parseRange("192.168.1.0/16"))).toBe(true)
    expect(Result.isFailure(parseRange("10.0.0.0-10.0.8.0"))).toBe(true)
    expect(Result.isFailure(parseRange("192.168.1.300"))).toBe(true)
    expect(Result.isFailure(parseRange("192.168.1.20-10"))).toBe(true)
    expect(Result.isFailure(parseRange("192.168.1.20-300"))).toBe(true)
    expect(Result.isFailure(parseRange(" , "))).toBe(true)
    expect(Result.isFailure(parseRange("a b"))).toBe(true)
    expect(Result.getOrThrow(parseRange("10.0.0.0/22"))).toHaveLength(1022)
  })
})

describe("the command to run next", () => {
  it("repeats the unit ids, the port and the rate asked", () => {
    expect(unitIdsText([1, 2, 3, 5, 7, 8, 247])).toBe("1-3,5,7,8,247")
    const report = { range: "10.0.0.0/24", askedPort: 5020, unitIds: [1, 2, 3], rate: 5 } as const
    expect(scanCommand(report, " --points-list m.csv")).toBe(
      "ot-gateway discover modbus 10.0.0.0/24 --port 5020 --unit-ids 1-3 --rate 5 --points-list m.csv"
    )
    expect(scanCommand({ range: "10.0.0.9", askedPort: 502, unitIds: "auto", rate: 20 }, "")).toBe(
      "ot-gateway discover modbus 10.0.0.9"
    )
  })
})

describe("parseUnitIds", () => {
  it("reads one, a list and a range, each once", () => {
    expect(parseUnitIds("1")).toEqual(Result.succeed([1]))
    expect(parseUnitIds("1,2,5,2")).toEqual(Result.succeed([1, 2, 5]))
    expect(Result.getOrThrow(parseUnitIds("1-247"))).toHaveLength(247)
    expect(Result.isFailure(parseUnitIds("256"))).toBe(true)
    expect(Result.isFailure(parseUnitIds("5-1"))).toBe(true)
    expect(Result.isFailure(parseUnitIds("1,,2"))).toBe(true)
    expect(Result.isFailure(parseUnitIds("x"))).toBe(true)
  })
})

/** A unit with holding register 0 at `value`. */
const holdingUnit = (value: number) => {
  const bank = makeRegisterBank()
  bank.holding.set(0, value)
  return bank
}

const serve = (network: MemoryNetwork, ip: string, units: SimulatedUnits, port = 502) =>
  Effect.gen(function* () {
    const control = makeSimulatorControl()
    yield* serveModbus(yield* network.listen(ip, port), units, control).pipe(Effect.forkScoped)
    return control
  })

/** A site: a device on .10, a gateway with meters 2 and 7 on .11, one without holding 0 on .12, nothing on .13. */
const site = Effect.gen(function* () {
  const network = makeMemoryNetwork()
  const direct = yield* serve(network, "10.0.0.10", holdingUnit(42))
  const gateway = yield* serve(
    network,
    "10.0.0.11",
    new Map([
      [2, holdingUnit(2)],
      [7, holdingUnit(7)]
    ])
  )
  const inputOnly = makeRegisterBank()
  inputOnly.input.set(0, 9)
  const third = yield* serve(network, "10.0.0.12", inputOnly)
  return { network, controls: [direct, gateway, third] }
})

const request = (range: string, rest: Partial<ModbusScanRequest> = {}): ModbusScanRequest => ({
  range,
  targets: Result.getOrThrow(parseRange(range)),
  rate: 200,
  ...rest
})

/** The scan under the test clock, which it advances until the scan is done. */
const scanned = (network: MemoryNetwork, scan: ModbusScanRequest, connectTimeout: Duration.Input = "1 second") =>
  Effect.gen(function* () {
    const fiber = yield* scanModbus(scan, { network: network.host("10.0.0.1"), connectTimeout }).pipe(Effect.forkChild)
    for (let step = 0; step < 600 && fiber.pollUnsafe() === undefined; step++) yield* TestClock.adjust("100 millis")
    return yield* Fiber.join(fiber)
  })

describe("scanModbus", () => {
  it.effect("finds each device and its unit, a gateway's empty unit 1, and nothing where nothing listens", () =>
    Effect.gen(function* () {
      const { network, controls } = yield* site
      const report = yield* scanned(network, request("10.0.0.10-13"))
      expect(foundUnits(report)).toEqual([
        { host: "10.0.0.10", port: 502, unitId: 1, table: "holding", value: 42 },
        { host: "10.0.0.12", port: 502, unitId: 1, exceptionCode: 2, table: "input", value: 9 }
      ])
      const gateway = report.hosts.find((host) => host.host === "10.0.0.11")
      expect(gateway).toMatchObject({ gateway: true, units: [] })
      expect(report.hosts.map((host) => host.host)).toEqual(["10.0.0.10", "10.0.0.11", "10.0.0.12"])
      expect(report.scanned).toBe(4)
      // Read-only: reads, never a write.
      expect(controls.flatMap((control) => control.writes)).toEqual([])
      const text = formatScan(report)
      expect(text).toContain("2 Modbus unit(s) found on 4 address(es)")
      expect(text).toContain("10.0.0.11:502")
      expect(text).toContain("--unit-ids 1-247")
      expect(text).toContain("next: ot-gateway discover modbus 10.0.0.10-13 --rate 200 --points-list modbus.csv")
    }).pipe(Effect.scoped)
  )

  it.effect("finds the meters behind a gateway on the unit ids named", () =>
    Effect.gen(function* () {
      const { network } = yield* site
      const report = yield* scanned(network, request("10.0.0.11", { unitIds: Result.getOrThrow(parseUnitIds("1-10")) }))
      expect(foundUnits(report).map((unit) => [unit.unitId, unit.value])).toEqual([
        [2, 2],
        [7, 7]
      ])
      expect(report.hosts[0]?.gateway).toBe(true)
      expect(scanJson(report).devices.map((device) => device.row)).toEqual([
        {
          device: "Modbus 10.0.0.11 unit 2",
          point: "Holding register 0",
          host: "10.0.0.11",
          port: "502",
          unit_id: "2",
          register: "0",
          table: "holding",
          type: "uint16"
        },
        expect.objectContaining({ device: "Modbus 10.0.0.11 unit 7", unit_id: "7" })
      ])
    }).pipe(Effect.scoped)
  )

  it.effect("keeps every unit of a device that answers alike on each, and says so", () =>
    Effect.gen(function* () {
      const { network } = yield* site
      const report = yield* scanned(network, request("10.0.0.10", { unitIds: [1, 2] }))
      expect(foundUnits(report).map((unit) => unit.unitId)).toEqual([1, 2])
      expect(report.hosts[0]?.anyUnitId).toBe(true)
      expect(formatScan(report)).toContain("every unit id asked answered alike")
    }).pipe(Effect.scoped)
  )

  it.effect("keeps the units found on a device that answers every unit id as its own", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      const bank = holdingUnit(5)
      const server = yield* network.listen("10.0.0.50", 502)
      yield* server
        .run((socket) =>
          Effect.gen(function* () {
            const writer = yield* socket.writer
            const { pull } = yield* socket.reader
            let buffer: Uint8Array = new Uint8Array(0)
            while (true) {
              buffer = appendChunks(buffer, yield* pull)
              let split = takeFrame(buffer)
              while (split._tag === "Frame") {
                buffer = split.rest
                const decoded = yield* decodeRequest(split.frame)
                if (decoded._tag === "Read") yield* writer.write(answerRead(bank, { ...decoded.request, unitId: 1 }))
                split = takeFrame(buffer)
              }
            }
          }).pipe(Effect.scoped, Effect.ignore)
        )
        .pipe(Effect.forkScoped)
      const report = yield* scanned(network, request("10.0.0.50", { unitIds: [1, 2, 3] }))
      expect(report.notModbus).toEqual([])
      expect(foundUnits(report).map((unit) => unit.unitId)).toEqual([1])
      expect(report.hosts[0]?.silent).toEqual([2, 3])
    }).pipe(Effect.scoped)
  )

  it.effect("names a device that takes the connection and closes it, as one polled elsewhere does", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      const control = yield* serve(network, "10.0.0.60", holdingUnit(1))
      control.maxConnections = 0
      const report = yield* scanned(network, request("10.0.0.60"))
      expect(report.hosts).toMatchObject([{ host: "10.0.0.60", dropped: true, units: [] }])
      const failure = nothingFound(report)
      expect(failure.message).toContain("1 address(es) took a connection")
      expect(failure.hint).toContain("one connection at a time")
    }).pipe(Effect.scoped)
  )

  it.effect("tries 255 and 0 when unit 1 is silent, and names a port that is silent or not Modbus", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      const quiet = yield* serve(network, "10.0.0.20", holdingUnit(1))
      quiet.silentUnits.add(1)
      const silent = yield* serve(network, "10.0.0.21", holdingUnit(1))
      silent.silent = true
      // Not Modbus: whatever it is answers with bytes that are no Modbus TCP frame.
      const other = yield* network.listen("10.0.0.22", 502)
      yield* other
        .run((socket) =>
          Effect.gen(function* () {
            const writer = yield* socket.writer
            const { pull } = yield* socket.reader
            while (true) {
              yield* pull
              yield* writer.write(new TextEncoder().encode("HTTP/1.1 400 Bad Request\r\n\r\n"))
            }
          }).pipe(Effect.scoped, Effect.ignore)
        )
        .pipe(Effect.forkScoped)
      const report = yield* scanned(network, request("10.0.0.20-22"))
      expect(foundUnits(report)).toEqual([{ host: "10.0.0.20", port: 502, unitId: 255, table: "holding", value: 1 }])
      expect(report.hosts.find((host) => host.host === "10.0.0.21")).toMatchObject({ units: [], silent: [1, 255, 0] })
      expect(report.notModbus.map((each) => each.host)).toEqual(["10.0.0.22"])
      expect(formatScan(report)).toContain("not as Modbus TCP")
    }).pipe(Effect.scoped)
  )

  it.effect("ends at the connect timeout on an address that drops what is sent to it", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      yield* serve(network, "10.0.0.30", holdingUnit(1))
      network.partition("10.0.0.30", true)
      const report = yield* scanned(network, request("10.0.0.30-31"), "500 millis")
      expect(report.hosts).toEqual([])
      const failure = nothingFound(report)
      expect(failure.code).toBe("none-found")
      expect(failure.message).toContain("nothing took a connection on port 502")
    }).pipe(Effect.scoped)
  )

  it.effect("asks at most `rate` requests a second", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      const control = yield* serve(network, "10.0.0.40", holdingUnit(1))
      const scan = request("10.0.0.40", { unitIds: [1, 2, 3, 4, 5, 6], rate: 2 })
      const fiber = yield* scanModbus(scan, { network: network.host("10.0.0.1") }).pipe(Effect.forkChild)
      yield* TestClock.adjust("1100 millis")
      expect(control.requests).toBeLessThanOrEqual(2)
      yield* TestClock.adjust("5 seconds")
      const report = yield* Fiber.join(fiber)
      expect(control.requests).toBe(6)
      expect(report.rate).toBe(2)
    }).pipe(Effect.scoped)
  )
})

describe("the draft points list", () => {
  it.effect("is a list import reads, and appending it again adds nothing", () =>
    Effect.gen(function* () {
      const { network } = yield* site
      const report = yield* scanned(network, request("10.0.0.10-12"))
      const devices = yield* devicesFromPointsList(modbusDraftPointsList(foundUnits(report)))
      expect(devices.map((device) => [device.id, device.points.map((point) => point.id)])).toEqual([
        ["modbus-10-0-0-10-unit-1", ["holding-register-0"]],
        ["modbus-10-0-0-12-unit-1", ["input-register-0"]]
      ])
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const path = `${directory}/modbus.csv`
      const first = yield* scanToPointsList(report, path, { noConfig: true })
      expect(first.written).toMatchObject({ added: 2, appended: false, next: `ot-gateway init . --points ${path}` })
      const refused = yield* Effect.flip(scanToPointsList(report, path))
      expect(refused).toMatchObject({ _tag: "ModbusDiscoverError", code: "points-list-exists" })
      const again = yield* scanToPointsList(report, path, { append: true })
      expect(again.written).toMatchObject({ added: 0, skipped: 2, appended: true })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("discover modbus on the command line", () => {
  it.effect("says what a range takes, as JSON with a code and a hint", () =>
    Effect.gen(function* () {
      yield* Effect.flip(runCli(["discover", "modbus", "192.168.1.0/16", "--json"]))
      const printed = JSON.parse((yield* TestConsole.logLines).join("\n"))
      expect(printed).toMatchObject({ ok: false, code: "usage", range: "192.168.1.0/16" })
      expect(printed.error).toContain("more than 1024")
      expect(printed.hint).toContain("192.168.1.0/24")
    }).pipe(Effect.provide([NodeServices.layer, TestConsole.layer]))
  )

  it.effect("refuses --append without --points-list and a unit id past 255", () =>
    Effect.gen(function* () {
      const append = yield* Effect.flip(runCli(["discover", "modbus", "10.0.0.1", "--append"]))
      expect(append.message).toContain("--append")
      const ids = yield* Effect.flip(runCli(["discover", "modbus", "10.0.0.1", "--unit-ids", "300"]))
      expect(ids.message).toContain("unit ids are 0 to 255")
    }).pipe(Effect.provide([NodeServices.layer, TestConsole.layer]))
  )
})

describe("init's Modbus scan", () => {
  it("suggests the /24 of this machine's first LAN", () => {
    expect(suggestedModbusRange([{ name: "eth0", address: "10.20.3.17", broadcast: "10.20.3.255" }])).toBe(
      "10.20.3.0/24"
    )
    expect(suggestedModbusRange([])).toBe("192.168.1.0/24")
  })
})
