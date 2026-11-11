/**
 * Retained metadata of removed points: the gateway clears what it published itself for its own devices only, and
 * leaves the metadata of points it still has, of devices it does not have and of other gateways alone.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { makeMemoryNetwork, parseConfig } from "@ot-gateway/core"
import { makeBrokerControl, serveMqtt } from "@ot-gateway/mqtt"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { runGateway } from "../src/Gateway.ts"
import { metaSubscriptions, staleMeta, staleMetaTopic } from "../src/StaleMeta.ts"

const config = {
  id: "main",
  site: "s",
  building: "b",
  devices: [{ id: "meter", points: [{ id: "power" }] }]
} as const

const retained = (topic: string, payload = '{"name":"x","gateway":"main"}') => ({ topic, payload, retain: true })

describe("staleMetaTopic", () => {
  it("names the retained metadata of a point the device no longer has", () => {
    expect(staleMetaTopic(config, retained("s/b/meter/energy/$meta"))).toBe("s/b/meter/energy/$meta")
  })

  it("leaves points the config has, other devices, other buildings and live or empty messages alone", () => {
    expect(staleMetaTopic(config, retained("s/b/meter/power/$meta"))).toBeUndefined()
    expect(staleMetaTopic(config, retained("s/b/other-gateways-device/x/$meta"))).toBeUndefined()
    expect(staleMetaTopic(config, retained("s/other/meter/energy/$meta"))).toBeUndefined()
    expect(staleMetaTopic(config, retained("s/b/meter/energy"))).toBeUndefined()
    expect(staleMetaTopic(config, { topic: "s/b/meter/energy/$meta", payload: "{}", retain: false })).toBeUndefined()
    expect(staleMetaTopic(config, retained("s/b/meter/energy/$meta", ""))).toBeUndefined()
  })

  it("leaves metadata another gateway published, or that names no gateway, alone", () => {
    const topic = "s/b/meter/energy/$meta"
    expect(staleMetaTopic(config, retained(topic, '{"name":"x","gateway":"roof"}'))).toBeUndefined()
    expect(staleMetaTopic(config, retained(topic, '{"name":"x"}'))).toBeUndefined()
    expect(staleMetaTopic(config, retained(topic, "not json"))).toBeUndefined()
    expect(staleMeta(config, retained(topic, '{"name":"x","gateway":"roof"}'))).toEqual({
      _tag: "skip",
      topic,
      owner: "roof"
    })
    expect(staleMeta(config, retained(topic, '{"name":"x"}'))).toEqual({ _tag: "skip", topic, owner: undefined })
  })

  it("subscribes to the metadata of the config's devices only", () => {
    expect(metaSubscriptions(config)).toEqual([{ filter: "s/b/meter/+/$meta", qos: 0 }])
  })
})

describe("the gateway and retained metadata", () => {
  it.effect("clears a removed point's metadata on connecting, and nothing else", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      const control = makeBrokerControl()
      const seed = (topic: string, gateway = "main") =>
        control.retainedMessages.set(topic, {
          clientId: "before",
          topic,
          payload: JSON.stringify({ name: "x", gateway }),
          qos: 0,
          retain: true
        })
      seed("s/b/meter/old-name/$meta")
      seed("s/b/meter/power/$meta")
      seed("s/b/other/x/$meta")
      // Another gateway in the building with a device of the same id: its point is not this gateway's to clear.
      seed("s/b/meter/roof-point/$meta", "roof")
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
      const running = yield* runGateway(gateway, { network: network.host("10.0.0.1") }).pipe(Effect.forkScoped)
      for (let step = 0; step < 20; step++) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))
        yield* TestClock.adjust("500 millis")
      }
      expect([...control.retainedMessages.keys()].filter((topic) => topic.endsWith("/$meta")).toSorted()).toEqual([
        "s/b/meter/power/$meta",
        "s/b/meter/roof-point/$meta",
        "s/b/other/x/$meta"
      ])
      // The gateway's own metadata names it.
      expect(control.retainedMessages.get("s/b/meter/power/$meta")?.payload).toContain('"gateway":"main"')
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
