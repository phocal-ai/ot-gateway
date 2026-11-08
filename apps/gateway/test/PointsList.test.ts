/**
 * Points lists: what a spreadsheet export looks like (commas or semicolons, quotes, a decimal comma) becomes
 * devices the config schema accepts, and every mistake names its line.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem } from "effect"
import { exampleConfigPath } from "../src/Demo.ts"
import { importPointsList } from "../src/Import.ts"
import { initConfig } from "../src/Init.ts"
import { devicesFromPointsList, parseDelimited, qudtUnit } from "../src/PointsList.ts"

const minimalConfig = { site: "s", building: "b", mqtt: { url: "mqtt://localhost:1883" } }

const examplePoints = exampleConfigPath.replace(/gateway\.json$/, "points.csv")
const answers = { site: "site-1", building: "building-a", brokerUrl: "mqtt://broker.lan:1883" }

const mistake = (text: string) =>
  devicesFromPointsList(text).pipe(
    Effect.flip,
    Effect.map((error) => error.message)
  )

/** A one-point list with these publish columns. */
const publishRow = (publish: string, seconds: string, deadband: string) =>
  mistake(
    `device,point,host,register,type,publish,publish_s,deadband\nm,p,1.2.3.4,1,int16,${publish},${seconds},${deadband}`
  )

describe("parseDelimited", () => {
  it("reads commas, semicolons and tabs, quotes with delimiters and doubled quotes inside, CRLF and a BOM", () => {
    expect(parseDelimited('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"']
    ])
    expect(parseDelimited("a;b\n1,5;2\n")).toEqual([
      ["a", "b"],
      ["1,5", "2"]
    ])
    expect(parseDelimited("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"]
    ])
  })
})

describe("qudtUnit", () => {
  it("names the common spellings in QUDT and keeps anything else as written", () => {
    expect(qudtUnit("kW")).toBe("unit:KiloW")
    expect(qudtUnit(" °C ")).toBe("unit:DEG_C")
    expect(qudtUnit("m³/h")).toBe("unit:M3-PER-HR")
    expect(qudtUnit("unit:KiloV-A")).toBe("unit:KiloV-A")
    expect(qudtUnit("furlongs")).toBe("furlongs")
  })
})

