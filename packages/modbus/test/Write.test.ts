/**
 * Writing through the driver (v0.4) to the simulator, on an in-memory
 * network: the right function code per table and type, values that do not
 * fit refused before anything is sent, and device refusals reported.
 */
import { describe, expect, it } from "@effect/vitest"
import { makeMemoryNetwork, type ModbusDevice, type ModbusPoint } from "@ot-gateway/core"
import { Effect } from "effect"
import {
  ExceptionCode,
  FunctionCode,
  makeModbusDriver,
  makeRegisterBank,
  makeSimulatorControl,
  serveModbus,
  setPointValue,
  writeRequestFor
} from "../src/index.ts"

const point = (id: string, table: ModbusPoint["table"], address: number, dataType: ModbusPoint["dataType"]) =>
  ({ id, name: id, writable: true, table, address, dataType, byteOrder: "ABCD" }) satisfies ModbusPoint

const points = [
  point("setpoint", "holding", 100, "float32"),
  point("mode", "holding", 10, "uint16"),
  point("enable", "coil", 0, "bool"),
  point("energy", "input", 0, "uint32")
]

const device: ModbusDevice = {
  protocol: "modbus-tcp",
  id: "meter",
  host: "10.0.1.1",
  port: 502,
  unitId: 1,
  pollIntervalMs: 5_000,
  requestGapMs: 0,
  maxRegistersPerRead: 125,
  maxBitsPerRead: 2000,
  points
}

const setup = Effect.fnUntraced(function* () {
  const network = makeMemoryNetwork()
  const bank = makeRegisterBank()
  for (const each of points) setPointValue(bank, each, each.dataType === "bool" ? false : 0)
  const control = makeSimulatorControl()
  yield* serveModbus(yield* network.listen(device.host, device.port), bank, control).pipe(Effect.forkScoped)
  const driver = yield* makeModbusDriver(device, { network: network.host("10.0.0.1") })
  return { bank, control, driver }
})

describe("Modbus writes", () => {
  it.effect("writes a float32 in one FC 16, a uint16 with FC 06 and a coil with FC 05, and reads them back", () =>
    Effect.gen(function* () {
      const { control, driver } = yield* setup()
      yield* driver.write("setpoint", 21.5)
      yield* driver.write("mode", 3)
      yield* driver.write("enable", true)
      expect(control.writes.map((write) => write.functionCode)).toEqual([
        FunctionCode.WriteMultipleRegisters,
        FunctionCode.WriteSingleRegister,
        FunctionCode.WriteSingleCoil
      ])
      const readings = yield* driver.readAll
      expect(Object.fromEntries(readings.map((reading) => [reading.pointId, reading.value]))).toEqual({
        setpoint: 21.5,
        mode: 3,
        enable: true,
        energy: 0
      })
    }).pipe(Effect.scoped)
  )

  it.effect("refuses values that do not fit before sending anything, and reports a device's refusal", () =>
    Effect.gen(function* () {
      const { control, driver } = yield* setup()
      for (const [id, value] of [
        ["mode", 70_000],
        ["mode", 1.5],
        ["mode", true],
        ["enable", 1],
        ["energy", 5],
        ["setpoint", null]
      ] as const) {
        const error = yield* Effect.flip(driver.write(id, value))
        expect(error.reason).toBe("configuration")
      }
      expect(control.writes).toEqual([])

      control.refuseWrites = ExceptionCode.ServerDeviceFailure
      const refused = yield* Effect.flip(driver.write("mode", 2))
      expect([refused.reason, refused.message]).toEqual(["protocol", "device refused the write: server_device_failure"])
    }).pipe(Effect.scoped)
  )

  it("maps each table and type to its request", () => {
    expect(writeRequestFor(point("p", "holding", 7, "int16"), -2)).toEqual({
      functionCode: FunctionCode.WriteSingleRegister,
      address: 7,
      value: 0xfffe
    })
    expect(writeRequestFor(point("p", "holding", 7, "bool"), true)).toEqual({
      functionCode: FunctionCode.WriteSingleRegister,
      address: 7,
      value: 1
    })
    expect(writeRequestFor(point("p", "discrete", 7, "bool"), true)).toBe("discrete inputs are read-only")
  })

  it("writes in the point's byte order, wide values with FC 16", () => {
    const swapped = { ...point("p", "holding", 7, "float32"), byteOrder: "CDAB" as const }
    // 21.5 = 0x41AC0000, low word first.
    expect(writeRequestFor(swapped, 21.5)).toEqual({
      functionCode: FunctionCode.WriteMultipleRegisters,
      address: 7,
      values: [0x0000, 0x41ac]
    })
    const counter = { ...point("p", "holding", 7, "uint64"), byteOrder: "DCBA" as const }
    expect(writeRequestFor(counter, 0x0001_0203_0405_0607)).toEqual({
      functionCode: FunctionCode.WriteMultipleRegisters,
      address: 7,
      values: [0x0706, 0x0504, 0x0302, 0x0100]
    })
    // One bit of a register would need a read-modify-write that could undo another change.
    expect(writeRequestFor({ ...point("p", "holding", 7, "bool"), bit: 2 }, true)).toBe(
      "a bit of a register cannot be written"
    )
    // Beyond 2^53 a number is no longer exact: refused rather than written as a neighbour.
    expect(writeRequestFor(counter, 2 ** 60)).toBe(`${2 ** 60} does not fit a uint64`)
  })
})
