/**
 * `discover --points-list --append`: discovered rows added to a points list written by hand, read the way import
 * reads it. The list keeps its rows, separator and line breaks; columns it lacks are added; rows it has are skipped;
 * the result is one list that import turns into every device.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DescribedDevice } from "@ot-gateway/bacnet"
import { parseDeviceAddress } from "@ot-gateway/bacnet"
import { Effect, Result } from "effect"
import { draftColumns, draftDevices, draftRows } from "../src/Discover.ts"
import { devicesFromPointsList } from "../src/PointsList.ts"
import { appendToPointsList, padRows } from "../src/PointsListAppend.ts"

const heatPump = (name = "heat-pump", objects: DescribedDevice["objects"] = []) =>
  draftRows(
    draftDevices([
      {
        device: { instance: 2001, address: Result.getOrThrow(parseDeviceAddress("127.0.0.1:47809")), conflicts: [] },
        described: {
          name,
          listed: 2,
          objects:
            objects.length > 0
              ? objects
              : [
                  { objectType: "analog-input", instance: 1, name: "Flow temperature", unit: "unit:DEG_C" },
                  { objectType: "binary-input", instance: 1, name: "Compressor running" }
                ]
        }
      }
    ])
  )

const append = (text: string, rows: ReadonlyArray<ReadonlyArray<string>>) =>
  Result.getOrThrow(appendToPointsList(text, draftColumns, rows))

const modbusList = [
  "device,point,unit,host,register,type",
  "boiler,Supply temperature,°C,10.0.1.5,100,int16",
  "boiler,Return temperature,°C,10.0.1.5,101,int16",
  ""
].join("\n")

describe("appendToPointsList", () => {
  it("adds the columns the list lacks after its own, keeps its rows, and import reads both devices", () =>
    Effect.gen(function* () {
      const result = append(modbusList, heatPump())
      expect(result).toMatchObject({ added: 2, devices: 1, skipped: 0 })
      expect(result.text.split("\n")).toEqual([
        "device,point,unit,host,register,type,publish,device_instance,address,object_type,object_instance",
        "boiler,Supply temperature,°C,10.0.1.5,100,int16,,,,,",
        "boiler,Return temperature,°C,10.0.1.5,101,int16,,,,,",
        "heat-pump,Flow temperature,unit:DEG_C,,,,sample,2001,127.0.0.1:47809,analog-input,1",
        "heat-pump,Compressor running,,,,,sample,2001,127.0.0.1:47809,binary-input,1",
        ""
      ])
      const devices = yield* devicesFromPointsList(result.text)
      expect(devices.map((device) => [device.id, device.protocol, device.points.length])).toEqual([
        ["boiler", "modbus-tcp", 2],
        ["heat-pump", "bacnet-ip", 2]
      ])
    }).pipe(Effect.runSync))

  it("keeps a semicolon list's separator, line breaks, byte order mark and header spelling, and quotes as needed", () =>
    Effect.gen(function* () {
      const list = "﻿Device Name;Name;Unit;IP;Register;Data Type\r\nboiler;Supply temperature;°C;10.0.1.5;100;int16\r\n"
      const result = append(
        list,
        heatPump("heat-pump", [{ objectType: "analog-input", instance: 1, name: "Supply, temp" }])
      )
      expect(result.text).toBe(
        "﻿Device Name;Name;Unit;IP;Register;Data Type;publish;device_instance;address;object_type;object_instance\r\n" +
          "boiler;Supply temperature;°C;10.0.1.5;100;int16;;;;;\r\n" +
          'heat-pump;"Supply, temp";;;;;sample;2001;127.0.0.1:47809;analog-input;1\r\n'
      )
      const devices = yield* devicesFromPointsList(result.text)
      expect(devices[1]?.points.map((point) => point.name)).toEqual(["Supply, temp"])
    }).pipe(Effect.runSync))

  it("skips rows the list has, by device and point or by BACnet object, and leaves the text as it was", () => {
    const once = append(modbusList, heatPump())
    const twice = append(once.text, heatPump())
    expect(twice).toEqual({ text: once.text, added: 0, devices: 0, skipped: 2 })
    // Written by hand under another name, with the object type spelt differently: the same object.
    const byHand = [
      "device;point;device_instance;object_type;object_instance",
      "Heat Pump;Vorlauf;2001;Analog Input;1",
      "Heat Pump;Kompressor;;binary-input;1",
      ""
    ].join("\n")
    const result = append(byHand, heatPump())
    expect(result).toMatchObject({ added: 0, skipped: 2 })
  })

  it("adds a device's new objects under the name the list gives its device instance", () => {
    const byHand = "device,point,device_instance,object_type,object_instance\nHeat Pump,Vorlauf,2001,analog-input,1\n"
    const result = append(byHand, heatPump())
    expect(result).toMatchObject({ added: 1, skipped: 1 })
    expect(result.text.split("\n")[2]).toBe("Heat Pump,Compressor running,2001,binary-input,1,,sample,127.0.0.1:47809")
  })

  it("renames a discovered device whose name the list gives another device, so import keeps them apart", () =>
    Effect.gen(function* () {
      const list = "device,point,host,register,type\nheat-pump,Power,10.0.1.9,0,uint16\n"
      const result = append(list, heatPump())
      expect(result.text).toContain("heat-pump-2001,Flow temperature,")
      const devices = yield* devicesFromPointsList(result.text)
      expect(devices.map((device) => device.id)).toEqual(["heat-pump", "heat-pump-2001"])
    }).pipe(Effect.runSync))

  it("writes a point name a spreadsheet would run as a formula as its id", () => {
    const result = append(
      modbusList,
      heatPump("heat-pump", [{ objectType: "analog-input", instance: 7, name: '=HYPERLINK("x")' }])
    )
    expect(result.text).not.toContain("=HYPERLINK")
    expect(result.text).toContain("heat-pump,hyperlink-x,")
  })

  it("starts a list in an empty file, and refuses text that is not a points list", () => {
    expect(append("", heatPump()).text.split("\n")[0]).toBe(draftColumns.join(","))
    expect(appendToPointsList("name,value\nx,1\n", draftColumns, [])).toEqual(
      Result.fail("its header has no device and point columns (it has name, value); is it a points list?")
    )
    expect(appendToPointsList('device,point\n"open,x\n', draftColumns, [])).toEqual(
      Result.fail("line 2: a quote opened here is never closed")
    )
  })

  it("pads every earlier row to the new header's column count, a short one and one with a quoted line break too", () =>
    Effect.gen(function* () {
      const list = 'device,point,host,register,type\nboiler,"Supply,\ntemp",10.0.1.5,0,int16\nboiler,Return\n\n'
      const result = append(list, heatPump())
      const width = result.text.split("\n")[0]?.split(",").length ?? 0
      expect(result.text).toContain('boiler,"Supply,\ntemp",10.0.1.5,0,int16,,,,,,\n')
      expect(result.text).toContain("\nboiler,Return,,,,,,,,,\n")
      expect(width).toBe(11)
      const devices = yield* devicesFromPointsList(
        result.text.replace("boiler,Return,,,", "boiler,Return,10.0.1.5,1,int16")
      )
      expect(devices.map((device) => device.id)).toEqual(["boiler", "heat-pump"])
    }).pipe(Effect.runSync))
})

describe("padRows", () => {
  it("adds empty fields at the end of short rows only, before the line break, and leaves empty lines alone", () => {
    expect(padRows("\na;b\r\n\r\na;b;c;d\r\na", ";", 3)).toBe("\na;b;\r\n\r\na;b;c;d\r\na;;")
    expect(padRows('\n"x;\n";y', ";", 3)).toBe('\n"x;\n";y;')
  })
})
