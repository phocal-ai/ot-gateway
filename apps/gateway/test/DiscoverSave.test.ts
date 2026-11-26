/**
 * What interactive `discover` saves: picked devices merged into the config file, new ones after its devices, new
 * points after a device it has, every other key kept, and the network they were found on when the file sets none.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem } from "effect"
import { mergeDevices, saveDiscovered } from "../src/DiscoverSave.ts"
import type { PickedDevice } from "../src/Init.ts"

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

const newPoint: PickedDevice = {
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
      instance: 1,
      writable: true,
      limits: { min: 15, max: 30 }
    }
  ]
}

const newDevice: PickedDevice = {
  protocol: "bacnet-ip",
  id: "ahu-1",
  deviceInstance: 2001,
  pollIntervalMs: 2000,
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
      expect(config.devices[1]?.pollIntervalMs).toBe(2000)
    })
  )

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
      yield* saveDiscovered(path, [newDevice])
      const saved = yield* parseConfig(yield* fs.readFileString(path))
      expect(saved.devices.map((device) => device.id)).toEqual(["demo-room", "ahu-1"])

      // A point id the device has already would make the config invalid: refused, the file as it was.
      const before = yield* fs.readFileString(path)
      const duplicate: PickedDevice = {
        ...newPoint,
        points: [{ id: "room-temperature", name: "Room temperature", objectType: "analog-value", instance: 9 }]
      }
      const refused = yield* saveDiscovered(path, [duplicate]).pipe(Effect.flip)
      expect(refused.message).toContain("nothing was saved")
      expect(yield* fs.readFileString(path)).toBe(before)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
