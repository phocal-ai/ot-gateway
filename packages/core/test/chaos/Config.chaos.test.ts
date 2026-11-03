/**
 * Configs that used to be accepted although they could only go wrong at run
 * time, kept as regression tests. Each must now fail decoding with a message
 * that says what is wrong.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { parseConfig } from "../../src/index.ts"

const config = (devices: ReadonlyArray<unknown>, extra: object = {}) =>
  JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://x" }, devices, ...extra })

const modbusDevice = (id: string, points: ReadonlyArray<unknown>, extra: object = {}) => ({
  protocol: "modbus-tcp",
  id,
  host: "127.0.0.1",
  points,
  ...extra
})

const modbusPoint = (id: string, extra: object = {}) => ({
  id,
  name: id,
  table: "holding",
  address: 0,
  dataType: "uint16",
  ...extra
})

/** The decoding error message, or `accepted`. */
const rejection = (json: string) =>
  parseConfig(json).pipe(
    Effect.match({ onSuccess: () => "accepted", onFailure: (error) => error.message }),
    Effect.runSync
  )

describe("chaos: config", () => {
  it("rejects duplicate device ids, naming the id", () => {
    const message = rejection(config([modbusDevice("a", [modbusPoint("p")]), modbusDevice("a", [modbusPoint("q")])]))
    expect(message).toContain('duplicate device id "a"')
    expect(message).toContain('["devices"][1]["id"]')
  })

  it("rejects duplicate point ids within a device, naming the id", () => {
    const message = rejection(config([modbusDevice("a", [modbusPoint("p"), modbusPoint("p", { address: 1 })])]))
    expect(message).toContain('duplicate point id "p"')
    expect(message).toContain('["devices"][0]["points"][1]["id"]')
    // The same point id on two devices is fine: the topics differ.
    expect(rejection(config([modbusDevice("a", [modbusPoint("p")]), modbusDevice("b", [modbusPoint("p")])]))).toBe(
      "accepted"
    )
  })

  it("rejects unknown keys instead of ignoring a typo", () => {
    expect(rejection(config([modbusDevice("a", [modbusPoint("p")], { pollIntervalMS: 100 })]))).toContain(
      '["devices"][0]["pollIntervalMS"]'
    )
    expect(rejection(config([modbusDevice("a", [modbusPoint("p", { scale: 10 })])]))).toContain(
      '["devices"][0]["points"][0]["scale"]'
    )
    expect(rejection(config([], { buffr: { path: "x" } }))).toContain('["buffr"]')
  })

  it("rejects values that cannot work", () => {
    const cases = {
      emptyHost: config([modbusDevice("a", [modbusPoint("p")], { host: "" })]),
      noPoints: config([modbusDevice("a", [])]),
      negativeDeadband: config([modbusDevice("a", [modbusPoint("p", { deadband: -1 })])]),
      zeroFactor: config([modbusDevice("a", [modbusPoint("p", { scaling: { factor: 0 } })])]),
      wildcardId: config([modbusDevice("a+", [modbusPoint("p")])]),
      unicodeId: config([modbusDevice("ä", [modbusPoint("p")])]),
      emptyBrokerUrl: JSON.stringify({ site: "s", building: "b", mqtt: { url: "" }, devices: [] }),
      pollIntervalZero: config([modbusDevice("a", [modbusPoint("p")], { pollIntervalMs: 0 })])
    }
    for (const [name, json] of Object.entries(cases)) expect([name, rejection(json)]).not.toEqual([name, "accepted"])
  })

  it("bounds ids, so the will topic and every point topic can be encoded", () => {
    expect(rejection(config([modbusDevice("a".repeat(65), [modbusPoint("p")])]))).not.toBe("accepted")
    expect(rejection(config([modbusDevice("a".repeat(64), [modbusPoint("p")])]))).toBe("accepted")
    expect(
      rejection(JSON.stringify({ site: "s".repeat(70_000), building: "b", mqtt: { url: "mqtt://x" }, devices: [] }))
    ).not.toBe("accepted")
    expect(
      rejection(
        JSON.stringify({
          site: "s",
          building: "b",
          mqtt: { url: "mqtt://x", clientId: "c".repeat(70_000) },
          devices: []
        })
      )
    ).not.toBe("accepted")
  })

  it("says where a JSON syntax error is", () => {
    const message = rejection('{"site": "s",\n "building": "b" "mqtt": {}}')
    expect(message).toMatch(/invalid JSON: .*position \d+/)
  })

  it("parses a 2,000-device × 100-point config in reasonable time", () => {
    const devices = Array.from({ length: 2_000 }, (_, device) =>
      modbusDevice(
        `d${device}`,
        Array.from({ length: 100 }, (_unused, point) =>
          modbusPoint(`p${point}`, { address: point * 2, dataType: "float32" })
        )
      )
    )
    const started = performance.now()
    expect(Exit.isSuccess(Effect.runSyncExit(parseConfig(config(devices))))).toBe(true)
    // About 0.3 s on a laptop. The bound only catches quadratic work (duplicate checks over
    // 200,000 points), with room for a loaded CI runner.
    expect(performance.now() - started).toBeLessThan(30_000)
  }, 60_000)
})
