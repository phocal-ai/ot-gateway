/**
 * Points lists: what a spreadsheet export looks like (commas or semicolons, quotes, a decimal comma) becomes
 * devices the config schema accepts, and every mistake names its line.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem, Result } from "effect"
import { exampleConfigPath } from "../src/Demo.ts"
import { describeUnits, importPointsList } from "../src/Import.ts"
import { initConfig, simulatedDevice } from "../src/Init.ts"
import {
  devicesFromPointsList,
  parseDelimited,
  qudtUnit,
  readableName,
  readDelimited,
  unitsWritten
} from "../src/PointsList.ts"

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

describe("readDelimited", () => {
  it("gives each record the line it starts on, past blank lines and quoted line breaks", () => {
    expect(readDelimited('﻿a,b\r\n\r\n"x\r\ny",z\r\n1,2\n\n\n3,4')).toEqual(
      Result.succeed([
        { line: 1, fields: ["a", "b"] },
        { line: 3, fields: ["x\r\ny", "z"] },
        { line: 5, fields: ["1", "2"] },
        { line: 8, fields: ["3", "4"] }
      ])
    )
  })

  it("names the line an unclosed quote opened on", () => {
    const read = readDelimited('a,b\n1,2\n\n3,"4\n5,6\n')
    expect(Result.isFailure(read) ? read.failure.line : undefined).toBe(4)
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

describe("readableName", () => {
  it("shows a point written as an id as a name, and keeps a name as written", () => {
    expect(readableName("active-power")).toBe("Active power")
    expect(readableName("main_breaker_tripped")).toBe("Main breaker tripped")
    expect(readableName("energy")).toBe("Energy")
    expect(readableName("Supply air temp")).toBe("Supply air temp")
    expect(readableName("CO2")).toBe("CO2")
  })
})

describe("devicesFromPointsList", () => {
  it.effect("marks alarm points on or off, and names points written as ids unless a name column gives one", () =>
    Effect.gen(function* () {
      const [device] = yield* devicesFromPointsList(
        [
          "device,point,name,alarm,host,register,table",
          "panel,main-breaker-tripped,,on,1.2.3.4,0,discrete",
          "panel,door-closed,Door contact,OFF,1.2.3.4,1,discrete",
          "panel,power-ok,,,1.2.3.4,2,discrete"
        ].join("\n")
      )
      expect(device?.points.map((point) => [point.id, point.name, point.alarmWhen])).toEqual([
        ["main-breaker-tripped", "Main breaker tripped", "on"],
        ["door-closed", "Door contact", "off"],
        ["power-ok", "Power ok", undefined]
      ])
      const config = yield* parseConfig(JSON.stringify({ ...minimalConfig, devices: [device] }))
      expect(config.devices[0]?.points.map((point) => point.alarmWhen)).toEqual(["on", "off", undefined])
    })
  )

  it.effect("refuses an alarm that is neither on nor off, and reads an old list's name column as the point", () =>
    Effect.gen(function* () {
      expect(yield* mistake("device,point,alarm,host,register,table\nm,p,yes,1.2.3.4,0,coil")).toBe(
        'line 2: "p" has alarm "yes"; write on (the alarm is active when the value is true or not 0) or off (active when false or 0), or leave it empty'
      )
      const [device] = yield* devicesFromPointsList("device,name,host,register,table\nm,Pump fault,1.2.3.4,0,coil")
      expect(device?.points.map((point) => [point.id, point.name])).toEqual([["pump-fault", "Pump fault"]])
    })
  )

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
        { id: "breaker-tripped", name: "Breaker tripped", table: "coil", address: 0, dataType: "bool", alarmWhen: "on" }
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

  it.effect("names every mistake in one pass, each with its line, column and value, in the order of the lines", () =>
    Effect.gen(function* () {
      const list = [
        "device,point,unit,interval_s,host,register,type,byte_order",
        "Meter,Active power,kW,5,10.0.0.1,100,float32,CDAB",
        "Meter,Energy,kWh,5,10.0.0.1,102,uint33,",
        "Meter,Active power,kW,5,10.0.0.1,104,float32,",
        "Meter,Voltage,V,5,10.0.0.1,,float32,",
        "Pump,Speed,rpm,0.01,10.0.0.2,1,int16,",
        "Valve,Position,%,5,,,,"
      ].join("\n")
      const error = yield* Effect.flip(devicesFromPointsList(list))
      expect(error.issues).toEqual([
        {
          line: 3,
          column: "type",
          value: "uint33",
          message:
            'type "uint33": Expected "int16" | "uint16" | "int32" | "uint32" | "float32" | "int64" | "uint64" | "float64" | "bool"'
        },
        {
          line: 4,
          column: "point",
          value: "Active power",
          message: 'two points of "Meter" are both called active-power, here and on line 2'
        },
        { line: 5, column: "register", message: '"Voltage" has a host but no register' },
        {
          line: 6,
          column: "interval_s",
          value: "0.01",
          message: 'interval_s "0.01": Expected a value between 0.1 and 86400 (in seconds)'
        },
        { message: 'device "Valve": give it a host (Modbus TCP) or a device_instance (BACnet/IP)' }
      ])
      expect(error.message.split("\n")).toHaveLength(5)
      expect(error.message.split("\n")[1]).toBe(
        'line 4: two points of "Meter" are both called active-power, here and on line 2'
      )
    })
  )

  it.effect("names a profile mistake with the device's other mistakes, and a device value on the row that has it", () =>
    Effect.gen(function* () {
      const profiled = yield* Effect.flip(
        devicesFromPointsList(
          "device,point,host,register,type,profile\nm,b,,,,nope\nm,c,10.0.0.1,1,uint16x,\nM,a,10.0.0.1,1,uint16,\n"
        )
      )
      expect(profiled.message.split("\n")).toEqual([
        'line 2: profile "nope" was not loaded',
        'line 3: type "uint16x": Expected "int16" | "uint16" | "int32" | "uint32" | "float32" | "int64" | "uint64" | "float64" | "bool"',
        '"m" and "M" are the same device id "m"; use one spelling'
      ])
      const interval = yield* Effect.flip(
        devicesFromPointsList(
          "device,point,host,register,type,interval_s\nm,a,10.0.0.1,1,uint16,\nm,b,10.0.0.1,2,uint16,0.01\n"
        )
      )
      expect(interval.issues).toEqual([
        {
          line: 3,
          column: "interval_s",
          value: "0.01",
          message: 'interval_s "0.01": Expected a value between 0.1 and 86400 (in seconds)'
        }
      ])
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

  it.effect("refuses two spellings of one device in the list, naming both", () =>
    Effect.gen(function* () {
      expect(yield* mistake("device,point,host,register,type\nAHU-1,p,1.2.3.4,1,int16\nAHU 1,q,1.2.3.4,2,int16")).toBe(
        '"AHU-1" and "AHU 1" are the same device id "ahu-1"; use one spelling'
      )
    })
  )

  it.effect("refuses a row with more fields than the header, an unclosed quote and a column given twice", () =>
    Effect.gen(function* () {
      expect(yield* mistake("device,point,host,register,type,scale\nm,p,1.2.3.4,1,int16,1,5")).toBe(
        "line 2: 7 fields, but the header has 6 columns; a value containing the delimiter (a decimal comma, say) needs quotes"
      )
      expect(yield* mistake('device,point,host,register,type\nm,p,1.2.3.4,1,int16\n\nm,"q,1.2.3.4,2,int16\n')).toBe(
        "line 4: a quote opened here is never closed"
      )
      expect(yield* mistake("device,point_name,point,host\nm,p,q,1.2.3.4")).toBe(
        'the header has both "point_name" and "point", which are the same column'
      )
    })
  )

  it.effect("reads a list with two unknown columns of the same name, which it ignores", () =>
    Effect.gen(function* () {
      const devices = yield* devicesFromPointsList(
        "device,point,host,register,type,notes,Notes\nm,p,1.2.3.4,1,int16,first,second\n"
      )
      expect(devices.map((device) => device.id)).toEqual(["m"])
    })
  )

  it.effect("names the line as the file has it, past blank lines and quoted line breaks", () =>
    Effect.gen(function* () {
      expect(
        yield* mistake('device,point,host,register,type\n\nm,"p\nq",1.2.3.4,1,int16\n\nm,r,1.2.3.4,abc,int16')
      ).toBe('line 6: register "abc" is not a number')
    })
  )

  it.effect("reads rows with trailing empty fields or fewer fields than the header", () =>
    Effect.gen(function* () {
      const devices = yield* devicesFromPointsList(
        "device,point,host,register,type,unit,\nm,p,1.2.3.4,1,int16,kW,,,\nm,q,1.2.3.4,2,int16\n"
      )
      expect(devices[0]?.points.map((point) => [point.id, point.unit])).toEqual([
        ["p", "unit:KiloW"],
        ["q", undefined]
      ])
    })
  )
})

describe("the units of an import", () => {
  it("names each distinct unit once, with the QUDT name that goes out and how many points", () => {
    const units = unitsWritten(
      "device,point,unit\nm,p1,kW\nm,p2,kW\nm,p3,°C\nm,p4,unit:BAR\nm,p5,m/s\nm,p6,\nm,p7,kWhh\n"
    )
    expect(units).toEqual([
      { written: "kW", unit: "unit:KiloW", qudt: true, points: 2 },
      { written: "°C", unit: "unit:DEG_C", qudt: true, points: 1 },
      { written: "unit:BAR", unit: "unit:BAR", qudt: true, points: 1 },
      { written: "m/s", unit: "m/s", qudt: false, points: 1 },
      { written: "kWhh", unit: "kWhh", qudt: false, suggestion: "unit:KiloW-HR", points: 1 }
    ])
    expect(describeUnits(units)).toEqual([
      "units, as the $meta of each point carries them (QUDT names):",
      "  kW -> unit:KiloW  (2 points)",
      "  °C -> unit:DEG_C  (1 point)",
      "  unit:BAR  (1 point)",
      "  m/s  kept as written: no QUDT name known for it; write one (unit:…) if consumers need it  (1 point)",
      "  kWhh  kept as written: no QUDT name known for it (did you mean unit:KiloW-HR?); write one (unit:…) if consumers need it  (1 point)"
    ])
    // A prefix is another unit, not a typo: no suggestion.
    const prefixed = unitsWritten("device,point,unit\nm,a,mbar\nm,b,hPa\nm,c,GWh\nm,d,kvarh\nm,e,MPa\n")
    expect(prefixed.map((mapping) => mapping.suggestion)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    ])
    expect(unitsWritten("device,point\nm,p\n")).toEqual([])
    expect(describeUnits([])).toEqual([])
  })
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
      expect(error.message).toBe(
        'line 2: type "float99": Expected "int16" | "uint16" | "int32" | "uint32" | "float32" | "int64" | "uint64" | "float64" | "bool"'
      )
      expect(error._tag === "PointsListError" && error.issues).toEqual([
        expect.objectContaining({ line: 2, column: "type", value: "float99" })
      ])
      expect(yield* fs.readFileString(configPath)).toBe(written)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("takes the list as text in place of a file, and says so when a file and a text are both named", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const configPath = `${directory}/gateway.json`
      yield* fs.writeFileString(configPath, JSON.stringify(initConfig(answers, [])))
      const list = yield* fs.readFileString(examplePoints)

      const checked = yield* importPointsList("-", configPath, { dryRun: true, text: list })
      expect(checked.added.map((device) => device.id)).toEqual(["energy-meter", "pv-inverter", "heat-pump"])
      const rows = JSON.stringify([
        { device: "Meter 2", point: "Power", host: "192.168.1.20", register: 100, type: "float32" }
      ])
      const result = yield* importPointsList("-", configPath, { dryRun: false, text: rows })
      expect(result.config?.devices.map((device) => device.id)).toEqual(["meter-2"])

      const both = yield* importPointsList(examplePoints, configPath, { dryRun: true, text: list }).pipe(Effect.flip)
      expect(both.message).toContain("both name a points list")
      const neither = yield* importPointsList("-", configPath, { dryRun: true }).pipe(Effect.flip)
      expect(neither.message).toBe("- stands for a points list given with --text, and there is none")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps the previous config as .bak, leaves no .tmp and keeps the file's mode", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const configPath = `${directory}/gateway.json`
      // A config with a device: init's empty one, the first time, is not backed up (ConfigStore's keepsBackup).
      const original = JSON.stringify(initConfig(answers, [simulatedDevice]))
      yield* fs.writeFileString(configPath, original, { mode: 0o600 })
      yield* fs.chmod(configPath, 0o600)

      yield* importPointsList(examplePoints, configPath, { dryRun: false })
      expect(yield* fs.readFileString(`${configPath}.bak`)).toBe(original)
      expect(yield* fs.exists(`${configPath}.tmp`)).toBe(false)
      expect((yield* fs.stat(configPath)).mode & 0o777).toBe(0o600)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("fails with the file as it was when the write fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const configPath = `${directory}/gateway.json`
      const original = JSON.stringify(initConfig(answers, []))
      yield* fs.writeFileString(configPath, original)
      yield* fs.makeDirectory(`${configPath}.bak`)

      const error = yield* importPointsList(examplePoints, configPath, { dryRun: false }).pipe(Effect.flip)
      expect(error._tag).toBe("PointsListError")
      expect(error.message.endsWith("is as it was")).toBe(true)
      expect(yield* fs.readFileString(configPath)).toBe(original)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("a points list as JSON", () => {
  const csv = [
    "device,point,unit,host,register,type,byte_order",
    "Meter,Active power,kW,10.0.0.1,100,float32,CDAB",
    "Heat pump,Flow,°C,,,,"
  ].join("\n")

  it.effect("reads the same devices as the CSV with the same columns, numbers as JSON numbers", () =>
    Effect.gen(function* () {
      const json = JSON.stringify([
        {
          device: "Meter",
          point: "Active power",
          unit: "kW",
          host: "10.0.0.1",
          register: 100,
          type: "float32",
          byte_order: "CDAB"
        }
      ])
      const fromJson = yield* devicesFromPointsList(json)
      const fromCsv = yield* devicesFromPointsList(csv.split("\n").slice(0, 2).join("\n"))
      expect(fromJson).toEqual(fromCsv)
      expect(unitsWritten(json)).toEqual([{ written: "kW", unit: "unit:KiloW", qudt: true, points: 1 }])
    })
  )

  it.effect("names the line in the file each row starts on, with every mistake at once", () =>
    Effect.gen(function* () {
      const json = [
        "[",
        '  { "device": "Meter", "point": "Active power", "host": "10.0.0.1", "register": 100, "type": "float32" },',
        "  {",
        '    "device": "Meter",',
        '    "point": "Energy",',
        '    "host": "10.0.0.1",',
        '    "register": 102,',
        '    "type": "uint33"',
        "  },",
        '  { "device": "Pump", "point": "Speed", "interval_s": 0.01, "host": "10.0.0.2", "register": 1, "type": "int16" }',
        "]"
      ].join("\n")
      const error = yield* Effect.flip(devicesFromPointsList(json))
      expect(error.issues?.map((issue) => [issue.line, issue.column])).toEqual([
        [3, "type"],
        [10, "interval_s"]
      ])
    })
  )

  it.effect("refuses what is not an array of flat rows, naming the line", () =>
    Effect.gen(function* () {
      const notArray = yield* Effect.flip(devicesFromPointsList('{"device": "m"}'))
      expect(notArray.message).toContain("an array of rows")
      const broken = yield* Effect.flip(
        devicesFromPointsList('[\n  {"device": "m", "point": "p"},\n  {"device": "m",}\n]')
      )
      expect(broken.issues?.[0]?.line).toBe(3)
      expect(broken.message).toMatch(/^line 3: not valid JSON: /)
      const empty = yield* Effect.flip(devicesFromPointsList("[]"))
      expect(empty.message).toBe("the points list is empty")
      const spelled = yield* devicesFromPointsList(
        '[{"device": "m", "point": "p", "unit": "kW", "host": "h", "register": 1, "type": "int16"},\r{"device": "m", "point": "q", "Unit": "kWh", "host": "h", "register": 2, "type": "int16"}]'
      )
      expect(spelled[0]?.points.map((point) => point.unit)).toEqual(["unit:KiloW", "unit:KiloW-HR"])
      const nested = yield* Effect.flip(
        devicesFromPointsList(
          '[\n  {"device": "m", "point": "p"},\n  {"device": "m", "point": "q", "scale": {"x": 1}},\n  "row"\n]'
        )
      )
      expect(nested.issues).toEqual([
        { line: 3, column: "scale", message: "scale is an object or a list; write text or a number" },
        { line: 4, message: 'each row of a JSON points list is an object, such as {"device": "Meter", …}' }
      ])
    })
  )
})
