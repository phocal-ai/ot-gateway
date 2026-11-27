/**
 * `config get|set|unset|remove|undo`: one key of the config file by its path, devices and points by id, checked
 * with the gateway's schema before anything is written, never a way to make a point writable, and undone from
 * the `.bak`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem, type Scope } from "effect"
import {
  formatConfigChange,
  formatConfigGet,
  getConfigValue,
  parsePath,
  parseValue,
  removeFromConfig,
  setConfigValue,
  undoConfig,
  valueAt,
  withValue,
  writesTouched
} from "../src/ConfigEdit.ts"

const devices = [
  {
    protocol: "modbus-tcp",
    id: "heat-pump",
    host: "10.0.0.5",
    points: [
      { id: "setpoint", name: "Room setpoint", table: "holding", address: 10, dataType: "int16" },
      { id: "enable", name: "Enable", table: "coil", address: 1, dataType: "bool", writable: true }
    ]
  },
  {
    protocol: "modbus-tcp",
    id: "meter",
    host: "10.0.0.6",
    points: [{ id: "power", name: "Power", table: "input", address: 2, dataType: "uint16" }]
  }
]

const base = { site: "s", building: "b", mqtt: { url: "mqtt://localhost:1883" }, devices }
const text = `${JSON.stringify(base, null, 2)}\n`

const folder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = `${yield* fs.makeTempDirectoryScoped()}/ot-gateway.json`
  yield* fs.writeFileString(path, text)
  return { fs, path }
})

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const write = { dryRun: false }

/** The base config with `change` made to a copy of it, as the gateway reads it. */
const config = (change: (draft: typeof base) => unknown) => parseConfig(JSON.stringify(change(structuredClone(base))))

describe("paths and values", () => {
  it("reads a path as its keys and a value as JSON, or as text when it is not", () => {
    expect(parsePath("devices.heat-pump.points.setpoint.unit")).toEqual([
      "devices",
      "heat-pump",
      "points",
      "setpoint",
      "unit"
    ])
    expect(parsePath("")).toEqual([])
    expect(parseValue("5000")).toBe(5000)
    expect(parseValue("true")).toBe(true)
    expect(parseValue('{"factor": 0.1}')).toEqual({ factor: 0.1 })
    expect(parseValue("mqtts://broker:8883")).toBe("mqtts://broker:8883")
    expect(parseValue('"5000"')).toBe("5000")
  })

  it("finds devices and points by id, sets a key, makes missing blocks and takes a key out", () => {
    expect(valueAt(base, parsePath("devices.meter.points.power.address"))).toBe(2)
    // A device is named by its id, never by its position; a list without ids by position.
    expect(valueAt(base, parsePath("devices.1.host"))).toBeUndefined()
    expect(valueAt({ tags: ["a", "b"] }, ["tags", "1"])).toBe("b")
    expect(valueAt(base, ["constructor"])).toBeUndefined()
    expect(valueAt(base, parsePath("devices.nope.host"))).toBeUndefined()
    expect(valueAt(withValue(base, parsePath("status.bindAddress"), "0.0.0.0"), ["status"])).toEqual({
      bindAddress: "0.0.0.0"
    })
    const without = withValue(base, parsePath("devices.meter.host"), undefined)
    expect(valueAt(without, parsePath("devices.meter"))).toEqual({
      protocol: "modbus-tcp",
      id: "meter",
      points: devices[1]?.points
    })
    // A device or point is not made by naming it.
    expect(withValue(base, parsePath("devices.nope.host"), "1.2.3.4")).toMatchObject({
      code: "unknown-key",
      hint: "it has heat-pump, meter"
    })
    expect(withValue(base, parsePath("site.name"), "x")).toMatchObject({ code: "unknown-key" })
    expect(withValue(base, [], "x")).toMatchObject({ code: "unknown-key" })
  })

  it.effect("names every point whose commands a change touches, and none when writes only go away", () =>
    Effect.gen(function* () {
      const before = yield* config((draft) => draft)
      const allowed = yield* config((draft) => {
        Object.assign(draft.devices[0]?.points[0] ?? {}, { writable: true, limits: { min: 1, max: 2 } })
        return draft
      })
      expect(writesTouched(before, allowed)).toEqual(["heat-pump/setpoint"])
      const limitsOnly = yield* config((draft) => {
        Object.assign(draft.devices[0]?.points[0] ?? {}, { limits: { min: 1, max: 2 } })
        return draft
      })
      expect(writesTouched(before, limitsOnly)).toEqual(["heat-pump/setpoint"])
      const renamed = yield* config((draft) => {
        Object.assign(draft.devices[0] ?? {}, { id: "hp" })
        return draft
      })
      expect(writesTouched(before, renamed)).toEqual(["hp/enable"])
      const readOnly = yield* config((draft) => {
        Object.assign(draft.devices[0]?.points[1] ?? {}, { writable: false })
        return draft
      })
      expect(writesTouched(before, readOnly)).toEqual([])
      // A point that takes commands does not move to another register or device, and keeps its scaling.
      for (const move of [
        (draft: typeof base) => Object.assign(draft.devices[0]?.points[1] ?? {}, { address: 99 }),
        (draft: typeof base) => Object.assign(draft.devices[0] ?? {}, { host: "10.0.0.99" }),
        (draft: typeof base) => Object.assign(draft.devices[0] ?? {}, { unitId: 7 })
      ]) {
        const moved = yield* config((draft) => {
          move(draft)
          return draft
        })
        expect(writesTouched(before, moved)).toEqual(["heat-pump/enable"])
      }
      // What a command does not depend on may change: a name, how often the device is read.
      const renamedPoint = yield* config((draft) => {
        Object.assign(draft.devices[0]?.points[1] ?? {}, { name: "Enable heating" })
        Object.assign(draft.devices[0] ?? {}, { pollIntervalMs: 10_000 })
        return draft
      })
      expect(writesTouched(before, renamedPoint)).toEqual([])
      expect(writesTouched(allowed, before)).toEqual([])
    })
  )
})

