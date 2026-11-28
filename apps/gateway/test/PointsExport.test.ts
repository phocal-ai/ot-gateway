/**
 * `points export`: a config's devices as a points list that `import` reads back into the same devices, and every
 * part of the config a list cannot carry named, so re-importing never drops a writable point unsaid.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { type Device, parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem } from "effect"
import { join } from "node:path"
import { devicesFromPointsList } from "../src/PointsList.ts"
import {
  commonColumnNames,
  describeNotCarried,
  exportCsv,
  exportJson,
  exportPointsList,
  outputPath,
  writeExport
} from "../src/PointsExport.ts"

const config = (devices: ReadonlyArray<unknown>) =>
  parseConfig(JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://broker" }, devices }))

const modbus = {
  protocol: "modbus-tcp",
  id: "main-meter",
  host: "10.0.1.20",
  port: 5020,
  unitId: 3,
  pollIntervalMs: 10_000,
  points: [
    {
      id: "active-power",
      name: "Active power",
      unit: "unit:KiloW",
      table: "holding",
      address: 40,
      dataType: "float32",
      byteOrder: "CDAB",
      scaling: { factor: 0.1, offset: 2 },
      publish: { mode: "aggregate", intervalMs: 900_000 }
    },
    { id: "energy", name: "Energy, total", table: "input", address: 0, dataType: "uint32", deadband: 0.5 },
    { id: "tripped", name: "Breaker, tripped", table: "discrete", address: 4, dataType: "bool", alarmWhen: "on" },
    { id: "relay", name: "Relay", table: "coil", address: 1, dataType: "bool", publish: { mode: "change" } },
    { id: "latest", name: "Latest", table: "holding", address: 50, dataType: "int16", publish: { mode: "sample" } }
  ]
}

const bacnet = {
  protocol: "bacnet-ip",
  id: "ahu-1",
  deviceInstance: 2001,
  address: "10.0.1.30",
  points: [
    {
      id: "supply-temp",
      name: "Supply air temperature",
      unit: "unit:DEG_C",
      objectType: "analog-input",
      instance: 1,
      publish: { mode: "sample", intervalMs: 60_000 }
    },
    { id: "fan", name: "Fan", objectType: "binary-output", instance: 3, alarmWhen: "off" }
  ]
}

/** A device as import makes it: every point read-only, nothing the list has no column for. */
const asImported = (device: Device) => ({
  ...device,
  points: device.points.map(({ semantics: _semantics, limits: _limits, ...point }) => ({ ...point, writable: false }))
})

