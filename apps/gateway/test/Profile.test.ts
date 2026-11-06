/**
 * Device profiles: the library is valid, a points list row picks a profile's points, and a draft next to the
 * list is read by its path.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem } from "effect"
import { basename, join } from "node:path"
import { devicesFromPointsList } from "../src/PointsList.ts"
import { libraryPath, libraryProfiles, type Profile, profileProblems, resolveProfile } from "../src/Profile.ts"

const meter: Profile = {
  format: "ot-gateway device profile",
  version: 1,
  id: "acme-m1",
  vendor: "Acme",
  model: "M1",
  protocol: "modbus-tcp",
  source: { document: "Acme M1 register map", revision: "2" },
  verified: false,
  points: [
    { name: "Voltage", register: 0, table: "input", type: "float32", unit: "V" },
    { name: "Energy", register: 10, table: "input", type: "uint32", scale: 0.1, unit: "kWh" }
  ]
}

const profiles = new Map([["acme-m1", meter]])

const failure = (text: string) => devicesFromPointsList(text, [], profiles).pipe(Effect.flip)

describe("the profile library", () => {
  it.effect("holds valid profiles, each in a file named after its id", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const library = yield* libraryProfiles()
      expect(library.length).toBeGreaterThan(0)
      const files = (yield* fs.readDirectory(libraryPath)).filter((file) => file.endsWith(".json")).toSorted()
      expect(files).toEqual(library.map((profile) => `${profile.id}.json`))
      for (const profile of library) {
        expect(profile.source.document).not.toBe("")
        // Every library profile makes a valid config through a points list.
        const devices = yield* devicesFromPointsList(
          `device,point,host,profile\nmeter,*,10.0.0.1,${profile.id}\n`,
          [],
          new Map([[profile.id, profile]])
        )
        yield* parseConfig(JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://127.0.0.1" }, devices }))
      }
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

describe("profileProblems", () => {
  it("names duplicate point names and overlapping registers", () => {
    expect(profileProblems(meter)).toEqual([])
    const broken: Profile = {
      ...meter,
      points: [
        ...meter.points,
        { name: "voltage", register: 1, table: "input", type: "uint16" },
        { name: "Alarm", register: 0, table: "coil", type: "bool" }
      ]
    }
    expect(profileProblems(broken)).toEqual([
      '"voltage" and "Voltage" have the same id, voltage',
      '"voltage" overlaps "Voltage" at input 1'
    ])
  })
})

describe("a points list with profiles", () => {
  it.effect("takes every point with *, one by name, and the row's own columns first", () =>
    Effect.gen(function* () {
      const [all] = yield* devicesFromPointsList(
        "device,point,host,unit_id,profile,byte_order\nMeter A,*,10.0.0.1,4,acme-m1,CDAB\n",
        [],
        profiles
      )
      expect(all).toMatchObject({ unitId: 4 })
      expect(all?.points).toEqual([
        {
          id: "voltage",
          name: "Voltage",
          unit: "unit:V",
          table: "input",
          address: 0,
          dataType: "float32",
          byteOrder: "CDAB"
        },
        {
          id: "energy",
          name: "Energy",
          unit: "unit:KiloW-HR",
          scaling: { factor: 0.1 },
          table: "input",
          address: 10,
          dataType: "uint32",
          byteOrder: "CDAB"
        }
      ])
      const [one] = yield* devicesFromPointsList(
        "device,point,host,profile,publish,publish_s\nMeter B,energy,10.0.0.2,acme-m1,aggregate,900\n",
        [],
        profiles
      )
      expect(one?.points).toMatchObject([{ id: "energy", address: 10 }])
    })
  )

  it.effect("names what is wrong: a register beside a profile, a point it does not have", () =>
    Effect.gen(function* () {
      expect((yield* failure("device,point,host,profile,register\nM,*,10.0.0.1,acme-m1,5\n")).message).toBe(
        "line 2: the row takes register from profile acme-m1; leave register empty"
      )
      expect((yield* failure("device,point,host,profile\nM,Enrgy,10.0.0.1,acme-m1\n")).message).toBe(
        'line 2: profile acme-m1 has no point "Enrgy"; did you mean energy? (* takes all: voltage, energy)'
      )
      expect((yield* failure("device,point,device_instance,profile\nM,*,7,acme-m1\n")).message).toBe(
        "line 2: profiles describe Modbus devices; this row has a device_instance"
      )
    })
  )
})

describe("resolveProfile", () => {
  it.effect("reads a draft by its path next to the list, and suggests a library id for a typo", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(join(folder, "m1.json"), JSON.stringify(meter))
      expect((yield* resolveProfile("./m1.json", { relativeTo: folder })).id).toBe("acme-m1")
      const library = (yield* libraryProfiles())[0]
      if (library === undefined) return
      const typo = `${library.id.slice(0, -1)}x`
      const error = yield* resolveProfile(typo, { relativeTo: folder }).pipe(Effect.flip)
      expect(error.message).toContain(`did you mean ${library.id}?`)
      expect(basename(libraryPath)).toBe("profiles")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