describe("config set and unset", () => {
  it.effect("sets a key, keeps the previous file, says what changed and what to run next", () =>
    run(
      Effect.gen(function* () {
        const { fs, path } = yield* folder
        const report = yield* setConfigValue(path, "devices.heat-pump.pollIntervalMs", { set: "10000" }, write)
        expect(report).toMatchObject({
          ok: true,
          key: "devices.heat-pump.pollIntervalMs",
          before: null,
          after: 10_000,
          effective: 10_000,
          changed: true,
          changes: ["device heat-pump changed"],
          backup: `${path}.bak`
        })
        expect(report.next.map((step) => step.command)).toEqual([
          `ot-gateway diff ${path}`,
          `ot-gateway restart ${path}`
        ])
        expect(formatConfigChange(report)).toContain("devices.heat-pump.pollIntervalMs: not set → 10000")
        expect(yield* fs.readFileString(`${path}.bak`)).toBe(text)
        const saved = yield* parseConfig(yield* fs.readFileString(path))
        expect(saved.devices[0]?.pollIntervalMs).toBe(10_000)

        // The same again writes nothing.
        const again = yield* setConfigValue(path, "devices.heat-pump.pollIntervalMs", { set: "10000" }, write)
        expect(again).toMatchObject({ changed: false, next: [] })
        expect(again.backup).toBeUndefined()

        // Taken out, the default applies again.
        const unset = yield* setConfigValue(path, "devices.heat-pump.pollIntervalMs", { unset: true }, write)
        expect(unset).toMatchObject({ before: 10_000, after: null, effective: 5000, changed: true })
        expect(yield* fs.readFileString(path)).toBe(text)
      })
    )
  )

  it.effect("a dry run reports and names the command that writes it, with the config it is for", () =>
    run(
      Effect.gen(function* () {
        const { fs, path } = yield* folder
        const report = yield* setConfigValue(path, "mqtt.url", { set: "mqtts://broker.example:8883" }, { dryRun: true })
        expect(report).toMatchObject({ dryRun: true, changed: true, changes: ["broker: url"] })
        expect(report.next.map((step) => step.command)).toEqual([
          `ot-gateway config set mqtt.url mqtts://broker.example:8883 --config=${path}`
        ])
        expect(yield* fs.readFileString(path)).toBe(text)
      })
    )
  )

  it.effect("refuses what the schema refuses, each issue with its path, and writes nothing", () =>
    run(
      Effect.gen(function* () {
        const { fs, path } = yield* folder
        const refused = yield* Effect.flip(
          setConfigValue(path, "devices.heat-pump.pollIntervalMs", { set: "fast" }, write)
        )
        expect(refused).toMatchObject({
          _tag: "ConfigEditFailed",
          code: "invalid-config",
          issues: [{ path: "devices.0.pollIntervalMs" }]
        })
        const unknown = yield* Effect.flip(setConfigValue(path, "mqtt.nope", { set: "1" }, write))
        expect(unknown).toMatchObject({ code: "invalid-config" })
        expect(yield* fs.readFileString(path)).toBe(text)
        expect(yield* fs.exists(`${path}.bak`)).toBe(false)
      })
    )
  )

  it.effect("never makes a point writable, sets limits, or moves a writable point to another topic", () =>
    run(
      Effect.gen(function* () {
        const { fs, path } = yield* folder
        for (const [key, value] of [
          ["devices.meter.points.power.writable", "true"],
          ["devices.heat-pump.points.setpoint.limits", '{"min": 0, "max": 90}'],
          [
            "devices.heat-pump.points.setpoint",
            '{"id":"setpoint","name":"S","table":"holding","address":10,"dataType":"int16","writable":true,"limits":{"min":0,"max":1}}'
          ],
          ["devices.heat-pump.id", "hp"],
          ["devices.heat-pump.host", "10.0.0.99"],
          ["devices.heat-pump.points.enable.address", "40"]
        ] as const) {
          const refused = yield* Effect.flip(setConfigValue(path, key, { set: value }, write))
          expect(["writes-not-here", "invalid-config"]).toContain("code" in refused ? refused.code : key)
        }
        const limits = yield* Effect.flip(
          setConfigValue(path, "devices.heat-pump.points.setpoint.limits", { set: '{"min": 0, "max": 90}' }, write)
        )
        expect(limits).toMatchObject({ code: "writes-not-here" })
        expect(limits).toHaveProperty("hint", expect.stringContaining("points allow-commands"))
        expect(yield* fs.readFileString(path)).toBe(text)
        // Less may always be written.
        const off = yield* setConfigValue(path, "devices.heat-pump.points.enable.writable", { unset: true }, write)
        expect(off.changes).toContain("writes turned off: heat-pump/enable")
        // And then the device takes another id.
        const renamed = yield* setConfigValue(path, "devices.heat-pump.id", { set: "hp" }, write)
        expect(renamed).toMatchObject({ before: "heat-pump", after: "hp", effective: "hp", changed: true })
      })
    )
  )
})