describe("exportPointsList", () => {
  it.effect("round-trips with import, as CSV and as JSON", () =>
    Effect.gen(function* () {
      const decoded = yield* config([modbus, bacnet])
      const list = exportPointsList(decoded)
      expect(list.notCarried).toEqual([])
      expect(list.devices).toBe(2)
      for (const text of [exportCsv(list), exportJson(list)]) {
        const devices = yield* devicesFromPointsList(text)
        const again = yield* config(devices)
        expect(again.devices).toEqual(decoded.devices)
      }
    })
  )

  it.effect("writes only what differs from the defaults, and the columns it uses", () =>
    Effect.gen(function* () {
      const decoded = yield* config([
        { ...bacnet, address: undefined, points: [bacnet.points[1]] },
        {
          protocol: "modbus-tcp",
          id: "m",
          host: "h",
          points: [{ id: "temperature", name: "Temperature", table: "holding", address: 1, dataType: "int16" }]
        }
      ])
      expect(exportCsv(exportPointsList(decoded))).toBe(
        [
          "device,point,alarm,host,register,table,type,device_instance,object_type,object_instance",
          "ahu-1,fan,off,,,,,2001,binary-output,3",
          "m,temperature,,h,1,holding,int16,,,",
          ""
        ].join("\n")
      )
    })
  )

  it.effect("names what a list cannot carry, and leaves out points it would describe wrongly", () =>
    Effect.gen(function* () {
      const decoded = yield* config([
        {
          ...modbus,
          requestGapMs: 100,
          publish: { mode: "change", maxSilenceMs: 60_000 },
          points: [
            {
              id: "setpoint",
              name: "Setpoint",
              table: "holding",
              address: 10,
              dataType: "int16",
              writable: true,
              limits: { min: 10, max: 30 },
              semantics: { brick: "Setpoint" }
            },
            { id: "flag", name: "Flag", table: "holding", address: 11, dataType: "bool", bit: 2 }
          ]
        },
        {
          ...bacnet,
          cov: false,
          points: [
            { id: "name", name: "Name", objectType: "device", instance: 2001, property: "object-name" },
            { id: "valve", name: "Valve", objectType: "binary-output", instance: 1, writable: true, priority: 9 },
            // A priority of a point that takes no writes says nothing; a unit import would rename does.
            { id: "temp", name: "Temp", unit: "°C", objectType: "analog-input", instance: 2, priority: 10 }
          ]
        },
        {
          protocol: "simulator",
          id: "sim",
          points: [{ id: "x", name: "X", waveform: "sine", min: 0, max: 1 }]
        }
      ])
      const list = exportPointsList(decoded)
      expect(list.rows.map((row) => `${row["device"]}/${row["point"]}`)).toEqual([
        "main-meter/setpoint",
        "ahu-1/valve",
        "ahu-1/temp"
      ])
      // The device's publish mode goes on each of its points.
      expect(list.rows[0]).toMatchObject({ publish: "change" })
      expect(list.notCarried.map((note) => [note.kind, note.point ?? note.device, note.skipped])).toEqual([
        ["device-setting", "main-meter", false],
        ["device-publish", "main-meter", false],
        ["writable", "setpoint", false],
        ["semantics", "setpoint", false],
        ["max-silence", "setpoint", false],
        ["bit", "flag", true],
        ["device-setting", "ahu-1", false],
        ["property", "name", true],
        ["priority", "valve", false],
        ["writable", "valve", false],
        ["unit", "temp", false],
        ["simulator", "sim", true]
      ])
      const lines = describeNotCarried(list.notCarried)
      expect(lines).toContain(
        "! import never makes a point writable: set writable and limits in the config again: main-meter/setpoint (10 to 30), ahu-1/valve"
      )
      expect(lines).toContain(
        "✗ a bit of a register has no column; left out, as the row would read the whole register: main-meter/flag bit 2 of holding 11"
      )
      expect(lines).toContain(
        "! import writes these units as QUDT names; put the QUDT name in the config to keep them alike: ahu-1/temp °C imports as unit:DEG_C"
      )
      expect(lines).toContain("! these device settings have no column: main-meter requestGapMs 100, ahu-1 cov false")
    })
  )

  it.effect("gives back every point read-only, without what has no column", () =>
    Effect.gen(function* () {
      const setpoint = {
        id: "setpoint",
        name: "Setpoint",
        table: "holding",
        address: 10,
        dataType: "int16",
        writable: true,
        limits: { min: 10, max: 30 },
        semantics: { brick: "Setpoint" }
      }
      const decoded = yield* config([{ ...modbus, points: [...modbus.points, setpoint] }])
      const devices = yield* devicesFromPointsList(exportCsv(exportPointsList(decoded)))
      expect((yield* config(devices)).devices).toEqual(decoded.devices.map(asImported))
    })
  )
})

const writableValve = {
  id: "valve",
  name: "Valve",
  objectType: "analog-output",
  instance: 7,
  writable: true,
  limits: { min: 0, max: 100 },
  priority: 9
}

const bitFlag = { id: "flag", name: "Flag", table: "holding", address: 11, dataType: "bool", bit: 2 }

