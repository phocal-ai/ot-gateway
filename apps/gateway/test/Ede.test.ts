/**
 * EDE files read as points lists: the example file's points and skipped objects, device and point names made
 * unique, columns found by name, and mistakes named by line.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { exampleConfigPath } from "../src/Demo.ts"
import { edeToPointsList, isEde } from "../src/Ede.ts"
import { readPointsList } from "../src/Import.ts"
import { devicesFromPointsList, parseDelimited } from "../src/PointsList.ts"
import { pointsListTemplate } from "../src/PointsSchema.ts"

const exampleEde = exampleConfigPath.replace(/gateway\.json$/, "building.ede.csv")

const header =
  "# keyname;device obj.-instance;object-name;object-type;object-instance;description;present-value-default;min-present-value;max-present-value;settable;supports COV;hi-limit;low-limit;state-text-reference;unit-code"
const ede = (...rows: ReadonlyArray<string>) =>
  ["PROJECT_NAME;Bau, Teil A, B", "VERSION_OF_LAYOUT;2.2", header, ...rows].join("\n")

describe("edeToPointsList", () => {
  it.effect("reads the example file's points, skips what is not a point, and makes nothing writable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const text = yield* fs.readFileString(exampleEde)
      expect(isEde(text)).toBe(true)
      const translation = yield* edeToPointsList(text)
      expect(translation).toMatchObject({ devices: 2, points: 7, skipped: { schedule: 1, "trend-log": 1 } })
      const devices = yield* devicesFromPointsList(translation.list)
      expect(devices.map((device) => [device.id, device.points.length])).toEqual([
        ["ahu-2", 5],
        ["heating-plant", 2]
      ])
      const valve = devices[0]?.points.find((point) => point.id === "heating-valve")
      expect(valve).toMatchObject({ objectType: "analog-output", instance: 1, unit: "unit:PERCENT" })
      expect(JSON.stringify(devices)).not.toContain("writable")
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("gives devices that share a name their instance, and points whose names collide their object", () =>
    Effect.gen(function* () {
      const { list } = yield* edeToPointsList(
        ede(
          "A;1;AHU;8;1;;;;;;;;;;",
          "B;2;AHU;8;2;;;;;;;;;;",
          "C;3;;8;3;;;;;;;;;;",
          "A1;1;Temp 1;0;1;;;;;;;;;;62",
          "A2;1;Temp-1;0;2;;;;;;;;;;62",
          "B1;2;Temp 1;0;1;;;;;;;;;;",
          "C1;3;Fan;3;1;;;;;;;;;;"
        )
      )
      const rows = parseDelimited(list).slice(1)
      expect(rows.map((row) => [row[0], row[1]])).toEqual([
        ["AHU device 1", "Temp 1"],
        ["AHU device 1", "Temp-1 analog-input 2"],
        ["AHU device 2", "Temp 1"],
        ["device 3", "Fan"]
      ])
      expect(yield* devicesFromPointsList(list)).toHaveLength(3)
    })
  )

  it.effect("finds the columns by name, takes type names as well as numbers, and skips comment rows", () =>
    Effect.gen(function* () {
      const reordered = [
        "keyname,object-type,object-instance,object-name,device obj.-instance,unit-code",
        "# a comment row",
        "x,analog-value,7,Setpoint,10,62"
      ].join("\n")
      const { list } = yield* edeToPointsList(reordered)
      expect(parseDelimited(list)[1]).toEqual(["device 10", "Setpoint", "unit:DEG_C", "10", "analog-value", "7"])
    })
  )

  it.effect("names the line of a row it cannot read, and a missing column", () =>
    Effect.gen(function* () {
      const bad = yield* edeToPointsList(ede("A1;one;Temp;0;1;;;;;;;;;;")).pipe(Effect.flip)
      expect(bad.message).toBe("EDE line 4: device obj.-instance and object-instance must be whole numbers")
      const missing = yield* edeToPointsList("keyname;device obj.-instance;object-name\n").pipe(Effect.flip)
      expect(missing.message).toBe("the EDE header has no object-type column")
    })
  )

  it("does not take a points list for an EDE file", () => {
    expect(isEde(pointsListTemplate())).toBe(false)
  })
})

describe("readPointsList", () => {
  it.effect("translates an EDE file, so import and init read it like a points list", () =>
    Effect.gen(function* () {
      const list = yield* readPointsList(exampleEde)
      expect(list.split("\n")[0]).toBe("device,point,unit,device_instance,object_type,object_instance")
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