describe("config get", () => {
  it.effect("gives a key as the file has it and as the gateway runs with it", () =>
    run(
      Effect.gen(function* () {
        const { path } = yield* folder
        expect(yield* getConfigValue(path, "mqtt.url")).toMatchObject({
          set: true,
          value: "mqtt://localhost:1883",
          effective: "mqtt://localhost:1883"
        })
        const byDefault = yield* getConfigValue(path, "devices.meter.pollIntervalMs")
        expect(byDefault).toMatchObject({ set: false, value: null, effective: 5000 })
        expect(formatConfigGet(byDefault)).toContain("5000   (the default")
        expect((yield* getConfigValue(path, "")).value).toEqual(base)
        expect(yield* Effect.flip(getConfigValue(path, "mqtt.nope"))).toMatchObject({ code: "unknown-key" })
      })
    )
  )
})

describe("config remove", () => {
  it.effect("takes a point or a device out, and names what the config has when it is not there", () =>
    run(
      Effect.gen(function* () {
        const { fs, path } = yield* folder
        const point = yield* removeFromConfig(path, "heat-pump/setpoint", write)
        expect(point).toMatchObject({ key: "heat-pump/setpoint", after: null, removed: true, changed: true })
        expect(formatConfigChange(point)).toContain("heat-pump/setpoint was taken out")
        const device = yield* removeFromConfig(path, "meter", { dryRun: true })
        expect(device).toMatchObject({ dryRun: true, changes: ["device meter removed"] })
        expect(device.next.map((step) => step.command)).toEqual([`ot-gateway config remove meter --config=${path}`])
        const saved = yield* parseConfig(yield* fs.readFileString(path))
        expect(saved.devices.map((each) => [each.id, each.points.map((p) => p.id)])).toEqual([
          ["heat-pump", ["enable"]],
          ["meter", ["power"]]
        ])
        expect(yield* Effect.flip(removeFromConfig(path, "heat-pump/nope", write))).toMatchObject({
          code: "unknown-key",
          hint: "it has enable"
        })
        expect(yield* Effect.flip(removeFromConfig(path, "nope", write))).toMatchObject({
          code: "unknown-key",
          hint: "it has heat-pump, meter"
        })
        // A device keeps at least one point: remove the device instead.
        expect(yield* Effect.flip(removeFromConfig(path, "meter/power", write))).toMatchObject({
          code: "invalid-config"
        })
      })
    )
  )
})

describe("config undo", () => {
  it.effect("puts the previous config back, and the change again when asked twice", () =>
    run(
      Effect.gen(function* () {
        const { fs, path } = yield* folder
        expect(yield* Effect.flip(undoConfig(path, write))).toMatchObject({ code: "no-backup" })
        yield* setConfigValue(path, "site", { set: "other" }, write)
        const changed = yield* fs.readFileString(path)
        const dry = yield* undoConfig(path, { dryRun: true })
        expect(dry).toMatchObject({ changed: true, changes: ["gateway: site"] })
        expect(yield* fs.readFileString(path)).toBe(changed)
        const undone = yield* undoConfig(path, write)
        expect(undone).toMatchObject({ changed: true, restored: `${path}.bak`, backup: `${path}.bak` })
        expect(yield* fs.readFileString(path)).toBe(text)
        yield* undoConfig(path, write)
        expect(yield* fs.readFileString(path)).toBe(changed)

        // A config broken by hand is the one that needs it most.
        yield* fs.writeFileString(path, "{ not json")
        const repaired = yield* undoConfig(path, write)
        expect(repaired).toMatchObject({ changed: true, changes: [`${path} is not a valid config now`] })
        expect(yield* fs.readFileString(path)).toBe(text)
      })
    )
  )
})
