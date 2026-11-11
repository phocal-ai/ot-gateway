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
  describePointsListSchema,
  pointsListColumns,
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
      const result = yield* importPointsList(template, absent, { dryRun: true })
      expect(result.added).toHaveLength(3)
      expect(yield* fs.exists(absent)).toBe(false)

      const bad = `${directory}/bad.csv`
      yield* fs.writeFileString(bad, "device,point,host,register,type\nMeter,p,1.2.3.4,1,float99\n")
      const error = yield* importPointsList(bad, absent, { dryRun: true }).pipe(Effect.flip)
      expect(error.message).toContain("would make a config invalid")
      expect(error.message).not.toContain("nothing was written")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