describe("devicesFromPointsList", () => {
  it.effect("turns the example list into Modbus and BACnet devices that make a valid config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const devices = yield* devicesFromPointsList(yield* fs.readFileString(examplePoints))
      expect(devices.map((device) => device.id)).toEqual(["energy-meter", "pv-inverter", "heat-pump"])
      expect(devices[0]).toMatchObject({
        protocol: "modbus-tcp",
        host: "192.168.1.50",
        unitId: 1,
        pollIntervalMs: 5000
      })
      expect(devices[0]?.points).toEqual([
        {
          id: "active-power",
          name: "Active power",
          unit: "unit:KiloW",
          deadband: 0.1,
          table: "holding",
          address: 100,
          dataType: "float32",
          byteOrder: "CDAB"
        },
        {
          id: "energy",
          name: "Energy",
          unit: "unit:KiloW-HR",
          scaling: { factor: 0.1 },
          table: "holding",
          address: 102,
          dataType: "uint32",
          byteOrder: "CDAB"
        },
        { id: "breaker-tripped", name: "Breaker tripped", table: "coil", address: 0, dataType: "bool" }
      ])
      expect(devices[1]).toMatchObject({ protocol: "modbus-tcp", host: "192.168.1.51" })
      expect(devices[2]).toMatchObject({ protocol: "bacnet-ip", deviceInstance: 2001, pollIntervalMs: 30_000 })
      const config = yield* parseConfig(JSON.stringify(initConfig(answers, devices)))
      for (const device of config.devices) {
        for (const point of device.points) expect(point.writable).toBe(false)
      }
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("reads a semicolon export with a decimal comma and other header spellings", () =>
    Effect.gen(function* () {
      const [device] = yield* devicesFromPointsList(
        "Device Name;Point Name;IP;Slave;Register;Data Type;Factor\nPV inverter;AC power;10.0.0.7;3;40;int16;0,1\n"
      )
      expect(device).toMatchObject({
        id: "pv-inverter",
        host: "10.0.0.7",
        unitId: 3,
        points: [{ id: "ac-power", address: 40, dataType: "int16", scaling: { factor: 0.1 } }]
      })
    })
  )

  it.effect("names the line of every kind of mistake", () =>
    Effect.gen(function* () {
      expect(yield* mistake("")).toBe("the points list is empty")
      expect(yield* mistake("name,host\nx,1.2.3.4")).toContain('needs a "device" column')
      expect(yield* mistake("device,point,host,register\nm,p,1.2.3.4,100")).toContain('line 2: "p" needs a type')
      expect(yield* mistake("device,point,host,register,type\nm,p,1.2.3.4,abc,int16")).toBe(
        'line 2: register "abc" is not a number'
      )
      expect(yield* mistake("device,point,host,register,type\nm,p,1.2.3.4,1,int16\nm,P,1.2.3.4,2,int16")).toBe(
        'lines 2 and 3: two points of "m" are both called p'
      )
      expect(yield* mistake("device,point,host,register,type\nm,p,1.2.3.4,1,int16\nm,q,1.2.3.5,2,int16")).toContain(
        "host differs between its rows"
      )
      expect(yield* mistake("device,point\nm,p")).toContain("give it a host (Modbus TCP) or a device_instance")
      expect(yield* mistake("device,point,device_instance\nm,p,7")).toContain("needs object_type and object_instance")
    })
  )

  it.effect("reads each point's publish mode, with the deadband as part of change mode", () =>
    Effect.gen(function* () {
      const [device] = yield* devicesFromPointsList(
        [
          "device,point,host,register,type,publish,publish_s,deadband",
          "m,power,1.2.3.4,1,float32,aggregate,900,",
          "m,temp,1.2.3.4,3,float32,sample,60,",
          "m,mode,1.2.3.4,5,int16,change,,1",
          "m,flow,1.2.3.4,6,int16,,,0.5",
          "m,level,1.2.3.4,7,int16,,,"
        ].join("\n")
      )
      expect(device?.points.map((point) => ({ ...point }))).toMatchObject([
        { id: "power", publish: { mode: "aggregate", intervalMs: 900_000 } },
        { id: "temp", publish: { mode: "sample", intervalMs: 60_000 } },
        { id: "mode", publish: { mode: "change", deadband: 1 } },
        { id: "flow", deadband: 0.5 },
        { id: "level" }
      ])
      const config = yield* parseConfig(JSON.stringify({ ...minimalConfig, devices: [device] }))
      expect(config.devices[0]?.points).toHaveLength(5)
    })
  )

  it.effect("names the line of a publish mode that does not add up", () =>
    Effect.gen(function* () {
      expect(yield* publishRow("hourly", "", "")).toBe(
        'line 2: publish "hourly" is not one of sample, aggregate, change'
      )
      expect(yield* publishRow("aggregate", "", "")).toContain("needs publish_s")
      expect(yield* publishRow("sample", "60", "1")).toContain("only change mode uses")
      expect(yield* publishRow("change", "60", "")).toContain("takes no publish_s")
      expect(yield* publishRow("", "60", "")).toContain("has publish_s but no publish")
    })
  )

  it.effect("refuses a device id that is already in the config", () =>
    Effect.gen(function* () {
      const error = yield* devicesFromPointsList("device,point,host,register,type\nVentilation 1,p,1.2.3.4,1,int16", [
        "ventilation-1"
      ]).pipe(Effect.flip)
      expect(error.message).toBe('device id "ventilation-1" is already in the config')
    })
  )
})

describe("importPointsList", () => {
  it.effect("adds the devices to the config, keeps its other keys, and writes nothing when the result is invalid", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const configPath = `${directory}/gateway.json`
      const original = { ...initConfig(answers, []), healthIntervalMs: 30_000 }
      yield* fs.writeFileString(configPath, JSON.stringify(original))

      const result = yield* importPointsList(examplePoints, configPath, { dryRun: false })
      expect(result.config?.devices.map((device) => device.id)).toEqual(["energy-meter", "pv-inverter", "heat-pump"])
      const written = yield* fs.readFileString(configPath)
      expect(written).toContain('"healthIntervalMs": 30000')

      const badList = `${directory}/bad.csv`
      yield* fs.writeFileString(badList, "device,point,host,register,type\nMeter 2,p,1.2.3.4,1,float99\n")
      const error = yield* importPointsList(badList, configPath, { dryRun: false }).pipe(Effect.flip)
      expect(error.message).toContain("nothing was written. Its devices start at devices[3]")
      expect(yield* fs.readFileString(configPath)).toBe(written)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
