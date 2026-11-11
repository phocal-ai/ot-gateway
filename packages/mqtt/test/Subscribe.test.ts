/**
 * Subscriptions for commands (v0.4): the client subscribes on every connect,
 * acknowledges what it receives, and never gets a message twice or late.
 * Client and test broker run on an in-memory network under the test clock.
 */
import { describe, expect, it } from "@effect/vitest"
import { makeMemoryNetwork, mqttSubscribes } from "@ot-gateway/core"
import { Effect, Exit, Fiber, Metric, Scope } from "effect"
import { TestClock } from "effect/testing"
import { makeMqttClient } from "../src/Client.ts"
import type { InboundMessage } from "../src/Client.ts"
import { makeBrokerControl, publishToSubscribers, serveMqtt } from "../src/TestBroker.ts"

const commands = "s/b/+/+/$set"

const setup = Effect.fnUntraced(function* (retainAsPublished = false, protocolVersion: "5" | "3.1.1" = "5") {
  const network = makeMemoryNetwork()
  const control = makeBrokerControl()
  const startBroker = Effect.gen(function* () {
    const scope = yield* Scope.make()
    const fiber = yield* Effect.flatMap(network.listen("10.0.0.2", 1883), (server) => serveMqtt(server, control)).pipe(
      Scope.provide(scope),
      Effect.forkChild
    )
    return { stop: Effect.andThen(Fiber.interrupt(fiber), Scope.close(scope, Exit.void)) }
  })
  const received: Array<InboundMessage> = []
  const socket = yield* network.host("10.0.0.1").tcp({ host: "10.0.0.2", port: 1883, openTimeout: "5 seconds" })
  const client = yield* makeMqttClient(socket, {
    clientId: "gateway",
    protocolVersion,
    subscriptions: [{ filter: commands, qos: 1, retainAsPublished }],
    onMessage: (message) => Effect.sync(() => received.push(message))
  })
  return { control, startBroker, received, client }
})

const command = (value: number, extra: { retain?: boolean } = {}) => ({
  topic: "s/b/ventilation-1/setpoint/$set",
  payload: JSON.stringify({ value }),
  qos: 1 as const,
  retain: extra.retain ?? false,
  responseTopic: "app/responses",
  correlationData: Uint8Array.of(value)
})

describe("MQTT subscriptions", () => {
  it.effect("delivers live messages with their response topic and correlation data, and only matching ones", () =>
    Effect.gen(function* () {
      const { control, startBroker, received } = yield* setup()
      yield* startBroker
      yield* TestClock.adjust("2 seconds")
      publishToSubscribers(control, command(1))
      publishToSubscribers(control, { ...command(2), topic: "s/b/ventilation-1/setpoint/$meta" })
      yield* TestClock.adjust("1 second")
      expect(received).toEqual([
        {
          topic: "s/b/ventilation-1/setpoint/$set",
          payload: '{"value":1}',
          retain: false,
          responseTopic: "app/responses",
          correlationData: Uint8Array.of(1)
        }
      ])
    }).pipe(Effect.scoped)
  )

  it.effect("sees a retained message on every subscribe, flagged as retained", () =>
    Effect.gen(function* () {
      const { control, startBroker, received } = yield* setup()
      publishToSubscribers(control, command(5, { retain: true }))
      const { stop } = yield* startBroker
      yield* TestClock.adjust("2 seconds")
      expect(received.map((message) => [message.payload, message.retain])).toEqual([['{"value":5}', true]])

      // The broker restarts (keeping its retained messages): the client subscribes again and sees it again.
      yield* stop
      yield* startBroker
      yield* TestClock.adjust("30 seconds")
      expect(received.map((message) => message.retain)).toEqual([true, true])
    }).pipe(Effect.scoped)
  )

  it.effect("subscribes again after a reconnect, and never gets what was sent while it was away", () =>
    Effect.gen(function* () {
      const { control, startBroker, received } = yield* setup()
      const { stop } = yield* startBroker
      yield* TestClock.adjust("2 seconds")
      yield* stop
      // Sent while the gateway is disconnected: a clean session means it is never delivered.
      publishToSubscribers(control, command(7))
      yield* startBroker
      yield* TestClock.adjust("30 seconds")
      publishToSubscribers(control, command(8))
      yield* TestClock.adjust("1 second")
      expect(received.map((message) => message.payload)).toEqual(['{"value":8}'])
    }).pipe(Effect.scoped)
  )

  it.effect("keeps the retain flag on a live message with Retain As Published, and clears it without", () =>
    Effect.gen(function* () {
      for (const retainAsPublished of [true, false]) {
        const { control, startBroker, received } = yield* setup(retainAsPublished)
        yield* startBroker
        yield* TestClock.adjust("2 seconds")
        publishToSubscribers(control, command(3, { retain: true }))
        yield* TestClock.adjust("1 second")
        expect(received.map((message) => message.retain)).toEqual([retainAsPublished])
      }
    }).pipe(Effect.scoped)
  )

  it.effect("receives in MQTT 3.1.1: retained only on subscribing, and without MQTT 5's properties", () =>
    Effect.gen(function* () {
      const { control, startBroker, received } = yield* setup(true, "3.1.1")
      publishToSubscribers(control, command(1, { retain: true }))
      yield* startBroker
      yield* TestClock.adjust("2 seconds")
      // Live, a retained publish arrives with the retain flag cleared (3.1.1 §3.3.1.3).
      publishToSubscribers(control, command(2, { retain: true }))
      yield* TestClock.adjust("1 second")
      expect(received).toEqual([
        { topic: "s/b/ventilation-1/setpoint/$set", payload: '{"value":1}', retain: true },
        { topic: "s/b/ventilation-1/setpoint/$set", payload: '{"value":2}', retain: false }
      ])
      expect(control.connects.map((connect) => connect.protocolVersion)).toEqual([4])
    })
  )
})

