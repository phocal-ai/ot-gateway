/**
 * docs/configuration.md documents every config key, and nothing else: each
 * section's table lists exactly the fields of its schema. A key added to the
 * schema without a row, or a row left behind by a removed key, fails here.
 */
import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import {
  BacnetDevice,
  BacnetPoint,
  BacnetSettings,
  BufferSettings,
  HistorySettings,
  GatewayConfig,
  Limits,
  ModbusDevice,
  ModbusPoint,
  Publish,
  MqttSettings,
  PointFields,
  Scaling,
  Semantics,
  SimulatedPoint,
  SimulatorDevice,
  StatusSettings
} from "../src/index.ts"

const reference = readFileSync(new URL("../../../docs/configuration.md", import.meta.url), "utf8")

/** The keys in the first column of each `## Section`'s table. */
const documented = new Map(
  reference
    .split(/^## /m)
    .slice(1)
    .map((section) => {
      const [title = "", ...body] = section.split("\n")
      const keys = body.flatMap((line) => {
        const key = /^\| `([^`]+)`/.exec(line)?.[1]
        return key === undefined ? [] : [key]
      })
      return [title.trim(), keys.toSorted()] as const
    })
)

const common = Object.keys(PointFields)
/** A point schema's own keys, beyond the ones every point has. */
const own = (fields: object) => Object.keys(fields).filter((key) => !common.includes(key))

const sections: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["Gateway", Object.keys(GatewayConfig.fields)],
  ["mqtt", Object.keys(MqttSettings.fields)],
  ["buffer", Object.keys(BufferSettings.fields)],
  ["history", Object.keys(HistorySettings.fields)],
  ["status", Object.keys(StatusSettings.fields)],
  ["bacnet", Object.keys(BacnetSettings.fields)],
  ["Modbus TCP devices", Object.keys(ModbusDevice.fields)],
  ["BACnet/IP devices", Object.keys(BacnetDevice.fields)],
  ["Simulated devices", Object.keys(SimulatorDevice.fields)],
  ["Points", common],
  ["Modbus points", own(ModbusPoint.fields)],
  ["BACnet points", own(BacnetPoint.fields)],
  ["Simulated points", own(SimulatedPoint.fields)],
  ["publish", [...new Set(Publish.members.flatMap((mode) => Object.keys(mode.fields)))]],
  ["limits", Object.keys(Limits.fields)],
  ["scaling", Object.keys(Scaling.fields)],
  ["semantics", Object.keys(Semantics.fields)]
]

describe("docs/configuration.md", () => {
  it.each(sections)("documents every key of %s, and only those", (section, keys) => {
    expect(documented.get(section)).toEqual(keys.toSorted())
  })

  it("has no section without a schema", () => {
    expect([...documented.keys()].toSorted()).toEqual(sections.map(([section]) => section).toSorted())
  })
})
