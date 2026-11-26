/**
 * `diff`: what a config change does on the broker. Topics that appear, go silent or move (renames found by their
 * source), points that start taking commands, $meta that changes, and the retained messages nobody clears.
 */
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { Effect } from "effect"
import { clearCommand, clearCommands, diffConfigs, formatDiff, sideOfConfig } from "../src/Diff.ts"

const meter = {
  protocol: "modbus-tcp",
  id: "meter",
  host: "10.0.1.20",
  points: [
    { id: "power", name: "Power", unit: "unit:KiloW", table: "holding", address: 40, dataType: "float32" },
    { id: "energy", name: "Energy", unit: "unit:KiloW-HR", table: "input", address: 0, dataType: "uint32" }
  ]
}
const ahu = {
  protocol: "bacnet-ip",
  id: "ahu",
  deviceInstance: 2001,
  address: "10.0.1.30",
  points: [{ id: "setpoint", name: "Setpoint", objectType: "analog-value", instance: 1 }]
}

const side = (devices: ReadonlyArray<unknown>, gateway: { site?: string; id?: string; url?: string } = {}) =>
  parseConfig(
    JSON.stringify({
      site: gateway.site ?? "s",
      building: "b",
      ...(gateway.id === undefined ? {} : { id: gateway.id }),
      mqtt: { url: gateway.url ?? "mqtt://broker" },
      devices
    })
  ).pipe(Effect.map(sideOfConfig))

