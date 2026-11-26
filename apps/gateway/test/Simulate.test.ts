/**
 * `ot-gateway simulate bacnet`: the room model on its own, what the device prints, and the device on an in-memory
 * network as a gateway on another host meets it: found by a broadcast, read, and a written setpoint that switches
 * the heating and moves the temperature.
 */
import { describe, expect, it } from "@effect/vitest"
import { makeBacnetDriverFromClient, makeBacnetNetwork, ObjectType } from "@ot-gateway/bacnet"
import { type BacnetDevice, makeMemoryNetwork, parseConfig } from "@ot-gateway/core"
import { Effect, Fiber } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { discover } from "../src/Discover.ts"
import {
  COLDEST,
  HYSTERESIS,
  makeRoomDevice,
  simulateBacnet,
  type SimulateOptions,
  START,
  START_SETPOINT,
  startBanner,
  stepRoom,
  takeWrites,
  WARMEST
} from "../src/Simulate.ts"

describe("stepRoom", () => {
  it("heats while the room is below the setpoint, and switches off above it, not at it", () => {
    const warming = stepRoom({ temperature: 19, heating: false }, 21, 1)
    expect(warming).toEqual({ temperature: 19.05, heating: true })
    // Inside the band the heating stays as it was: no flicker around the setpoint.
    expect(stepRoom({ temperature: 21.1, heating: true }, 21, 1).heating).toBe(true)
    expect(stepRoom({ temperature: 21.1, heating: false }, 21, 1).heating).toBe(false)
    expect(stepRoom({ temperature: 21 + HYSTERESIS + 0.1, heating: true }, 21, 1).heating).toBe(false)
  })

  it("cools with the heating off, and stays within its limits whatever the setpoint", () => {
    expect(stepRoom({ temperature: 22, heating: false }, 15, 10)).toEqual({ temperature: 21.8, heating: false })
    expect(stepRoom({ temperature: COLDEST, heating: false }, 5, 3600).temperature).toBe(COLDEST)
    expect(stepRoom({ temperature: WARMEST, heating: true }, 90, 3600).temperature).toBe(WARMEST)
  })
})

const options: SimulateOptions = { instance: 1001, listen: "0.0.0.0", port: 47_808 }
const lans = [{ name: "eth0", address: "192.168.1.20" }]

describe("startBanner", () => {
  it("names the device, its three objects, this machine's address and the command that finds it", () => {
    const lines = startBanner(options, lans).join("\n")
    expect(lines).toContain('device 1001 "Demo room" on UDP 0.0.0.0:47808, 3 objects')
    expect(lines).toContain("analog-value 1   Temperature setpoint")
    expect(lines).toContain("192.168.1.20 (eth0)")
    expect(lines).toContain("npx ot-gateway discover     (or discover --address 192.168.1.20 where")
  })

  it("says a device on another port is found by its address only", () => {
    const lines = startBanner({ ...options, port: 47_810 }, lans).join("\n")
    expect(lines).toContain("npx ot-gateway discover --address 192.168.1.20:47810")
    expect(lines).toContain("a broadcast Who-Is goes to 47808 only")
  })

  it("does not offer a broadcast to a device that listens on one address, which gets none", () => {
    const one = startBanner({ ...options, listen: "192.168.1.20" }, lans).join("\n")
    expect(one).toContain("npx ot-gateway discover --address 192.168.1.20     (it listens on one address")
    expect(one).toContain("Find it from another machine")
    const loopback = startBanner({ ...options, listen: "127.0.0.1" }, lans).join("\n")
    expect(loopback).toContain("Find it from this machine")
    expect(loopback).toContain("discover --address 127.0.0.1 ")
  })
})

describe("takeWrites", () => {
  it("is a line per write since the last call, with the object's name", () => {
    const device = makeRoomDevice(1001)
    device.writes.push({
      object: { objectType: ObjectType["analog-value"], instance: 1 },
      value: { type: "real", value: 24 },
      priority: 8
    })
    expect(takeWrites(device)).toEqual(["write: Temperature setpoint set to 24 °C (priority 8)"])
    expect(takeWrites(device)).toEqual([])
  })
})

