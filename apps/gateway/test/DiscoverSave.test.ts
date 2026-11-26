/**
 * What interactive `discover` saves: picked devices merged into the config file, new ones after its devices, new
 * points after a device it has, every other key kept, and the network they were found on when the file sets none.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem } from "effect"
import { diffConfigs, formatDiff, sideOfConfig } from "../src/Diff.ts"
import { mergeDevices, mergeDiscovered, saveDiscovered } from "../src/DiscoverSave.ts"
import type { DraftedDevice } from "../src/Init.ts"

const base = {
  site: "plant-3",
  building: "main",
  mqtt: { url: "mqtt://localhost:1883" },
  status: { port: 8091 },
  devices: [
    {
      protocol: "bacnet-ip",
      id: "demo-room",
      deviceInstance: 1001,
      address: "192.168.0.171",
      points: [{ id: "room-temperature", name: "Room temperature", objectType: "analog-input", instance: 1 }]
    }
  ]
}

const newPoint: DraftedDevice = {
  protocol: "bacnet-ip",
  id: "demo-room",
  deviceInstance: 1001,
  address: "192.168.0.171",
  points: [
    {
      id: "temperature-setpoint",
      name: "Temperature setpoint",
      unit: "unit:DEG_C",
      objectType: "analog-value",
      instance: 1
    }
  ]
}

const newDevice: DraftedDevice = {
  protocol: "bacnet-ip",
  id: "ahu-1",
  deviceInstance: 2001,
  points: [{ id: "supply-temp", name: "Supply temp", objectType: "analog-input", instance: 1 }]
}

describe("mergeDevices", () => {
  it.effect("adds new points to a device the config has, new devices after it, and keeps every other key", () =>
    Effect.gen(function* () {
      const merged = mergeDevices(base, [newPoint, newDevice], "192.168.0.255")
      expect(merged.added).toEqual(["ahu-1"])
      expect(merged.extended).toEqual(["demo-room"])
      const config = yield* parseConfig(merged.text)
      expect(config.status?.port).toBe(8091)
      expect(config.bacnet.broadcastAddress).toBe("192.168.0.255")
      expect(config.devices.map((device) => [device.id, device.points.map((point) => point.id)])).toEqual([
        ["demo-room", ["room-temperature", "temperature-setpoint"]],
        ["ahu-1", ["supply-temp"]]
      ])
    })
  )

  it("adds a device that only shares an id under an id of its own, never into the other", () => {
    const elsewhere: DraftedDevice = { ...newPoint, deviceInstance: 1002, address: "192.168.0.172" }
    const merged = mergeDevices(base, [elsewhere])
    expect(merged.added).toEqual(["demo-room-2"])
    expect(merged.extended).toEqual([])
    expect(JSON.parse(merged.text).devices[0].points).toHaveLength(1)
  })

  it("replaces the limited broadcast with the network the devices were found on", () => {
    const limited = { ...base, bacnet: { broadcastAddress: "255.255.255.255" } }
    expect(JSON.parse(mergeDevices(limited, [newDevice], "192.168.0.255").text).bacnet).toEqual({
      broadcastAddress: "192.168.0.255"
    })
  })

  it("keeps the network the file sets, and sets none when not asked to", () => {
    const set = { ...base, bacnet: { broadcastAddress: "10.0.0.255", port: 47809 } }
    expect(JSON.parse(mergeDevices(set, [newDevice], "192.168.0.255").text).bacnet).toEqual(set.bacnet)
    expect(JSON.parse(mergeDevices(base, [newDevice]).text)).not.toHaveProperty("bacnet")
  })
})

describe("saveDiscovered", () => {
  it.effect("writes the merged config, and refuses what would not decode without touching the file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      const path = `${folder}/ot-gateway.json`
      yield* fs.writeFileString(path, `${JSON.stringify(base, null, 2)}\n`)
      yield* saveDiscovered(path, yield* fs.readFileString(path), [newDevice])
      const saved = yield* parseConfig(yield* fs.readFileString(path))
      expect(saved.devices.map((device) => device.id)).toEqual(["demo-room", "ahu-1"])

      // A point id the device has already would make the config invalid: refused, the file as it was.
      const before = yield* fs.readFileString(path)
      const duplicate: DraftedDevice = {
        ...newPoint,
        points: [{ id: "room-temperature", name: "Room temperature", objectType: "analog-value", instance: 9 }]
      }
      const refused = yield* saveDiscovered(path, before, [duplicate]).pipe(Effect.flip)
      expect(refused.message).toContain("nothing was saved")
      expect(yield* fs.readFileString(path)).toBe(before)

      // Changed while discover asked (the status page saved it): refused, not merged into.
      const asRead = yield* fs.readFileString(path)
      yield* fs.writeFileString(path, asRead.replace('"main"', '"north"'))
      const another: DraftedDevice = { ...newDevice, id: "ahu-2", deviceInstance: 2002 }
      const conflict = yield* saveDiscovered(path, asRead, [another]).pipe(Effect.flip)
      expect(conflict.message).toContain("changed while discover ran")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("mergeDiscovered", () => {
  it.effect("decodes the file as it was and as it would be, so their diff is only what discover adds", () =>
    Effect.gen(function* () {
      const fileText = JSON.stringify(base)
      const merged = yield* mergeDiscovered("ot-gateway.json", fileText, [newPoint])
      const diff = diffConfigs(sideOfConfig(merged.before), sideOfConfig(merged.config))
      expect(diff.added.map((each) => each.topic)).toEqual(["plant-3/main/demo-room/temperature-setpoint"])
      expect(diff.settings).toEqual([])
      expect(formatDiff(diff, "What saving changes on the broker:", { command: "ot-gateway" }).split("\n")).toEqual([
        "What saving changes on the broker:",
        "  + plant-3/main/demo-room/temperature-setpoint  new topic",
        "1 new"
      ])
    })
  )
})
