/**
 * `points allow-commands` and `points read-only`: one point of the config file takes commands or none, a number
 * only with limits, every other key kept, and nothing written when the gateway's schema refuses the result.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem, type Scope } from "effect"
import { formatPointCommands, setPointCommands, withPointCommands } from "../src/PointCommands.ts"

const devices = [
  {
    protocol: "modbus-tcp",
    id: "heat-pump",
    host: "10.0.0.5",
    points: [
      { id: "setpoint", name: "Room setpoint", unit: "unit:DEG_C", table: "holding", address: 10, dataType: "int16" },
      { id: "enable", name: "Enable", table: "coil", address: 1, dataType: "bool" },
      { id: "power", name: "Power", table: "input", address: 2, dataType: "uint16" }
    ]
  },
  {
    protocol: "bacnet-ip",
    id: "ahu",
    deviceInstance: 2001,
    points: [{ id: "sp", name: "Setpoint", objectType: "analog-value", instance: 1 }]
  }
]

const text = `${JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://localhost:1883" }, devices }, null, 2)}\n`

/** A folder of its own with the config in it. */
const folder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = `${yield* fs.makeTempDirectoryScoped()}/ot-gateway.json`
  yield* fs.writeFileString(path, text)
  return { fs, path }
})

const pointOf = (configText: string, device: string, point: string) =>
  Effect.map(parseConfig(configText), (config) =>
    config.devices.find((each) => each.id === device)?.points.find((each) => each.id === point)
  )

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe("withPointCommands", () => {
  it("changes one point and keeps every other key, and the keys it does not know", () => {
    const raw = {
      site: "s",
      extra: 1,
      devices: [
        { id: "a", points: [{ id: "p", name: "P", limits: { min: 0, max: 1 }, mine: true }, { id: "q" }] },
        { id: "b", points: [{ id: "p" }] }
      ]
    }
    expect(withPointCommands(raw, { device: "a", point: "p" }, { writable: true, limits: { min: 2, max: 3 } })).toEqual(
      {
        site: "s",
        extra: 1,
        devices: [
          {
            id: "a",
            points: [{ id: "p", name: "P", mine: true, writable: true, limits: { min: 2, max: 3 } }, { id: "q" }]
          },
          { id: "b", points: [{ id: "p" }] }
        ]
      }
    )
    expect(withPointCommands(raw, { device: "a", point: "p" }, { writable: false })).toEqual({
      site: "s",
      extra: 1,
      devices: [
        { id: "a", points: [{ id: "p", name: "P", mine: true }, { id: "q" }] },
        { id: "b", points: [{ id: "p" }] }
      ]
    })
  })
})

