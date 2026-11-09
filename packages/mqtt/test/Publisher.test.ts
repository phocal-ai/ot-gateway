/**
 * The publisher layer's start-up checks, on the in-memory network under the test clock.
 */
import { describe, expect, it } from "@effect/vitest"
import { makeMemoryNetwork, type MqttSettings } from "@ot-gateway/core"
import { ConfigProvider, Effect, Exit, Layer, Logger, References, Scope } from "effect"
import { TestClock } from "effect/testing"
import { type ConnectionInfo, makeBrokerControl, MqttPublisher, serveMqtt } from "../src/index.ts"

const password = "not-for-the-logs"

/** Every warning logged while it runs, with its annotations; the password variable is set. */
const capturingWarnings = () => {
  const warnings: Array<{ readonly message: string; readonly annotations: Record<string, unknown> }> = []
  const layer = Layer.mergeAll(
    Logger.layer([
      Logger.make(({ logLevel, message, fiber }) => {
        if (logLevel !== "Warn") return
        warnings.push({
          message: (Array.isArray(message) ? message : [message]).join(" "),
          annotations: { ...fiber.getRef(References.CurrentLogAnnotations) }
        })
      })
    ]),
    ConfigProvider.layer(ConfigProvider.fromUnknown({ MQTT_PASSWORD: password }))
  )
  const passwordWarnings = () => warnings.filter((warning) => warning.message.includes("unencrypted"))
  return { layer, warnings, passwordWarnings }
}

/** The password warnings from starting a publisher for `settings` with no broker there, through a minute of redials. */
const passwordWarningsAtStartup = (settingsWithoutVersion: Omit<MqttSettings, "version">) =>
  Effect.gen(function* () {
    const settings: MqttSettings = { version: "auto", ...settingsWithoutVersion }
    const capture = capturingWarnings()
    const network = makeMemoryNetwork().host("10.0.0.1")
    yield* Effect.gen(function* () {
      yield* Layer.build(MqttPublisher(settings, { network }))
      yield* TestClock.adjust("1 minute")
    }).pipe(Effect.scoped, Effect.provide(capture.layer))
    return capture.passwordWarnings()
  })

describe("MqttPublisher password warning", () => {
  it.effect("warns once at start-up, not per reconnect, when a password goes over mqtt:// to a remote broker", () =>
    Effect.gen(function* () {
      const capture = capturingWarnings()
      const memory = makeMemoryNetwork()
      const settings = {
        version: "auto" as const,
        url: "mqtt://10.0.0.2:1883",
        clientId: "gw",
        username: "gw",
        passwordEnv: "MQTT_PASSWORD"
      }
      yield* Effect.gen(function* () {
        yield* Layer.build(MqttPublisher(settings, { network: memory.host("10.0.0.1") }))
        // Redials while nobody listens, then a connection, a broker crash and a reconnect.
        yield* TestClock.adjust("1 minute")
        const firstBroker = yield* Scope.make()
        const first = makeBrokerControl()
        yield* Effect.gen(function* () {
          yield* serveMqtt(yield* memory.listen("10.0.0.2", 1883), first).pipe(Effect.forkScoped)
        }).pipe(Scope.provide(firstBroker))
        yield* TestClock.adjust("20 seconds")
        expect(first.connects).toMatchObject([{ username: "gw", hasPassword: true }])
        yield* Scope.close(firstBroker, Exit.void)
        const second = makeBrokerControl()
        yield* serveMqtt(yield* memory.listen("10.0.0.2", 1883), second).pipe(Effect.forkScoped)
        yield* TestClock.adjust("20 seconds")
        expect(second.connects).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.provide(capture.layer))

      expect(capture.passwordWarnings()).toEqual([
        {
          message: "the MQTT password is sent unencrypted over mqtt://; use mqtts:// to encrypt it",
          annotations: { broker: "10.0.0.2:1883", tls: false }
        }
      ])
      expect(capture.warnings.some((warning) => warning.message.includes("connect failed"))).toBe(true)
      expect(JSON.stringify(capture.warnings)).not.toContain(password)
    })
  )

  it.effect("warns for a broker named by host name", () =>
    Effect.gen(function* () {
      const warnings = yield* passwordWarningsAtStartup({ url: "mqtt://broker.local", passwordEnv: "MQTT_PASSWORD" })
      expect(warnings).toMatchObject([{ annotations: { broker: "broker.local:1883", tls: false } }])
    })
  )

  it.effect("does not warn over mqtts://", () =>
    Effect.gen(function* () {
      expect(
        yield* passwordWarningsAtStartup({ url: "mqtts://broker.local:8883", passwordEnv: "MQTT_PASSWORD" })
      ).toEqual([])
    })
  )

  it.effect("does not warn for a broker on this machine", () =>
    Effect.gen(function* () {
      for (const url of ["mqtt://localhost:1883", "mqtt://127.0.0.1:1883", "mqtt://[::1]:1883"]) {
        expect(yield* passwordWarningsAtStartup({ url, passwordEnv: "MQTT_PASSWORD" })).toEqual([])
      }
    })
  )

  it.effect("does not warn without a password", () =>
    Effect.gen(function* () {
      expect(yield* passwordWarningsAtStartup({ url: "mqtt://broker.local:1883", username: "gw" })).toEqual([])
    })
  )
})

describe("MqttPublisher onConnected", () => {
  it.effect("tells what the broker allowed on every connect, reconnects included", () =>
    Effect.gen(function* () {
      const memory = makeMemoryNetwork()
      const seen: Array<ConnectionInfo> = []
      const settings: MqttSettings = { version: "auto", url: "mqtt://10.0.0.2:1883", clientId: "gw" }
      yield* Effect.gen(function* () {
        yield* Layer.build(
          MqttPublisher(settings, {
            network: memory.host("10.0.0.1"),
            onConnected: (info) => Effect.sync(() => seen.push(info))
          })
        )
        const firstBroker = yield* Scope.make()
        yield* Effect.gen(function* () {
          yield* serveMqtt(yield* memory.listen("10.0.0.2", 1883)).pipe(Effect.forkScoped)
        }).pipe(Scope.provide(firstBroker))
        yield* TestClock.adjust("20 seconds")
        expect(seen).toHaveLength(1)
        expect(seen[0]).toMatchObject({ protocolVersion: "5", maximumQoS: 1, retainAvailable: true })
        yield* Scope.close(firstBroker, Exit.void)
        yield* serveMqtt(yield* memory.listen("10.0.0.2", 1883)).pipe(Effect.forkScoped)
        yield* TestClock.adjust("20 seconds")
        expect(seen).toHaveLength(2)
      }).pipe(Effect.scoped)
    })
  )
})
