/**
 * The MQTT contract (`src/Contract.ts`) describes what the gateway really sends: the payload builders' output
 * decodes strictly (no field without a schema), their TypeScript types fit the schemas, and the JSON Schemas
 * checked in under `docs/mqtt-contract/` are the ones the schemas generate. The simulation
 * (`apps/gateway/test/sim/Invariants.ts`) checks every message of a whole run the same way.
 */
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type AggregateMessage,
  type AggregateValuePayload,
  type AnyPoint,
  closeWindow,
  type CommandOutcome,
  type CommandResultPayload,
  contractJsonSchemas,
  contractMessageOf,
  type ContractMessage,
  contractSchemaDirectory,
  decodeContractMessage,
  type Driver,
  makeHealthRegistry,
  makeMemoryPublisher,
  offlinePayload,
  type OfflineHealthPayload,
  type OfflineMessage,
  onlinePayload,
  type OnlineHealthPayload,
  type OnlineMessage,
  openWindow,
  addReading,
  runDevice,
  type SampleValuePayload,
  type ValueMessage
} from "../src/index.ts"

const valid = (message: ContractMessage, payload: string) => Exit.isSuccess(decodeContractMessage(message, payload))

describe("MQTT contract", () => {
  it("fits the types the gateway builds its payloads from", () => {
    expectTypeOf<ValueMessage>().toExtend<SampleValuePayload>()
    expectTypeOf<AggregateMessage>().toExtend<AggregateValuePayload>()
    expectTypeOf<OnlineMessage>().toExtend<OnlineHealthPayload>()
    expectTypeOf<OfflineMessage>().toExtend<OfflineHealthPayload>()
    expectTypeOf<CommandOutcome & { readonly ts: number }>().toExtend<CommandResultPayload>()
  })

  it("names the message of every topic", () => {
    expect(contractMessageOf("s/b/meter/power")).toBe("value")
    expect(contractMessageOf("s/b/meter/power/$meta")).toBe("meta")
    expect(contractMessageOf("s/b/$gateway/gw-1/health")).toBe("health")
    expect(contractMessageOf("s/b/meter/power/$set")).toBe("command")
    expect(contractMessageOf("s/b/meter/power/$set/result")).toBe("command-result")
    expect(contractMessageOf("s/b/$gateway/gw-1/check/abc")).toBeUndefined()
    expect(contractMessageOf("s/b/$gateway/gw-1")).toBeUndefined()
    expect(contractMessageOf("other/topic")).toBeUndefined()
  })

  it.effect("covers a point's metadata and values as the pipeline publishes them", () =>
    Effect.gen(function* () {
      const point: AnyPoint = {
        id: "trip",
        name: "Trip",
        unit: "unit:UNITLESS",
        writable: true,
        limits: { min: 0, max: 1 },
        publish: { mode: "change", deadband: 0, maxSilenceMs: 60_000 },
        semantics: { brick: "Alarm", haystack: ["alarm"] },
        alarmWhen: "on"
      }
      const driver: Driver = {
        deviceId: "pump",
        points: [point],
        readAll: Effect.succeed([{ pointId: point.id, value: 1, timestamp: 1_700_000_000_000 }]),
        write: () => Effect.void
      }
      const { messages, layer } = yield* makeMemoryPublisher
      const fiber = yield* runDevice(
        { site: "s", building: "b", pollIntervalMs: 1000, covPoints: ["trip"], gateway: "gw-1" },
        driver
      ).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust("1 millis")
      yield* Fiber.interrupt(fiber)
      expect(messages.map((message) => message.topic)).toEqual(["s/b/pump/trip/$meta", "s/b/pump/trip"])
      const offContract = messages.filter((message) => {
        const kind = contractMessageOf(message.topic)
        return kind === undefined || !valid(kind, message.payload)
      })
      expect(offContract).toEqual([])
    })
  )

  it("covers aggregate windows, numeric, boolean and partial", () => {
    const numeric = closeWindow(addReading(openWindow(0), 21.5, 0, 1_000), 60_000, 60_000, 60_000, "unit:DEG_C")
    const binary = closeWindow(
      addReading(openWindow(0, false), true, 30_000, 31_000),
      60_000,
      60_000,
      60_000,
      undefined
    )
    expect(numeric.message?.partial).toBe(true)
    for (const { message } of [numeric, binary]) {
      expect(valid("value", JSON.stringify(message))).toBe(true)
    }
  })

  it("covers health, online and offline", () => {
    const registry = makeHealthRegistry(["meter", "ahu"])
    registry.recordSuccess("meter", 1_000)
    registry.recordFailure("ahu", { reason: "timeout", message: "no answer", at: 2_000 })
    const host = { memoryBytes: 80e6, eventLoopLagMs: 3, clockSteps: 0, throttled: [], diskFreeBytes: 1e9 }
    expect(valid("health", onlinePayload(registry, 0, 3_000, host))).toBe(true)
    expect(valid("health", offlinePayload("connection-lost"))).toBe(true)
  })

  it("refuses what the gateway must not send", () => {
    // A field without a schema: CI fails before a consumer sees it.
    expect(valid("value", JSON.stringify({ value: 1, ts: 0, quality: "good" }))).toBe(false)
    expect(valid("value", JSON.stringify({ value: "1", ts: 0 }))).toBe(false)
    expect(valid("health", JSON.stringify({ status: "offline", reason: "tired" }))).toBe(false)
    expect(valid("command-result", JSON.stringify({ status: "rejected", reason: "busy", message: "", ts: 0 }))).toBe(
      false
    )
    // A cleared point: an empty retained $meta.
    expect(valid("meta", "")).toBe(true)
  })

  it("takes a command only as the guard does: exactly {value}", () => {
    expect(valid("command", JSON.stringify({ value: 21 }))).toBe(true)
    expect(valid("command", JSON.stringify({ value: null }))).toBe(true)
    expect(valid("command", JSON.stringify({ value: 21, priority: 8 }))).toBe(false)
    expect(contractJsonSchemas().command["additionalProperties"]).toBe(false)
    expect(contractJsonSchemas().meta["additionalProperties"]).toBe(true)
  })

  it("publishes reasons open, so a minor version can add one, and keeps them closed for the gateway", () => {
    const failed = { status: "failed", reason: "busy", message: "", ts: 0 }
    expect(valid("command-result", JSON.stringify(failed))).toBe(false)
    expect(JSON.stringify(contractJsonSchemas()["command-result"])).not.toMatch(/"enum":\["timeout"/)
  })

  it("matches the JSON Schemas checked in (pnpm --filter @ot-gateway/core contract:write)", () => {
    const directory = join(import.meta.dirname, "..", "..", "..", contractSchemaDirectory)
    for (const [message, schema] of Object.entries(contractJsonSchemas())) {
      const file = JSON.parse(readFileSync(join(directory, `${message}.schema.json`), "utf8"))
      expect(file, `${message}.schema.json`).toEqual(schema)
    }
  })
})
