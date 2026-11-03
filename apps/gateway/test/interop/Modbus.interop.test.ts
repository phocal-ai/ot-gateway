/**
 * The Modbus driver against a server that is not ours (pymodbus,
 * test/interop/modbus/server.py): reads of every table and type, and writes
 * read back. Runs with PLENUM_INTEROP=1 and PLENUM_INTEROP_MODBUS=host:port.
 */
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@plenum/core"
import { makeModbusDriver } from "@plenum/modbus"
import { Effect } from "effect"

const target = process.env["PLENUM_INTEROP_MODBUS"]
const enabled = process.env["PLENUM_INTEROP"] === "1" && target !== undefined

const deviceConfig = Effect.gen(function* () {
  const [host = "127.0.0.1", port = "5020"] = (target ?? "").split(":")
  const config = yield* parseConfig(
    JSON.stringify({
      site: "s",
      building: "b",
      mqtt: { url: "mqtt://unused" },
      devices: [
        {
          protocol: "modbus-tcp",
          id: "pymodbus",
          host,
          port: Number(port),
          points: [
            { id: "power", name: "Power", table: "holding", address: 100, dataType: "float32" },
            {
              id: "setpoint",
              name: "Setpoint",
              table: "holding",
              address: 200,
              dataType: "float32",
              writable: true,
              limits: { min: 0, max: 100 }
            },
            {
              id: "mode",
              name: "Mode",
              table: "holding",
              address: 10,
              dataType: "uint16",
              writable: true,
              limits: { min: 0, max: 10 }
            },
            { id: "energy", name: "Energy", table: "input", address: 0, dataType: "uint32" },
            { id: "enable", name: "Enable", table: "coil", address: 0, dataType: "bool", writable: true },
            { id: "tripped", name: "Tripped", table: "discrete", address: 0, dataType: "bool" }
          ]
        }
      ]
    })
  )
  const [device] = config.devices
  if (device?.protocol !== "modbus-tcp") return yield* Effect.die(new Error("no Modbus device"))
  return device
})

const valuesOf = (readings: ReadonlyArray<{ readonly pointId: string; readonly value: number | boolean }>) =>
  Object.fromEntries(readings.map((reading) => [reading.pointId, reading.value]))

describe.runIf(enabled)("interop: Modbus TCP against pymodbus", () => {
  it.live(
    "reads every table and type, and writes FC 05, 06 and 16 that read back",
    () =>
      Effect.gen(function* () {
        const driver = yield* makeModbusDriver(yield* deviceConfig)
        expect(valuesOf(yield* driver.readAll)).toEqual({
          power: 21.5,
          setpoint: 20,
          mode: 7,
          energy: 123_456,
          enable: false,
          tripped: true
        })
        yield* driver.write("setpoint", 22.25)
        yield* driver.write("mode", 3)
        yield* driver.write("enable", true)
        expect(valuesOf(yield* driver.readAll)).toMatchObject({ setpoint: 22.25, mode: 3, enable: true })
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "reports the device's refusal of a write to an address it does not have",
    () =>
      Effect.gen(function* () {
        const device = yield* deviceConfig
        const driver = yield* makeModbusDriver({
          ...device,
          points: [
            {
              id: "nowhere",
              name: "Nowhere",
              table: "holding",
              address: 5000,
              dataType: "uint16",
              writable: true,
              limits: { min: 0, max: 10 }
            }
          ]
        })
        const error = yield* Effect.flip(driver.write("nowhere", 1))
        expect(error.reason).toBe("protocol")
      }).pipe(Effect.scoped),
    30_000
  )
})