describe("exportPointsList options", () => {
  it.effect("keeps one protocol's devices", () =>
    Effect.gen(function* () {
      const decoded = yield* config([modbus, bacnet])
      const bacnetOnly = exportPointsList(decoded, { protocol: "bacnet" })
      expect(new Set(bacnetOnly.rows.map((row) => row["device"]))).toEqual(new Set(["ahu-1"]))
      expect(bacnetOnly.columns).not.toContain("register")
      const modbusOnly = exportPointsList(decoded, { protocol: "modbus" })
      expect(new Set(modbusOnly.rows.map((row) => row["device"]))).toEqual(new Set(["main-meter"]))
      expect(modbusOnly.columns).not.toContain("object_type")
    })
  )

  it.effect("all: every column with defaults, the topic and the limits, and import reads it as the plain list", () =>
    Effect.gen(function* () {
      const decoded = yield* config([
        { ...modbus, port: 502, unitId: 1, pollIntervalMs: 5_000 },
        { ...bacnet, points: [...bacnet.points, writableValve] }
      ])
      const list = exportPointsList(decoded, { columns: "all" })
      expect(list.columns.slice(-6)).toEqual(["protocol", "writable", "min", "max", "priority", "topic"])
      expect(list.rows.find((row) => row["point"] === "energy")).toMatchObject({
        name: "Energy, total",
        port: 502,
        unit_id: 1,
        interval_s: 5,
        byte_order: "ABCD",
        protocol: "modbus-tcp",
        writable: "no",
        topic: "s/b/main-meter/energy"
      })
      expect(list.rows.find((row) => row["point"] === "valve")).toMatchObject({
        protocol: "bacnet-ip",
        writable: "yes",
        min: 0,
        max: 100,
        priority: 9,
        topic: "s/b/ahu-1/valve"
      })
      // A point that takes no writes has no priority to say.
      expect(list.rows.find((row) => row["point"] === "fan")).not.toHaveProperty("priority")
      const plain = yield* config(yield* devicesFromPointsList(exportCsv(exportPointsList(decoded))))
      const detailed = yield* config(yield* devicesFromPointsList(exportCsv(list)))
      expect(detailed.devices).toEqual(plain.devices)
    })
  )

  it.effect("common: every point of every protocol with only the columns they share", () =>
    Effect.gen(function* () {
      const decoded = yield* config([
        { ...modbus, points: [...modbus.points, bitFlag] },
        { ...bacnet, points: [...bacnet.points, writableValve] },
        { protocol: "simulator", id: "sim", points: [{ id: "x", name: "X", waveform: "sine", min: 0, max: 1 }] }
      ])
      const list = exportPointsList(decoded, { columns: "common" })
      for (const column of list.columns) expect(commonColumnNames).toContain(column)
      expect(list.columns.slice(0, 4)).toEqual(["device", "point", "name", "protocol"])
      // A register's bit is a point too, even though an import list leaves it out.
      expect(list.rows.find((row) => row["point"] === "flag")).toEqual({
        device: "main-meter",
        point: "flag",
        name: "Flag",
        protocol: "modbus-tcp",
        writable: "no",
        topic: "s/b/main-meter/flag",
        interval_s: 10
      })
      expect(list.rows).toHaveLength(modbus.points.length + 1 + bacnet.points.length + 1)
      expect(list.notCarried.map((note) => note.kind)).toEqual(["simulator"])
    })
  )
})

describe("writeExport", () => {
  it("reads ~ as the home folder", () => {
    expect(outputPath("~/Downloads/points.csv", "/home/me")).toBe("/home/me/Downloads/points.csv")
    expect(outputPath("~", "/home/me")).toBe("/home/me")
    expect(outputPath("/tmp/~x.csv", "/home/me")).toBe("/tmp/~x.csv")
  })

  it.effect(
    "writes the file, and never over one, into a folder that is not there, or outside a container's folder",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const folder = yield* fs.makeTempDirectoryScoped()
        const path = join(folder, "points.csv")
        const written = yield* writeExport(path, "a,b\n", { force: false })
        expect(written).toEqual({ path, bytes: 4 })
        expect(yield* fs.readFileString(path)).toBe("a,b\n")
        const exists = yield* Effect.flip(writeExport(path, "c\n", { force: false }))
        expect(exists).toMatchObject({ _tag: "PointsExportError", code: "output-exists" })
        expect(yield* fs.readFileString(path)).toBe("a,b\n")
        yield* writeExport(path, "c\n", { force: true })
        expect(yield* fs.readFileString(path)).toBe("c\n")
        // A link to nowhere is not followed.
        yield* fs.symlink(join(folder, "elsewhere.csv"), join(folder, "link.csv"))
        const link = yield* Effect.flip(writeExport(join(folder, "link.csv"), "c\n", { force: false }))
        expect(link).toMatchObject({ code: "output-exists" })
        expect(yield* fs.exists(join(folder, "elsewhere.csv"))).toBe(false)
        const missing = yield* Effect.flip(writeExport(join(folder, "nope", "points.csv"), "c\n", { force: false }))
        expect(missing).toMatchObject({ _tag: "PointsExportError", code: "output-folder-missing" })
        const aFolder = yield* Effect.flip(writeExport(folder, "c\n", { force: true }))
        expect(aFolder).toMatchObject({ _tag: "PointsExportError", code: "output-unwritable" })
        const inside = yield* writeExport(join(folder, "in.csv"), "c\n", { force: false, visibleFolder: folder })
        expect(inside.path).toBe(join(folder, "in.csv"))
        const outside = yield* Effect.flip(
          writeExport(join(folder, "..", "out.csv"), "c\n", { force: false, visibleFolder: folder })
        )
        expect(outside).toMatchObject({ _tag: "PointsExportError", code: "output-outside-folder" })
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
