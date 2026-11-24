/**
 * Another gateway publishing into this one's topics: one online in the building with a device of the same id, or a
 * copy with the same gateway id. Gateways that share a building with different devices are no conflict.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { makeMemoryNetwork, parseConfig } from "@ot-gateway/core"
import { makeBrokerControl, serveMqtt } from "@ot-gateway/mqtt"
import { Effect, Fiber, Logger } from "effect"
import { TestClock } from "effect/testing"
import { runGateway } from "../src/Gateway.ts"
import { healthSubscription, makeOtherGatewaysCheck, overlapMessage, overlapOf } from "../src/OtherGateways.ts"

const config = { id: "main", site: "s", building: "b", devices: [{ id: "meter" }, { id: "ahu" }] } as const
const startedAt = 1_000

const health = (gateway: string, payload: object, retain = true) => ({
  topic: `s/b/$gateway/${gateway}/health`,
  payload: JSON.stringify(payload),
  retain
})
const online = (devices: ReadonlyArray<string>, since = 500) => ({
  status: "online",
  since,
  ts: 600,
  devices: Object.fromEntries(devices.map((device) => [device, { status: "ok" }]))
})

describe("overlapOf", () => {
  it("names another online gateway that runs devices of the same ids", () => {
    expect(overlapOf(config, startedAt, health("roof", online(["meter", "pump"])))).toEqual({
      gateway: "roof",
      devices: ["meter"],
      sameId: false
    })
  })

  it("leaves gateways with other devices, offline ones, other buildings and unreadable health alone", () => {
    expect(overlapOf(config, startedAt, health("roof", online(["pump"])))).toBeUndefined()
    expect(overlapOf(config, startedAt, health("roof", { status: "offline", reason: "shutdown" }))).toBeUndefined()
    expect(
      overlapOf(config, startedAt, { ...health("roof", online(["meter"])), topic: "s/other/$gateway/roof/health" })
    ).toBeUndefined()
    expect(overlapOf(config, startedAt, { ...health("roof", {}), payload: "not json" })).toBeUndefined()
  })

  it("names a copy with this gateway's id by its live health, never by this run's or a retained one", () => {
    expect(overlapOf(config, startedAt, health("main", online(["meter"]), false))).toEqual({
      gateway: "main",
      devices: [],
      sameId: true
    })
    expect(overlapOf(config, startedAt, health("main", online(["meter"], startedAt), false))).toBeUndefined()
    expect(overlapOf(config, startedAt, health("main", online(["meter"]), true))).toBeUndefined()
  })

  it("subscribes to the building's gateways' health without its own messages", () => {
    expect(healthSubscription(config)).toEqual({ filter: "s/b/$gateway/+/health", qos: 0, noLocal: true })
  })

  it("says what to do", () => {
    expect(overlapMessage(config, { gateway: "roof", devices: ["meter"], sameId: false })).toContain(
      'another gateway, "roof", is online in s/b with the same device ids (meter)'
    )
    expect(overlapMessage(config, { gateway: "main", devices: [], sameId: true })).toContain('"mqtt.clientId"')
  })
})

describe("makeOtherGatewaysCheck", () => {
  it.effect("tells about each other gateway once per run", () =>
    Effect.gen(function* () {
      const told: Array<string> = []
      const check = makeOtherGatewaysCheck(config, startedAt, (overlap) => told.push(overlap.gateway))
      yield* check.onMessage({ ...health("roof", online(["meter"])) })
      yield* check.onMessage({ ...health("roof", online(["meter"]), false) })
      yield* check.onMessage({ ...health("cellar", online(["ahu"])) })
      expect(told).toEqual(["roof", "cellar"])
    })
  )
})

describe("the gateway and other gateways", () => {
  it.effect("warns on start when another gateway online in the building has a device of the same id", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      const control = makeBrokerControl()
      const topic = "s/b/$gateway/roof/health"
      control.retainedMessages.set(topic, {
        clientId: "roof",
        topic,
        payload: JSON.stringify(online(["meter"])),
        qos: 0,
        retain: true
      })
      const server = yield* network.listen("10.0.0.2", 1883)
      yield* serveMqtt(server, control).pipe(Effect.forkScoped)
      const gateway = yield* parseConfig(
        JSON.stringify({
          site: "s",
          building: "b",
          mqtt: { url: "mqtt://10.0.0.2:1883" },
          devices: [
            {
              protocol: "simulator",
              id: "meter",
              points: [{ id: "power", name: "Power", waveform: "sine", min: 0, max: 10, periodSeconds: 60 }]
            }
          ]
        })
      )
      const warnings: Array<string> = []
      const logger = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push((Array.isArray(message) ? message : [message]).join(" "))
        })
      ])
      const running = yield* runGateway(gateway, { network: network.host("10.0.0.1") }).pipe(
        Effect.provide(logger),
        Effect.forkScoped
      )
      for (let step = 0; step < 20; step++) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))
        yield* TestClock.adjust("500 millis")
      }
      expect(warnings.filter((line) => line.includes('another gateway, "roof"'))).toHaveLength(1)
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
