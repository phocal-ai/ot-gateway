/**
 * Subscriptions for commands (v0.4): the client subscribes on every connect,
 * acknowledges what it receives, and never gets a message twice or late.
 * Client and test broker run on an in-memory network under the test clock.
 */
import { describe, expect, it } from "@effect/vitest"
import { makeMemoryNetwork } from "@plenum/core"
import { Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { makeMqttClient } from "../src/Client.ts"
import type { InboundMessage } from "../src/Client.ts"
import { makeBrokerControl, publishToSubscribers, serveMqtt } from "../src/TestBroker.ts"

const commands = "s/b/+/+/$set"

const setup = Effect.fnUntraced(function* (retainAsPublished = false) {
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
    subscriptions: [{ filter: commands, qos: 1, retainAsPublished }],
    onMessage: (message) => Effect.sync(() => received.push(message))
  })
  return { control, startBroker, received, client }
})

const command = (value: number, extra: { retain?: boolean } = {}) => ({
  topic: "s/b/ahu-1/setpoint/$set",
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
      publishToSubscribers(control, { ...command(2), topic: "s/b/ahu-1/setpoint/$meta" })
      yield* TestClock.adjust("1 second")
      expect(received).toEqual([
        {
          topic: "s/b/ahu-1/setpoint/$set",
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
})
