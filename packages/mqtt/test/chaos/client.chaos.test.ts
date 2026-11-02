/**
 * The client against a broker that misbehaves: protocol errors in CONNACK,
 * withheld PUBACKs, transient refusals, silence, oversized packets and a wall
 * clock that jumps. Each test asserts the fixed behaviour of a chaos finding.
 */
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Exit } from "effect"
import type { MqttPublishError } from "../../src/Client.ts"
import { Property } from "../../src/Packet.ts"
import { clientOn, makeScript, startScriptedBroker, waitUntil } from "./harness.ts"

const elapsedSince = (started: number) => Date.now() - started

describe("chaos: MQTT client", () => {
  it.live("treats Receive Maximum 0 in CONNACK as a protocol error instead of hanging", () =>
    Effect.gen(function* () {
      const script = makeScript()
      script.connack = () => ({ reason: 0, properties: new Map([[Property.ReceiveMaximum, 0]]) })
      const port = yield* startScriptedBroker(script)
      const client = yield* clientOn(port)
      yield* waitUntil(() => script.disconnects.length > 0)
      // DISCONNECT 0x82 (protocol error), §3.2.2.3.3.
      expect(script.disconnects[0]).toBe(0x82)
      expect(yield* client.isConnected).toBe(false)

      const started = Date.now()
      const error = yield* Effect.flip(client.publish("a/b", "1").pipe(Effect.timeout("3 seconds")))
      expect(error._tag).toBe("MqttPublishError")
      expect(elapsedSince(started)).toBeLessThan(1500)
    })
  )

  it.live("counts the wait for an inflight slot against publishTimeout", () =>
    Effect.gen(function* () {
      const script = makeScript()
      script.connack = () => ({ reason: 0, properties: new Map([[Property.ReceiveMaximum, 1]]) })
      script.onPublish = () => ({ _tag: "drop" })
      const port = yield* startScriptedBroker(script)
      const client = yield* clientOn(port)
      yield* waitUntil(() => script.connections > 0)
      yield* Effect.sleep("100 millis")

      const started = Date.now()
      const finished: Array<number> = []
      const exits = yield* Effect.forEach(
        [0, 1, 2, 3, 4, 5],
        (i) =>
          client.publish("a/b", String(i)).pipe(
            Effect.exit,
            Effect.tap(() => Effect.sync(() => finished.push(elapsedSince(started))))
          ),
        { concurrency: "unbounded" }
      )
      expect(exits.every(Exit.isFailure)).toBe(true)
      // publishTimeout is 500 ms: every publish gives up around then, none waits its turn for seconds.
      expect(Math.max(...finished)).toBeLessThan(1500)
    })
  )

  it.live("treats only permanent PUBACK reason codes as rejections", () =>
    Effect.gen(function* () {
      const script = makeScript()
      const codes = [0x80, 0x83, 0x91, 0x97, 0x87, 0x90, 0x95, 0x99]
      script.onPublish = (_message, index) => ({ _tag: "ack", reason: codes[index] ?? 0 })
      const port = yield* startScriptedBroker(script)
      const client = yield* clientOn(port)
      const reasons: Array<MqttPublishError["reason"]> = []
      for (const _ of codes) {
        const error = yield* Effect.flip(client.publish("a/b", "x"))
        expect(error.inFlight).toBeUndefined()
        reasons.push(error.reason)
      }
      expect(reasons).toEqual([
        "unavailable",
        "unavailable",
        "unavailable",
        "unavailable",
        "rejected",
        "rejected",
        "rejected",
        "rejected"
      ])
    })
  )

  it.live("still detects a silent broker when it sets Server Keep Alive 0", () =>
    Effect.gen(function* () {
      const script = makeScript()
      script.connack = () => ({ reason: 0, properties: new Map([[Property.ServerKeepAlive, 0]]) })
      const port = yield* startScriptedBroker(script)
      const client = yield* clientOn(port, { keepAliveSeconds: 1 })
      yield* waitUntil(() => script.connections > 0)
      yield* client.publish("a/b", "ok")
      script.answerPings = false
      // Our own 1 s keep alive still applies: silent for 1.5 s means dead, then the client redials.
      expect(yield* waitUntil(() => script.connections >= 2, 4000)).toBe(true)
    })
  )

  it.live("drops a connection that answers pings but never acknowledges a publish", () =>
    Effect.gen(function* () {
      const script = makeScript()
      script.onPublish = (message) => (message.connection === 1 ? { _tag: "drop" } : { _tag: "ack" })
      const port = yield* startScriptedBroker(script)
      const client = yield* clientOn(port, { keepAliveSeconds: 1 })
      yield* waitUntil(() => script.connections > 0)

      // Neither publish is blamed: a broker that acknowledges nothing is slow, not refusing these messages.
      const first = yield* Effect.flip(client.publish("a/b", "0"))
      expect(first.inFlight).toBeUndefined()
      const second = yield* Effect.flip(client.publish("a/b", "1"))
      expect(second.inFlight).toBeUndefined()
      // Two PUBACKs in a row did not come: the client gives up on the connection and the next one works.
      expect(yield* waitUntil(() => script.connections >= 2)).toBe(true)
      yield* client.publish("a/b", "2")
    })
  )

  it.live("marks a publish whose connection breaks before the PUBACK as in flight", () =>
    Effect.gen(function* () {
      const script = makeScript()
      script.onPublish = (message) =>
        message.connection === 1 ? { _tag: "disconnect", reason: 0x95 } : { _tag: "ack" }
      const port = yield* startScriptedBroker(script)
      const client = yield* clientOn(port)
      yield* waitUntil(() => script.connections > 0)
      const error = yield* Effect.flip(client.publish("a/b", "x".repeat(100)))
      expect(error).toMatchObject({ reason: "unavailable", inFlight: true })
    })
  )

  it.live("closes the connection on a packet above its Maximum Packet Size without buffering it", () =>
    Effect.gen(function* () {
      const script = makeScript()
      const announced = 32 * 1024 * 1024
      script.afterConnack = (connection, write) =>
        Effect.gen(function* () {
          if (connection !== 1) return
          // A QoS 0 PUBLISH header announcing 32 MiB, then the start of its body.
          yield* write(Uint8Array.of(0x30, 0x80, 0x80, 0x80, 0x10))
          yield* write(new Uint8Array(16 * 1024))
        })
      const port = yield* startScriptedBroker(script)
      const client = yield* clientOn(port, { keepAliveSeconds: 60 })
      expect(announced).toBe(0x10 * 128 ** 3)

      // DISCONNECT 0x95 (packet too large), §3.1.2.11.4; then a fresh connection works.
      expect(yield* waitUntil(() => script.disconnects.includes(0x95))).toBe(true)
      expect(yield* waitUntil(() => script.connections >= 2)).toBe(true)
      yield* client.publish("a/b", "after")
    })
  )

  it.live("times keep alive on the monotonic clock, so wall clock steps do not matter", () =>
    Effect.gen(function* () {
      let offsetMillis = 0
      const base = yield* Clock.clockWith((clock) => Effect.succeed(clock))
      const skewed: Clock.Clock = {
        currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe() - offsetMillis,
        currentTimeMillis: Effect.sync(() => base.currentTimeMillisUnsafe() - offsetMillis),
        currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe() - BigInt(offsetMillis) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => base.currentTimeNanosUnsafe() - BigInt(offsetMillis) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: base.monotonicTimeNanos,
        sleep: (duration) => base.sleep(duration)
      }
      const script = makeScript()
      const port = yield* startScriptedBroker(script)
      const client = yield* clientOn(port, { keepAliveSeconds: 1 }).pipe(Effect.provideService(Clock.Clock, skewed))
      yield* waitUntil(() => script.connections > 0)
      yield* Effect.sleep("200 millis")

      // NTP steps the clock forward an hour; the broker is healthy: no reconnect.
      offsetMillis = -3_600_000
      yield* Effect.sleep("2 seconds")
      expect(script.connections).toBe(1)
      expect(yield* client.isConnected).toBe(true)

      // Then back two hours, and the broker goes silent: still detected.
      offsetMillis = 3_600_000
      script.answerPings = false
      expect(yield* waitUntil(() => script.connections >= 2, 4000)).toBe(true)
    })
  )
})