const count = (outcome: "granted" | "refused" | "missing") =>
  Metric.value(Metric.withAttributes(mqttSubscribes, { outcome })).pipe(Effect.map((state) => state.count))

/** How many SUBSCRIBEs ended with each outcome. */
const subscribes = Effect.gen(function* () {
  return { granted: yield* count("granted"), refused: yield* count("refused"), missing: yield* count("missing") }
})

/** Each test counts into a registry of its own. */
const withOwnMetrics = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Metric.MetricRegistry, new Map()))

describe("MQTT SUBACK tracking", () => {
  it.effect("counts a granted subscription once per connect, and again after a reconnect", () =>
    Effect.gen(function* () {
      const { startBroker } = yield* setup()
      const { stop } = yield* startBroker
      yield* TestClock.adjust("2 seconds")
      expect(yield* subscribes).toEqual({ granted: 1, refused: 0, missing: 0 })
      yield* stop
      yield* startBroker
      yield* TestClock.adjust("30 seconds")
      expect(yield* subscribes).toEqual({ granted: 2, refused: 0, missing: 0 })
    }).pipe(Effect.scoped, withOwnMetrics)
  )

  it.effect("counts a refused filter as refused, not granted", () =>
    Effect.gen(function* () {
      const { control, startBroker } = yield* setup()
      control.refusedFilters.add(commands)
      yield* startBroker
      yield* TestClock.adjust("30 seconds")
      expect(yield* subscribes).toEqual({ granted: 0, refused: 1, missing: 0 })
    }).pipe(Effect.scoped, withOwnMetrics)
  )

  it.effect("counts a missing SUBACK after 10 seconds, once, and keeps the connection", () =>
    Effect.gen(function* () {
      const { control, startBroker, client } = yield* setup()
      control.ackSubscribes = false
      yield* startBroker
      // Connected within the first 2 seconds: the deadline has not passed yet.
      yield* TestClock.adjust("2 seconds")
      yield* TestClock.adjust("7 seconds")
      expect(yield* subscribes).toEqual({ granted: 0, refused: 0, missing: 0 })
      yield* TestClock.adjust("10 seconds")
      expect(yield* subscribes).toEqual({ granted: 0, refused: 0, missing: 1 })
      yield* TestClock.adjust("60 seconds")
      expect(yield* subscribes).toEqual({ granted: 0, refused: 0, missing: 1 })
      expect(control.connects).toHaveLength(1)
      yield* client.publish("s/b/ventilation-1/temperature", "21.5")
      expect(control.messages.map((message) => message.payload)).toEqual(["21.5"])
    }).pipe(Effect.scoped, withOwnMetrics)
  )

  it.effect("does not settle the SUBSCRIBE with a SUBACK for another packet id", () =>
    Effect.gen(function* () {
      const { control, startBroker } = yield* setup()
      control.subackPacketId = 999
      yield* startBroker
      yield* TestClock.adjust("2 seconds")
      expect(yield* subscribes).toEqual({ granted: 0, refused: 0, missing: 0 })
      yield* TestClock.adjust("10 seconds")
      expect(yield* subscribes).toEqual({ granted: 0, refused: 0, missing: 1 })
    }).pipe(Effect.scoped, withOwnMetrics)
  )

  it.effect("counts nothing missing for a connection that ended before the deadline", () =>
    Effect.gen(function* () {
      const { control, startBroker } = yield* setup()
      control.ackSubscribes = false
      const { stop } = yield* startBroker
      yield* TestClock.adjust("2 seconds")
      yield* stop
      control.ackSubscribes = true
      yield* startBroker
      yield* TestClock.adjust("30 seconds")
      expect(control.connects).toHaveLength(2)
      expect(yield* subscribes).toEqual({ granted: 1, refused: 0, missing: 0 })
    }).pipe(Effect.scoped, withOwnMetrics)
  )
})