const room: BacnetDevice = {
  protocol: "bacnet-ip",
  id: "demo-room",
  deviceInstance: 1001,
  address: "10.0.2.1",
  cov: false,
  pollIntervalMs: 5_000,
  points: [
    { id: "room-temperature", name: "Room temperature", writable: false, objectType: "analog-input", instance: 1 },
    { id: "setpoint", name: "Temperature setpoint", writable: true, objectType: "analog-value", instance: 1 },
    { id: "heating", name: "Heating", writable: false, objectType: "binary-input", instance: 1 }
  ].map((point) => ({ ...point, property: "present-value", priority: 8 }))
}

const gatewayConfig = parseConfig(JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://x" }, devices: [] }))

describe("simulateBacnet", () => {
  it.effect("is found by a broadcast from another host, with its three objects", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      yield* simulateBacnet(options, network.host("10.0.2.1"), () => lans).pipe(Effect.forkScoped)
      yield* TestClock.adjust("1 second")
      const banner = (yield* TestConsole.logLines).map(String)
      expect(banner[0]).toContain("Simulated BACnet/IP device 1001")

      const running = yield* discover(yield* gatewayConfig, network.host("10.0.0.1")).pipe(Effect.forkChild)
      yield* TestClock.adjust("4 seconds")
      yield* Fiber.join(running)
      const draft: unknown = JSON.parse(String((yield* TestConsole.logLines).at(-1)))
      expect(draft).toMatchObject({
        devices: [
          {
            id: "demo-room",
            deviceInstance: 1001,
            address: "10.0.2.1",
            points: [
              { name: "Room temperature", unit: "unit:DEG_C", objectType: "analog-input", instance: 1 },
              { name: "Temperature setpoint", unit: "unit:DEG_C", objectType: "analog-value", instance: 1 },
              { name: "Heating", objectType: "binary-input", instance: 1 }
            ]
          }
        ]
      })
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer))
  )

  it.effect("warms towards a written setpoint, switches the heating off there, and prints the write", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      yield* simulateBacnet(options, network.host("10.0.2.1"), () => lans).pipe(Effect.forkScoped)
      // The device listens once its fiber ran; that is the room's first second too.
      yield* TestClock.adjust("1 second")
      const client = yield* makeBacnetNetwork((yield* gatewayConfig).bacnet, network.host("10.0.0.1"))
      const driver = yield* makeBacnetDriverFromClient(room, client)
      const read = Effect.map(driver.readAll, (readings) =>
        Object.fromEntries(readings.map((reading) => [reading.pointId, reading.value]))
      )
      expect(yield* read).toEqual({
        "room-temperature": START.temperature + 0.05,
        setpoint: START_SETPOINT,
        heating: true
      })

      yield* driver.write("setpoint", 24)
      yield* TestClock.adjust("30 seconds")
      const warming = yield* read
      expect(warming.setpoint).toBe(24)
      expect(warming.heating).toBe(true)
      expect(warming["room-temperature"]).toBeCloseTo(21.05, 2)

      // 24.3 is reached 96 s after the start; then it cools, the heating off.
      yield* TestClock.adjust("90 seconds")
      const there = yield* read
      expect(there.heating).toBe(false)
      expect(Number(there["room-temperature"])).toBeGreaterThan(24 - HYSTERESIS)

      const lines = (yield* TestConsole.logLines).map(String)
      expect(lines).toContain("write: Temperature setpoint set to 24 °C (priority 8)")
      expect(lines.some((line) => line.startsWith("heating off at 24."))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer))
  )

  it.effect("says what to do when another program holds the port", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      const host = network.host("10.0.2.1")
      yield* Effect.flatMap(host.udp({ address: "0.0.0.0", port: 47_808 }), (socket) => socket.reader)
      const error = yield* Effect.flip(simulateBacnet(options, host, () => lans))
      expect(error._tag).toBe("SimulateError")
      expect(error.message).toContain("UDP port 47808 is in use")
      // Not 47809: the demo holds it.
      expect(error.message).toContain("--port 47810")
    }).pipe(Effect.scoped)
  )
})