describe("diffConfigs", () => {
  it.effect("finds nothing between a config and itself", () =>
    Effect.gen(function* () {
      const before = yield* side([meter, ahu])
      const diff = diffConfigs(before, before)
      expect(diff.changed).toBe(false)
      expect(formatDiff(diff, "a against a", { command: "ot-gateway" })).toContain("✓ nothing changes on the broker")
    })
  )

  it.effect("names new and silent topics, and whose $meta the gateway clears itself", () =>
    Effect.gen(function* () {
      const before = yield* side([meter, ahu])
      const after = yield* side([
        { ...meter, points: [meter.points[0], { ...meter.points[1], id: "import", address: 2 }] }
      ])
      const diff = diffConfigs(before, after)
      expect(diff.added).toEqual([{ topic: "s/b/meter/import", device: "meter", point: "import", writable: false }])
      expect(diff.removed).toEqual([
        { topic: "s/b/meter/energy", device: "meter", point: "energy", metaCleared: true },
        { topic: "s/b/ahu/setpoint", device: "ahu", point: "setpoint", metaCleared: false }
      ])
      // The device that left takes its $meta with nobody to clear it.
      expect(diff.stale).toEqual(["s/b/ahu/setpoint/$meta"])
    })
  )

  it.effect("finds a renamed point and a renamed device by their sources", () =>
    Effect.gen(function* () {
      const before = yield* side([meter, ahu])
      const after = yield* side([
        { ...meter, points: [{ ...meter.points[0], id: "active-power" }, meter.points[1]] },
        { ...ahu, id: "ahu-1" }
      ])
      const diff = diffConfigs(before, after)
      expect(diff.added).toEqual([])
      expect(diff.removed).toEqual([])
      expect(diff.moved).toEqual([
        { from: "s/b/meter/power", to: "s/b/meter/active-power", reason: "point", metaCleared: true },
        { from: "s/b/ahu/setpoint", to: "s/b/ahu-1/setpoint", reason: "device", metaCleared: false }
      ])
      expect(diff.stale).toEqual(["s/b/ahu/setpoint/$meta"])
    })
  )

  it.effect("moves every topic and the health topic when the site or the gateway's id changes", () =>
    Effect.gen(function* () {
      const before = yield* side([ahu])
      const after = yield* side([ahu], { site: "t", id: "edge" })
      const diff = diffConfigs(before, after)
      expect(diff.moved).toEqual([
        { from: "s/b/ahu/setpoint", to: "t/b/ahu/setpoint", reason: "site", metaCleared: false }
      ])
      expect(diff.health).toEqual({ from: "s/b/$gateway/main/health", to: "t/b/$gateway/edge/health" })
      expect(diff.stale).toEqual(["s/b/ahu/setpoint/$meta", "s/b/$gateway/main/health"])
      expect(diff.settings).toEqual([])
    })
  )

  it.effect("says the site moved a point renamed in the same edit", () =>
    Effect.gen(function* () {
      const before = yield* side([ahu])
      const after = yield* side([{ ...ahu, points: [{ ...ahu.points[0], id: "sp" }] }], { site: "t" })
      expect(diffConfigs(before, after).moved).toEqual([
        { from: "s/b/ahu/setpoint", to: "t/b/ahu/sp", reason: "site", metaCleared: false }
      ])
    })
  )

  it.effect("names points that take commands now, limits that change and writes turned off", () =>
    Effect.gen(function* () {
      const writable = { ...ahu.points[0], writable: true, limits: { min: 15, max: 25 } }
      const before = yield* side([{ ...ahu, points: [writable, { ...writable, id: "other", instance: 2 }] }])
      const after = yield* side([
        {
          ...ahu,
          points: [
            { ...writable, limits: { min: 15, max: 30 } },
            { ...ahu.points[0], id: "other", instance: 2 },
            { ...writable, id: "new", instance: 3 }
          ]
        }
      ])
      expect(diffConfigs(before, after).writable).toEqual([
        { topic: "s/b/ahu/setpoint", change: "limits changed", limits: { min: 15, max: 30 } },
        { topic: "s/b/ahu/other", change: "no longer writable" },
        { topic: "s/b/ahu/new", change: "now writable", limits: { min: 15, max: 25 } }
      ])
    })
  )

  it.effect("names $meta fields and settings that change, never a setting's value", () =>
    Effect.gen(function* () {
      const before = yield* side([meter])
      const after = yield* side(
        [{ ...meter, host: "10.0.1.21", points: [{ ...meter.points[0], unit: "unit:W" }, meter.points[1]] }],
        { url: "mqtt://other" }
      )
      const diff = diffConfigs(before, after)
      expect(diff.meta).toEqual([{ topic: "s/b/meter/power", fields: ["unit"] }])
      expect(diff.settings).toEqual(["mqtt: url", "device meter: host"])
      const text = formatDiff(diff, "new against old", { command: "ot-gateway" })
      expect(text).toContain("~ s/b/meter/power  $meta: unit")
      expect(text).not.toContain("10.0.1.21")
    })
  )

  it.effect("tells a new source or scaling from a $meta change, and a new gateway id rewrites every $meta", () =>
    Effect.gen(function* () {
      const before = yield* side([meter])
      const moved = { ...meter.points[0], address: 42, scaling: { factor: 0.1 } }
      const diff = diffConfigs(before, yield* side([{ ...meter, points: [moved, meter.points[1]] }]))
      expect(diff.meta).toEqual([])
      expect(diff.values).toEqual([{ topic: "s/b/meter/power", fields: ["source", "scaling"] }])
      const renamed = diffConfigs(before, yield* side([meter], { id: "edge" }))
      expect(renamed.meta.map((each) => each.fields)).toEqual([["gateway"], ["gateway"]])
      expect(renamed.stale).toEqual(["s/b/$gateway/main/health"])
    })
  )

  it.effect("leaves everything retained on the old broker when the broker changes, cleared with the old config", () =>
    Effect.gen(function* () {
      const before = yield* side([ahu])
      const diff = diffConfigs(before, yield* side([ahu], { url: "mqtt://other" }))
      expect(diff.brokerChanged).toBe(true)
      expect(diff.stale).toEqual(["s/b/ahu/setpoint/$meta", "s/b/$gateway/main/health"])
      expect(clearCommands(diff, { command: "ot-gateway", against: "old.json" })).toEqual([
        "ot-gateway publish 's/b/ahu/setpoint/$meta' --retain --config old.json",
        "ot-gateway publish 's/b/$gateway/main/health' --retain --config old.json"
      ])
      // Against a running gateway there is no old config to name: no command that would clear the new broker.
      expect(clearCommands(diff, { command: "ot-gateway" })).toEqual([])
      expect(formatDiff(diff, "t", { command: "ot-gateway" })).toContain("stay on the old broker")
    })
  )
})

describe("clearCommand", () => {
  it("quotes the topic, and names the config when it is not the default", () => {
    expect(clearCommand("ot-gateway", "s/b/ahu/setpoint/$meta", undefined)).toBe(
      "ot-gateway publish 's/b/ahu/setpoint/$meta' --retain"
    )
    expect(clearCommand("ot-gateway", "s/b/x/$meta", "site 1/ot-gateway.json")).toBe(
      "ot-gateway publish 's/b/x/$meta' --retain --config 'site 1/ot-gateway.json'"
    )
  })
})
