/**
 * `ot-gateway read`: the points a selection names, every point read once through the real drivers (the BACnet room
 * simulator on an in-memory network, the Modbus simulator over TCP), what a device that does not answer and a point
 * the device does not have look like, and the report a person and an agent get.
 */
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { describe, expect, it } from "@effect/vitest"
import { type GatewayConfig, makeMemoryNetwork, parseConfig } from "@ot-gateway/core"
import { makeRegisterBank, makeSimulatorControl, serveModbus, setPointValue } from "@ot-gateway/modbus"
import { Duration, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { readArguments } from "../src/Cli.ts"
import {
  formatReadReport,
  incompleteMessage,
  macLocalNetworkNote,
  parseReadSelection,
  readOnce,
  type ReadReport,
  selectDevices
} from "../src/ReadOnce.ts"
import { readPoints } from "../src/SetupTools.ts"
import { simulateBacnet } from "../src/Simulate.ts"
import { makeSimulatorDriver } from "@ot-gateway/simulator"

const room = (address?: string) => ({
  protocol: "bacnet-ip",
  id: "demo-room",
  deviceInstance: 1001,
  ...(address === undefined ? {} : { address }),
  points: [
    { id: "room-temperature", name: "Room temperature", objectType: "analog-input", instance: 1, unit: "unit:DEG_C" },
    { id: "setpoint", name: "Temperature setpoint", objectType: "analog-value", instance: 1, unit: "unit:DEG_C" },
    { id: "heating", name: "Heating", objectType: "binary-input", instance: 1 }
  ]
})

const configWith = (devices: ReadonlyArray<unknown>) =>
  parseConfig(JSON.stringify({ site: "home", building: "pi", mqtt: { url: "mqtt://127.0.0.1" }, devices }))

const lans = [{ name: "eth0", address: "10.0.2.1" }]

/** The room simulator at 10.0.2.1, and a read of `config` from 10.0.0.1 run to its end under the test clock. */
const readFromRoom = (config: GatewayConfig, selection = "", timeout = Duration.seconds(15)) =>
  Effect.gen(function* () {
    const network = makeMemoryNetwork()
    yield* simulateBacnet(
      { instance: 1001, listen: "0.0.0.0", port: 47_808 },
      network.host("10.0.2.1"),
      () => lans
    ).pipe(Effect.forkScoped)
    yield* TestClock.adjust("1 second")
    const devices = yield* selectDevices(config, parseReadSelection(selection) ?? [])
    const running = yield* readOnce(config, devices, { network: network.host("10.0.0.1"), timeout }).pipe(
      Effect.forkChild
    )
    yield* TestClock.adjust(Duration.sum(timeout, Duration.seconds(1)))
    return yield* Fiber.join(running)
  })

describe("selectDevices", () => {
  it.effect("is every device for no selection, and only the points named otherwise, in config order", () =>
    Effect.gen(function* () {
      const config = yield* configWith([
        room("10.0.2.1"),
        {
          protocol: "simulator",
          id: "meter",
          points: [{ id: "power", name: "Power", waveform: "constant", min: 3, max: 3 }]
        }
      ])
      expect((yield* selectDevices(config, [])).map((device) => device.id)).toEqual(["demo-room", "meter"])
      const chosen = yield* selectDevices(
        config,
        parseReadSelection("meter, demo-room/setpoint,demo-room/heating") ?? []
      )
      expect(chosen.map((device) => [device.id, device.points.map((point) => point.id)])).toEqual([
        ["demo-room", ["setpoint", "heating"]],
        ["meter", ["power"]]
      ])
      // A device named alone takes all its points, whatever else names one of them.
      const whole = yield* selectDevices(config, parseReadSelection("demo-room/setpoint,demo-room") ?? [])
      expect(whole[0]?.points).toHaveLength(3)
    })
  )

  it.effect("names the closest device or point for a typo, and what there is", () =>
    Effect.gen(function* () {
      const config = yield* configWith([room("10.0.2.1")])
      const device = yield* Effect.flip(selectDevices(config, [{ device: "demo-rom" }]))
      expect(device).toMatchObject({ code: "no-device", hint: "its devices: demo-room" })
      expect(device.message).toBe("no device demo-rom in the config (did you mean demo-room?)")
      const point = yield* Effect.flip(selectDevices(config, [{ device: "demo-room", point: "setpiont" }]))
      expect(point).toMatchObject({ code: "no-point" })
      expect(point.message).toBe("demo-room has no point setpiont (did you mean setpoint?)")
      const empty = yield* Effect.flip(selectDevices(yield* configWith([]), []))
      expect(empty.code).toBe("no-devices")
    })
  )
})

describe("readArguments", () => {
  it("takes the points and the config in either order, the config by its .json", () => {
    expect(readArguments(undefined, undefined, undefined)).toEqual({ config: "ot-gateway.json" })
    expect(readArguments("room", undefined, undefined)).toEqual({ points: "room", config: "ot-gateway.json" })
    expect(readArguments("site/ot-gateway.json", undefined, undefined)).toEqual({ config: "site/ot-gateway.json" })
    expect(readArguments("room", "a.json", undefined)).toEqual({ points: "room", config: "a.json" })
    expect(readArguments("a.json", "room", undefined)).toEqual({ points: "room", config: "a.json" })
    expect(readArguments("room", undefined, "b.json")).toEqual({ points: "room", config: "b.json" })
    expect(readArguments("a.json", "b.json", undefined)).toEqual({ error: "two configs: a.json and b.json; name one" })
    expect(readArguments("room", "a.json", "b.json")).toEqual({
      error: "two configs: a.json and --config b.json; name one"
    })
  })
})

describe("readOnce against the BACnet room simulator", () => {
  it.effect("reads every point at the device's address, with its unit and topic", () =>
    Effect.gen(function* () {
      const report = yield* readFromRoom(yield* configWith([room("10.0.2.1")]))
      expect(report.ok).toBe(true)
      expect(report.summary).toEqual({ devices: 1, points: 3, read: 3, failed: 0 })
      const [device] = report.devices
      expect(device).toMatchObject({ device: "demo-room", target: "device 1001 at 10.0.2.1", ok: true })
      expect(device?.points.map((point) => [point.topic, point.value, point.unit])).toEqual([
        ["home/pi/demo-room/room-temperature", expect.any(Number), "unit:DEG_C"],
        ["home/pi/demo-room/setpoint", 21, "unit:DEG_C"],
        ["home/pi/demo-room/heating", true, undefined]
      ])
    }).pipe(Effect.scoped)
  )

  it.effect("finds a device without an address by broadcast, and reads only the point named", () =>
    Effect.gen(function* () {
      const report = yield* readFromRoom(yield* configWith([room()]), "demo-room/setpoint")
      expect(report.ok).toBe(true)
      expect(report.devices[0]?.points.map((point) => [point.id, point.value])).toEqual([["setpoint", 21]])
    }).pipe(Effect.scoped)
  )

  it.effect("says why a point the device does not have failed, and reads the others", () =>
    Effect.gen(function* () {
      const withGhost = room("10.0.2.1")
      const config = yield* configWith([
        {
          ...withGhost,
          points: [...withGhost.points, { id: "ghost", name: "Ghost", objectType: "analog-input", instance: 9 }]
        }
      ])
      const report = yield* readFromRoom(config)
      expect(report.ok).toBe(false)
      expect(report.summary).toEqual({ devices: 1, points: 4, read: 3, failed: 1 })
      const ghost = report.devices[0]?.points.find((point) => point.id === "ghost")
      expect(ghost).toMatchObject({ ok: false, error: { code: "protocol", message: "object: unknown-object" } })
      expect(ghost?.value).toBeUndefined()
      expect(incompleteMessage(report)).toBe("1 of 4 point(s) not read (demo-room)")
    }).pipe(Effect.scoped)
  )

  it.effect("gives a device that does not answer its failure class and what to check, within the deadline", () =>
    Effect.gen(function* () {
      const config = yield* configWith([{ ...room("10.0.9.9"), id: "gone" }])
      const report = yield* readFromRoom(config, "", Duration.seconds(5))
      expect(report.ok).toBe(false)
      const [device] = report.devices
      expect(device?.points).toEqual([])
      expect(device?.error?.code).toBe("timeout")
      expect(device?.error?.hint).toEqual(expect.any(String))
      expect(device?.error?.checks?.length).toBeGreaterThan(0)
      expect(report.summary).toEqual({ devices: 1, points: 3, read: 0, failed: 3 })
    }).pipe(Effect.scoped)
  )
})

describe("readPoints with a deadline", () => {
  it.effect("keeps the points read together when reading the others alone runs out of time", () =>
    Effect.gen(function* () {
      const points = [
        { id: "a", name: "A", waveform: "constant", min: 1, max: 1, periodSeconds: 60, writable: false },
        { id: "b", name: "B", waveform: "constant", min: 2, max: 2, periodSeconds: 60, writable: false },
        { id: "c", name: "C", waveform: "constant", min: 3, max: 3, periodSeconds: 60, writable: false }
      ] as const
      // Together, the device answers for a only; alone, it answers for nothing and never says so.
      const driverFor = (chosen: ReadonlyArray<(typeof points)[number]>) =>
        Effect.succeed({
          ...makeSimulatorDriver({ protocol: "simulator", id: "slow", pollIntervalMs: 1000, points: [...chosen] }),
          readAll: chosen.length > 1 ? Effect.succeed([{ pointId: "a", value: 1, timestamp: 0 }]) : Effect.never
        })
      const running = yield* readPoints(points, driverFor, { device: "slow", ms: 5_000 }).pipe(Effect.forkChild)
      yield* TestClock.adjust("6 seconds")
      const read = yield* Fiber.join(running)
      if (read._tag !== "read") return expect.unreachable()
      expect(read.points.map((point) => [point.id, point.value, point.error?.reason])).toEqual([
        ["a", 1, undefined],
        ["b", undefined, "timeout"],
        ["c", undefined, "timeout"]
      ])
    })
  )
})

describe("readOnce against the Modbus simulator", () => {
  it.live("reads a meter over TCP, scaled, with the device's own value next to it", () =>
    Effect.gen(function* () {
      const bank = makeRegisterBank()
      const power = {
        id: "power",
        name: "Power",
        table: "holding",
        address: 0,
        dataType: "int16",
        scaling: { factor: 0.1 },
        unit: "unit:KiloW"
      } as const
      const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
      const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port
      const config = yield* configWith([
        { protocol: "modbus-tcp", id: "meter", host: "127.0.0.1", port, unitId: 1, points: [power] }
      ])
      const device = config.devices[0]
      if (device?.protocol !== "modbus-tcp") return expect.unreachable()
      const [point] = device.points
      if (point === undefined) return expect.unreachable()
      setPointValue(bank, point, 123)
      yield* serveModbus(server, bank, makeSimulatorControl()).pipe(Effect.forkScoped)
      const report = yield* readOnce(config, yield* selectDevices(config, []))
      expect(report.devices[0]).toMatchObject({
        device: "meter",
        target: `127.0.0.1:${port}, unit 1`,
        ok: true,
        points: [{ id: "power", value: 12.3, raw: 123, unit: "unit:KiloW", ok: true }]
      })
    }).pipe(Effect.scoped)
  )
})

describe("formatReadReport", () => {
  const report: ReadReport = {
    ok: false,
    site: "home",
    building: "pi",
    at: 0,
    durationMs: 412,
    summary: { devices: 2, points: 4, read: 2, failed: 2 },
    devices: [
      {
        device: "demo-room",
        protocol: "bacnet-ip",
        target: "device 1001 at 10.0.2.1",
        ok: false,
        durationMs: 30,
        points: [
          { id: "room-temperature", name: "", topic: "", ok: true, value: 20.5, unit: "unit:DEG_C" },
          { id: "heating", name: "", topic: "", ok: true, value: false },
          {
            id: "ghost",
            name: "",
            topic: "",
            ok: false,
            error: { code: "protocol", message: "object: unknown-object" }
          }
        ]
      },
      {
        device: "meter",
        protocol: "modbus-tcp",
        target: "10.0.0.5:502, unit 1",
        ok: false,
        durationMs: 3000,
        error: { code: "timeout", message: "no answer within 3s", hint: "Is it on?", checks: ["Is it on?"] },
        points: []
      }
    ]
  }

  it("is a line per point, aligned, a device not read with where and what to check, and the count", () => {
    expect(formatReadReport(report).split("\n")).toEqual([
      "demo-room/room-temperature  20.5 °C",
      "demo-room/heating           false",
      "demo-room/ghost             error: object: unknown-object",
      "meter                       not read: no answer within 3s",
      "  10.0.0.5:502, unit 1",
      "  check: Is it on?",
      "",
      "2 of 4 point(s) read, 2 failed, in 412 ms"
    ])
  })

  it("counts devices when every point was read", () => {
    const fine: ReadReport = {
      ...report,
      ok: true,
      durationMs: 1250,
      summary: { devices: 1, points: 2, read: 2, failed: 0 },
      devices: report.devices.slice(0, 1).map((device) => ({ ...device, ok: true, points: device.points.slice(0, 2) }))
    }
    expect(formatReadReport(fine).split("\n").at(-1)).toBe("2 point(s) of 1 device(s) read in 1.3 s")
  })
})

describe("an unreachable LAN device on a Mac", () => {
  it("points at Local Network privacy on macOS only, for unreachable and not for a timeout", () => {
    expect(macLocalNetworkNote("darwin", "UDP write failed: host 192.168.0.171 unreachable")).toContain("Local Network")
    expect(macLocalNetworkNote("darwin", "could not connect: host 192.168.1.50 unreachable")).toContain("tmux")
    expect(macLocalNetworkNote("darwin", "no route to 10.0.0.5")).toBeUndefined()
    expect(macLocalNetworkNote("linux", "UDP write failed: host 192.168.0.171 unreachable")).toBeUndefined()
    expect(macLocalNetworkNote("darwin", "no answer within 3s")).toBeUndefined()
  })
})