describe("setPointCommands", () => {
  it.effect("lets a number take commands within limits, keeps the previous file, and says what to run next", () =>
    run(
      Effect.gen(function* () {
        const { fs, path } = yield* folder
        const report = yield* setPointCommands(
          path,
          { device: "heat-pump", point: "setpoint" },
          { allow: true, min: 15, max: 25 },
          { dryRun: false }
        )
        expect(report).toMatchObject({
          ok: true,
          point: "heat-pump/setpoint",
          source: "holding 10 · int16 ABCD",
          topic: "s/b/heat-pump/setpoint",
          setTopic: "s/b/heat-pump/setpoint/$set",
          writable: true,
          limits: { min: 15, max: 25 },
          takes: "number",
          changed: true,
          backup: `${path}.bak`
        })
        expect(report.next.map((step) => step.command)).toEqual([
          `ot-gateway diff ${path}`,
          `ot-gateway restart ${path}`,
          `ot-gateway write heat-pump/setpoint <value> ${path}`
        ])
        expect(formatPointCommands(report)).toContain("takes commands now: a number, 15 to 25")
        const saved = yield* fs.readFileString(path)
        expect(yield* pointOf(saved, "heat-pump", "setpoint")).toMatchObject({
          writable: true,
          limits: { min: 15, max: 25 }
        })
        // No other point changed.
        expect(yield* pointOf(saved, "heat-pump", "enable")).toMatchObject({ writable: false })
        expect(yield* fs.readFileString(`${path}.bak`)).toBe(text)

        // Again without limits: the ones it has stay, and nothing is written.
        const again = yield* setPointCommands(
          path,
          { device: "heat-pump", point: "setpoint" },
          { allow: true },
          { dryRun: false }
        )
        expect(again).toMatchObject({ changed: false, limits: { min: 15, max: 25 }, next: [] })
        expect(again.backup).toBeUndefined()

        // And read-only again: both keys leave the file.
        const back = yield* setPointCommands(
          path,
          { device: "heat-pump", point: "setpoint" },
          { allow: false },
          { dryRun: false }
        )
        expect(back).toMatchObject({ writable: false, changed: true })
        expect(back.setTopic).toBeUndefined()
        expect(back.limits).toBeUndefined()
        expect(yield* fs.readFileString(path)).toBe(text)
      })
    )
  )

  it.effect("leaves a file alone whose point is as asked already, wherever its keys are written", () =>
    run(
      Effect.gen(function* () {
        const { fs, path } = yield* folder
        // By hand: writable first, a read-only point that says so.
        const byHand = text
          .replace('"id": "enable",', '"writable": true,\n          "id": "enable",')
          .replace('"id": "power",', '"writable": false,\n          "id": "power",')
        expect(byHand).not.toBe(text)
        yield* fs.writeFileString(path, byHand)
        const allowed = yield* setPointCommands(
          path,
          { device: "heat-pump", point: "enable" },
          { allow: true },
          { dryRun: false }
        )
        expect(allowed).toMatchObject({ writable: true, changed: false, next: [] })
        const readOnly = yield* setPointCommands(
          path,
          { device: "heat-pump", point: "power" },
          { allow: false },
          { dryRun: false }
        )
        expect(readOnly).toMatchObject({ writable: false, changed: false })
        expect(yield* fs.readFileString(path)).toBe(byHand)
        expect(yield* fs.exists(`${path}.bak`)).toBe(false)
      })
    )
  )

  it.effect("takes a switch without limits, and refuses limits on one", () =>
    run(
      Effect.gen(function* () {
        const { fs, path } = yield* folder
        const refused = yield* Effect.flip(
          setPointCommands(
            path,
            { device: "heat-pump", point: "enable" },
            { allow: true, min: 0, max: 1 },
            { dryRun: false }
          )
        )
        expect(refused).toMatchObject({ _tag: "ConfigEditFailed", code: "invalid-limits" })
        const report = yield* setPointCommands(
          path,
          { device: "heat-pump", point: "enable" },
          { allow: true },
          { dryRun: false }
        )
        expect(report).toMatchObject({ writable: true, takes: "binary", changed: true })
        expect(report.limits).toBeUndefined()
        expect(yield* pointOf(yield* fs.readFileString(path), "heat-pump", "enable")).toMatchObject({ writable: true })
      })
    )
  )

  it.effect("refuses a number without both limits, or with the lowest above the highest, and writes nothing", () =>
    run(
      Effect.gen(function* () {
        const { fs, path } = yield* folder
        const target = { device: "heat-pump", point: "setpoint" }
        for (const change of [{ allow: true }, { allow: true, min: 15 }, { allow: true, min: 25, max: 15 }] as const) {
          const refused = yield* Effect.flip(setPointCommands(path, target, change, { dryRun: false, command: "otg" }))
          expect(refused).toMatchObject({ _tag: "ConfigEditFailed", code: "invalid-limits" })
          expect(refused).toHaveProperty(
            "hint",
            expect.stringContaining("otg points allow-commands heat-pump/setpoint")
          )
        }
        expect(yield* fs.readFileString(path)).toBe(text)
        expect(yield* fs.exists(`${path}.bak`)).toBe(false)
      })
    )
  )

  it.effect("does not take limits left on a read-only point as the ones a command may use", () =>
    run(
      Effect.gen(function* () {
        const { fs, path } = yield* folder
        const withLimits = text.replace(
          '"dataType": "int16"',
          '"dataType": "int16",\n          "limits": { "min": 0, "max": 90 }'
        )
        expect(withLimits).not.toBe(text)
        yield* fs.writeFileString(path, withLimits)
        const refused = yield* Effect.flip(
          setPointCommands(path, { device: "heat-pump", point: "setpoint" }, { allow: true }, { dryRun: false })
        )
        expect(refused).toMatchObject({ code: "invalid-limits" })
        expect(yield* fs.readFileString(path)).toBe(withLimits)
      })
    )
  )

  it.effect("refuses what the gateway's schema refuses, each issue with its path, and writes nothing", () =>
    run(
      Effect.gen(function* () {
        const { fs, path } = yield* folder
        const input = yield* Effect.flip(
          setPointCommands(
            path,
            { device: "heat-pump", point: "power" },
            { allow: true, min: 0, max: 9 },
            { dryRun: false }
          )
        )
        expect(input).toMatchObject({
          code: "invalid-config",
          issues: [{ path: "devices.0.points.2.writable", message: "input registers are read-only" }]
        })
        // A BACnet device found by broadcast: a spoofed I-Am could redirect its writes.
        const bacnet = yield* Effect.flip(
          setPointCommands(path, { device: "ahu", point: "sp" }, { allow: true, min: 15, max: 25 }, { dryRun: false })
        )
        expect(bacnet).toMatchObject({ code: "invalid-config", issues: [{ path: "devices.1.address" }] })
        expect(yield* fs.readFileString(path)).toBe(text)
      })
    )
  )

  it.effect("names the config's devices or the device's points when the point is not there", () =>
    run(
      Effect.gen(function* () {
        const { path } = yield* folder
        const device = yield* Effect.flip(
          setPointCommands(path, { device: "nope", point: "setpoint" }, { allow: false }, { dryRun: false })
        )
        expect(device).toMatchObject({ code: "unknown-point", hint: "its devices: heat-pump, ahu" })
        const point = yield* Effect.flip(
          setPointCommands(path, { device: "heat-pump", point: "nope" }, { allow: false }, { dryRun: false })
        )
        expect(point).toMatchObject({
          code: "unknown-point",
          hint: "its points: heat-pump/setpoint, heat-pump/enable, heat-pump/power"
        })
      })
    )
  )

  it.effect("a dry run checks and reports, with the command that writes it, and leaves the file", () =>
    run(
      Effect.gen(function* () {
        const { fs, path } = yield* folder
        const report = yield* setPointCommands(
          path,
          { device: "heat-pump", point: "setpoint" },
          { allow: true, min: 15, max: 25 },
          { dryRun: true }
        )
        expect(report).toMatchObject({ dryRun: true, writable: true, changed: true })
        expect(report.next.map((step) => step.command)).toEqual([
          `ot-gateway points allow-commands heat-pump/setpoint ${path} --min=15 --max=25`
        ])
        expect(formatPointCommands(report)).toContain("would take commands")
        expect(yield* fs.readFileString(path)).toBe(text)
      })
    )
  )
})
