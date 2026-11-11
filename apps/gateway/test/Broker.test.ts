/**
 * `ot-gateway broker` and `ot-gateway publish` over real TCP, against the in-process test broker.
 */
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { type BrokerControl, makeBrokerControl, Property, serveMqtt } from "@ot-gateway/mqtt"
import { ConfigProvider, Effect } from "effect"
import {
  brokerClient,
  brokerWarnings,
  checkBroker,
  formatBrokerReport,
  formatPublished,
  publishOnce
} from "../src/Broker.ts"

/** A broker on a free port for the current scope, and a config pointing at it. */
const brokerAndConfig = (control: BrokerControl, version: "auto" | "5" | "3.1.1" = "auto") =>
  Effect.gen(function* () {
    const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
    yield* serveMqtt(server, control).pipe(Effect.forkScoped)
    const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port
    const config = yield* parseConfig(
      JSON.stringify({
        site: "s",
        building: "b",
        mqtt: { url: `mqtt://127.0.0.1:${port}`, version },
        devices: [
          {
            id: "meter",
            protocol: "simulator",
            points: [{ id: "power", name: "Power", waveform: "sine", min: 0, max: 10, periodSeconds: 60 }]
          }
        ]
      })
    )
    return config
  })

describe("ot-gateway broker", () => {
  it.live("reports MQTT 5, the broker's limits and a round trip", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      control.connackProperties.set(Property.ReceiveMaximum, 20)
      const report = yield* checkBroker(yield* brokerAndConfig(control))
      expect(report).toMatchObject({ ok: true, protocolVersion: "5", receiveMaximum: 20, retainAvailable: true })
      expect(report.roundTripMs).toBeGreaterThanOrEqual(0)
      expect(report.roundTripTopic).toMatch(/^s\/b\/\$gateway\/[^/]+\/check\/[0-9a-f]{6}$/)
      expect(report.warnings).toEqual([])
      expect(formatBrokerReport(report)).toContain("connected with MQTT 5")
      expect(control.connects[0]?.clientId).toMatch(/^ot-gateway-check-[0-9a-f]{6}$/)
    })
  )

  it.live("finds a broker that speaks MQTT 3.1.1 only, and says what that leaves out", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      control.speaksMqtt5 = false
      const report = yield* checkBroker(yield* brokerAndConfig(control))
      expect(report.protocolVersion).toBe("3.1.1")
      expect(report.roundTripMs).toBeGreaterThanOrEqual(0)
      expect(report.warnings).toEqual([expect.stringContaining("MQTT 3.1.1")])
    })
  )

  it.live("says why it could not connect", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      control.speaksMqtt5 = false
      const error = yield* Effect.flip(checkBroker(yield* brokerAndConfig(control, "5")))
      expect(error.message).toMatch(/could not connect to mqtt:\/\/127\.0\.0\.1:\d+: .*does not speak MQTT 5/)
    })
  )

  it.live(
    "fails, with ok false, when its message does not come back",
    () =>
      Effect.gen(function* () {
        const control = makeBrokerControl()
        control.routeMessages = false
        const report = yield* checkBroker(yield* brokerAndConfig(control))
        expect(report.ok).toBe(false)
        expect(report.roundTripMs).toBeUndefined()
        expect(report.warnings).toEqual([expect.stringContaining("did not come back")])
        expect(formatBrokerReport(report)).toContain("round trip: NO ANSWER")
      }),
    15_000
  )

  it.live("names the unset password variable and where to put it", () =>
    Effect.gen(function* () {
      const settings = { version: "auto", url: "mqtt://127.0.0.1:1", passwordEnv: "MQTT_PASSWORD" } as const
      const error = yield* Effect.flip(brokerClient(settings, "check"))
      expect(error._tag).toBe("MqttSettingsError")
      expect(error.message).toContain("MQTT_PASSWORD is not set")
      expect(error.message).toContain("ot-gateway.env (MQTT_PASSWORD=...)")
    }).pipe(Effect.scoped, Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))))
  )

  it("warns about what a broker withholds", () => {
    const info = {
      protocolVersion: "5",
      receiveMaximum: 10,
      maximumQoS: 0,
      retainAvailable: false,
      keepAliveSeconds: 30
    } as const
    expect(brokerWarnings(info, undefined, "s/b/$gateway/g/check/x")).toEqual([
      expect.stringContaining("no retained messages"),
      expect.stringContaining("QoS 0 only"),
      expect.stringContaining("did not come back")
    ])
  })
})

describe("ot-gateway publish", () => {
  it.live("sends a message, retained when asked, and clears a topic with an empty retained one", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      const config = yield* brokerAndConfig(control)
      const sent = yield* publishOnce(config, "s/b/test", "hello", { retain: true, qos: 1 })
      expect(formatPublished(sent)).toBe("published 5 byte(s) to s/b/test (QoS 1, retained)")
      expect(control.retained.get("s/b/test")).toBe("hello")
      const cleared = yield* publishOnce(config, "s/b/test", "", { retain: true, qos: 1 })
      expect(formatPublished(cleared)).toBe("cleared the retained message on s/b/test")
      expect(control.retained.has("s/b/test")).toBe(false)
    })
  )

  it.live("speaks MQTT 3.1.1 to a broker that only speaks that", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      control.speaksMqtt5 = false
      yield* publishOnce(yield* brokerAndConfig(control, "3.1.1"), "s/b/test", "x", { retain: false, qos: 0 })
      expect(control.connects[0]?.protocolVersion).toBe(4)
      // QoS 0 has no PUBACK to wait for: give the broker a moment to read it.
      for (let tries = 0; control.messages.length === 0 && tries < 100; tries++) yield* Effect.sleep("10 millis")
      expect(control.messages).toMatchObject([{ topic: "s/b/test", payload: "x", qos: 0 }])
    })
  )

  it.live("reports the QoS the broker allowed, not the one asked for", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      control.connackProperties.set(Property.MaximumQoS, 0)
      const sent = yield* publishOnce(yield* brokerAndConfig(control), "s/b/test", "x", { retain: false, qos: 1 })
      expect(sent).toMatchObject({ qos: 0, requestedQos: 1 })
      expect(formatPublished(sent)).toBe("published 1 byte(s) to s/b/test (QoS 0: the broker allows QoS 0 only)")
    })
  )

  it.live("refuses a topic with a wildcard", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        publishOnce(yield* brokerAndConfig(makeBrokerControl()), "s/b/#", "x", { retain: false, qos: 1 })
      )
      expect(error.message).toContain("wildcard")
    })
  )
})
