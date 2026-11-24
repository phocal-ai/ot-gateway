/**
 * The points list's schema is the format: every column it names is one the reader reads, the template and the
 * example list use only its columns and import cleanly, and a dry run checks a list without a config.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { fileURLToPath } from "node:url"
import { exampleConfigPath } from "../src/Demo.ts"
import { importPointsList } from "../src/Import.ts"
import { columnAliases, devicesFromPointsList, parseDelimited, readColumns } from "../src/PointsList.ts"
import { resolveProfile } from "../src/Profile.ts"
import {
  briefPointsListSchema,
  briefPointsListSchemaJson,
  describePointsListSchema,
  firstSentence,
  pointsListColumns,
  pointsListRules,
  pointsListSchema,
  pointsListTemplate,
  unknownColumns
} from "../src/PointsSchema.ts"

const examplePoints = exampleConfigPath.replace(/gateway\.json$/, "points.csv")
const readerSource = fileURLToPath(new URL("../src/PointsList.ts", import.meta.url))

describe("the points list schema", () => {
  it.effect("names only columns the reader reads, and every alias leads to one of them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const source = yield* fs.readFileString(readerSource)
      for (const column of pointsListColumns) expect(source).toContain(`"${column.name}"`)
      const names = pointsListColumns.map((column) => column.name)
      for (const target of Object.values(columnAliases)) expect(names).toContain(target)
      expect(readColumns).toEqual(names)
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it("prints as JSON with its version and aliases, and as text with every column", () => {
    const schema = pointsListSchema()
    expect(schema.version).toBe(1)
    expect(schema.columns.find((column) => column.name === "unit_id")?.aliases).toContain("slave")
    expect(schema.columns.find((column) => column.name === "type")?.values).toContain("float32")
    const text = describePointsListSchema()
    for (const column of pointsListColumns) expect(text).toContain(`  ${column.name} `)
  })

  it("prints in brief as JSON with one line per column: name, scope, required, first sentence, values, no aliases", () => {
    const text = briefPointsListSchemaJson()
    const brief = JSON.parse(text)
    expect(brief).toEqual(briefPointsListSchema())
    expect(text.split("\n").length).toBeLessThan(pointsListColumns.length + pointsListRules.length + 10)
    expect(text).not.toContain("aliases")
    const point = brief.columns.find((column: { name: string }) => column.name === "point")
    expect(point).toEqual({
      name: "point",
      scope: "any",
      required: true,
      description: "The point's name, unique within its device; its id (the topic) is the name as a slug"
    })
    const publish = brief.columns.find((column: { name: string }) => column.name === "publish")
    expect(publish?.values).toEqual(["sample", "aggregate", "change"])
    expect(describePointsListSchema({ brief: true })).not.toContain("A slug (active-power)")
    expect(describePointsListSchema()).toContain("A slug (active-power)")
  })

  it("keeps a description's first sentence, and the whole of one that has only one", () => {
    expect(firstSentence("The address. A data sheet's 40101 is register 100")).toBe("The address")
    expect(firstSentence("value = raw × scale + offset")).toBe("value = raw × scale + offset")
    expect(firstSentence("kW, kWh, °C, %, … or a QUDT name such as unit:KiloW")).toBe(
      "kW, kWh, °C, %, … or a QUDT name such as unit:KiloW"
    )
  })

  it("names the columns it does not know, as written", () => {
    expect(unknownColumns(["Device", "Point name", "IP", "Registr", "Comment", ""])).toEqual(["Registr", "Comment"])
  })

  it.effect("has a template and an example list that use only its columns and make devices", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const example = yield* fs.readFileString(examplePoints)
      const profiles = new Map([["eastron-sdm630", yield* resolveProfile("eastron-sdm630", { relativeTo: "." })]])
      for (const [list, protocols] of [
        [pointsListTemplate(), ["modbus-tcp", "modbus-tcp", "bacnet-ip"]],
        [example, ["modbus-tcp", "modbus-tcp", "bacnet-ip"]]
      ] as const) {
        expect(unknownColumns(parseDelimited(list)[0] ?? [])).toEqual([])
        const devices = yield* devicesFromPointsList(list, [], profiles)
        expect(devices.map((device) => device.protocol)).toEqual(protocols)
      }
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

describe("import --dry-run without a config", () => {
  it.effect("checks the devices against the gateway's schema", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const absent = `${directory}/ot-gateway.json`
      const template = `${directory}/points.csv`
      yield* fs.writeFileString(template, pointsListTemplate())
      // No config named, and none in the working directory (this package's folder).
      expect(yield* fs.exists("ot-gateway.json")).toBe(false)
      const result = yield* importPointsList(template, undefined, { dryRun: true })
      expect(result.added).toHaveLength(3)
      expect(result.against).toBeUndefined()

      const bad = `${directory}/bad.csv`
      yield* fs.writeFileString(bad, "device,point,host,register,type\nMeter,p,1.2.3.4,1,float99\n")
      const error = yield* importPointsList(bad, undefined, { dryRun: true }).pipe(Effect.flip)
      expect(error.message).toContain("would make a config invalid")
      expect(error.message).not.toContain("nothing was written")

      // A config that is named but not there is a mistake, dry run or not: never "ok" against a file that is missing.
      for (const dryRun of [true, false]) {
        const missing = yield* importPointsList(template, absent, { dryRun }).pipe(Effect.flip)
        expect(missing.message).toContain(`no config at ${absent}`)
        expect(missing.message).toContain(`ot-gateway init <folder> --points ${template}`)
      }
      expect(yield* fs.exists(absent)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
