/**
 * The client and publisher over real TCP, against the in-process test broker.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { describe, expect, it } from "@effect/vitest"
import { mqttConnected, mqttConnects, Publisher, withMetricAttributes } from "@ot-gateway/core"
import { ConfigProvider, Context, Effect, Exit, Fiber, Layer, Metric, Redacted, Scope } from "effect"
import type * as SocketServer from "effect/socket/SocketServer"
import { makeBrokerControl, makeMqttClient, MqttPublisher, parseBrokerUrl, Property, serveMqtt } from "../src/index.ts"
import type { BrokerControl, MqttClient, MqttClientOptions } from "../src/index.ts"

const portOf = (server: SocketServer.SocketServer["Service"]) =>
  server.address._tag === "UnixPathAddress" ? 0 : server.address.port

/** A broker on `port` (0 = any free port) for the current scope. */
const startBroker = (control: BrokerControl = makeBrokerControl(), port = 0) =>
  Effect.gen(function* () {
    const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port })
    yield* serveMqtt(server, control).pipe(Effect.forkScoped)
    return { port: portOf(server), control }
  })

const fastOptions = {
  clientId: "test-gw",
  connectTimeout: "1 second",
  publishTimeout: "1 second",
  reconnectDelay: { initial: "20 millis", max: "100 millis" }
} satisfies MqttClientOptions

const clientOn = (port: number, options: Partial<MqttClientOptions> = {}) =>
  Effect.flatMap(NodeSocket.makeNet({ host: "127.0.0.1", port, openTimeout: "1 second" }), (socket) =>
    makeMqttClient(socket, { ...fastOptions, ...options })
  )

/** Poll until `condition` holds, failing the test after `timeoutMs`. */
const eventually = (condition: Effect.Effect<boolean>, timeoutMs = 3000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (!(yield* condition)) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("condition not met in time"))
      yield* Effect.sleep("10 millis")
    }
  })

const connectedClient = (client: MqttClient) => eventually(client.isConnected)

const connectCount = (test: string, outcome: string) =>
  Metric.value(Metric.withAttributes(mqttConnects, { test, outcome })).pipe(Effect.map((state) => state.count))

describe("MQTT client over TCP", () => {
  it.live("connects with credentials and publishes at QoS 0 and 1", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startBroker()
      const client = yield* clientOn(port, { username: "gw", password: Redacted.make("pw") })
      yield* client.publish("s/b/d/p", '{"value":1}', { qos: 0 })
      yield* client.publish("s/b/d/p/$meta", '{"unit":"°C"}', { retain: true })

      expect(control.connects).toMatchObject([
        { clientId: "test-gw", username: "gw", hasPassword: true, cleanStart: true, maximumPacketSize: 1024 * 1024 }
      ])
      expect(control.messages).toEqual([
        { clientId: "test-gw", topic: "s/b/d/p", payload: '{"value":1}', qos: 0, retain: false },
        { clientId: "test-gw", topic: "s/b/d/p/$meta", payload: '{"unit":"°C"}', qos: 1, retain: true }
      ])
      expect(control.retained.get("s/b/d/p/$meta")).toBe('{"unit":"°C"}')
      expect(yield* connectCount("happy", "ok")).toBe(1)
      const gauge = yield* Metric.value(Metric.withAttributes(mqttConnected, { test: "happy" }))
      expect(gauge.value).toBe(1)
    }).pipe(withMetricAttributes({ test: "happy" }))
  )

  it.live("sends DISCONNECT when its scope closes", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startBroker()
      const scope = yield* Scope.make()
      const client = yield* clientOn(port).pipe(Scope.provide(scope))
      yield* connectedClient(client)
      yield* Scope.close(scope, Exit.void)
      yield* eventually(Effect.sync(() => control.cleanDisconnects === 1))
    })
  )

  it.live("respects the broker's Maximum QoS", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      control.connackProperties.set(Property.MaximumQoS, 0)
      const { port } = yield* startBroker(control)
      const client = yield* clientOn(port)
      yield* client.publish("t", "x")
      // QoS 0 completes once written, so wait for the broker to read it.
      yield* eventually(Effect.sync(() => control.messages.length === 1))
      expect(control.messages.map((m) => m.qos)).toEqual([0])
    })
  )

  it.live("says which MQTT it speaks and what the broker allows", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      control.connackProperties.set(Property.ReceiveMaximum, 20)
      control.connackProperties.set(Property.MaximumPacketSize, 4096)
      const { port } = yield* startBroker(control)
      const client = yield* clientOn(port)
      yield* connectedClient(client)
      expect(yield* client.connection).toEqual({
        protocolVersion: "5",
        receiveMaximum: 20,
        maximumQoS: 1,
        retainAvailable: true,
        maximumPacketSize: 4096,
        keepAliveSeconds: 30
      })
    })
  )

  it.live("falls back to MQTT 3.1.1 when the broker refuses MQTT 5, and stays with it", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      control.speaksMqtt5 = false
      const { port } = yield* startBroker(control)
      const client = yield* clientOn(port)
      yield* client.publish("s/b/d/p", '{"value":1}')
      yield* client.publish("s/b/d/p/$meta", '{"unit":"°C"}', { retain: true, qos: 0 })
      yield* eventually(Effect.sync(() => control.messages.length === 2))
      expect(control.connects.map((connect) => connect.protocolVersion)).toEqual([4])
      expect(control.messages).toEqual([
        { clientId: "test-gw", topic: "s/b/d/p", payload: '{"value":1}', qos: 1, retain: false },
        { clientId: "test-gw", topic: "s/b/d/p/$meta", payload: '{"unit":"°C"}', qos: 0, retain: true }
      ])
      expect(yield* client.connection).toMatchObject({ protocolVersion: "3.1.1", receiveMaximum: 1_000 })
      expect(yield* connectCount("fallback", "failed")).toBe(0)
    }).pipe(withMetricAttributes({ test: "fallback" }))
  )

  it.live("refuses to fall back when told to speak MQTT 5 only", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      control.speaksMqtt5 = false
      const { port } = yield* startBroker(control)
      const client = yield* clientOn(port, { protocolVersion: "5", publishTimeout: "300 millis" })
      const failed = yield* Effect.flip(client.publish("t", "x"))
      expect(failed.reason).toBe("unavailable")
      yield* eventually(Effect.map(connectCount("only5", "rejected"), (count) => count >= 1))
      expect(control.connects).toEqual([])
    }).pipe(withMetricAttributes({ test: "only5" }))
  )

  it.live("speaks MQTT 3.1.1 from the start when told to", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startBroker()
      const client = yield* clientOn(port, { protocolVersion: "3.1.1" })
      yield* client.publish("t", "x")
      expect(control.connects.map((connect) => connect.protocolVersion)).toEqual([4])
      expect(control.messages.map((message) => message.payload)).toEqual(["x"])
    })
  )

  it.live("fails a publish whose PUBACK never comes, or refuses the message", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startBroker()
      const client = yield* clientOn(port, { publishTimeout: "200 millis" })
      yield* connectedClient(client)

      control.ackPublishes = false
      const timedOut = yield* Effect.flip(client.publish("t", "x"))
      expect(timedOut).toMatchObject({
        _tag: "MqttPublishError",
        topic: "t",
        reason: "unavailable",
        message: "no PUBACK in time"
      })
      // A slow broker says nothing about the message, so it is not blamed for it.
      expect(timedOut.inFlight).toBeUndefined()

      control.ackPublishes = true
      control.pubackReason = 0x87
      const refused = yield* Effect.flip(client.publish("t", "x"))
      expect(refused.message).toContain("refused the message: reason 0x87")
      expect(refused.reason).toBe("rejected")
    })
  )

  it.live("rejects invalid topic names without sending", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startBroker()
      const client = yield* clientOn(port)
      const wildcard = yield* Effect.flip(client.publish("s/+/x", "x"))
      expect(wildcard).toMatchObject({ reason: "rejected", message: "topic contains a wildcard" })
      expect((yield* Effect.flip(client.publish("", "x"))).message).toBe("topic is empty")
      expect(control.messages).toEqual([])
    })
  )

  it.live("counts a refused connection and keeps publishes failing", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      control.connackReason = 0x86
      const { port } = yield* startBroker(control)
      const client = yield* clientOn(port, { publishTimeout: "300 millis" })

      const error = yield* Effect.flip(client.publish("t", "x"))
      expect(error.message).toBe("not connected to the broker")
      expect(yield* connectCount("refused", "rejected")).toBeGreaterThanOrEqual(1)
      expect(yield* connectCount("refused", "ok")).toBe(0)
    }).pipe(withMetricAttributes({ test: "refused" }))
  )

  it.live("fails publishes while the broker is unreachable", () =>
    Effect.gen(function* () {
      // Bind a port, then release it, so the address is valid but closed.
      const port = yield* Effect.scoped(Effect.map(NodeSocketServer.make({ host: "127.0.0.1", port: 0 }), portOf))
      const client = yield* clientOn(port, { publishTimeout: "200 millis" })
      const error = yield* Effect.flip(client.publish("t", "x"))
      expect(error.message).toBe("not connected to the broker")
      expect(yield* connectCount("unreachable", "failed")).toBeGreaterThanOrEqual(1)
    }).pipe(withMetricAttributes({ test: "unreachable" }))
  )

  it.live("fails a publish at once while disconnected when told not to wait", () =>
    Effect.gen(function* () {
      const port = yield* Effect.scoped(Effect.map(NodeSocketServer.make({ host: "127.0.0.1", port: 0 }), portOf))
      const client = yield* clientOn(port, { publishTimeout: "5 seconds", waitForConnection: false })
      const started = Date.now()
      const error = yield* Effect.flip(client.publish("t", "x"))
      expect(error).toMatchObject({ reason: "unavailable", message: "not connected to the broker" })
      expect(Date.now() - started).toBeLessThan(1000)
    })
  )

  it.live("still waits for the first dial when told not to wait", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startBroker()
      const client = yield* clientOn(port, { waitForConnection: false })
      // Published right after start: it waits for the dial instead of failing.
      yield* client.publish("t", "first")
      expect(control.messages.map((m) => m.payload)).toEqual(["first"])
    })
  )

  it.live("reconnects after the broker restarts", () =>
    Effect.gen(function* () {
      const firstScope = yield* Scope.make()
      const first = yield* startBroker().pipe(Scope.provide(firstScope))
      const client = yield* clientOn(first.port, { publishTimeout: "3 seconds" })
      yield* client.publish("t", "before")

      yield* Scope.close(firstScope, Exit.void)
      yield* eventually(Effect.map(client.isConnected, (connected) => !connected))
      const gauge = yield* Metric.value(Metric.withAttributes(mqttConnected, { test: "restart" }))
      expect(gauge.value).toBe(0)

      const second = yield* startBroker(makeBrokerControl(), first.port)
      yield* client.publish("t", "after")
      expect(second.control.messages.map((m) => m.payload)).toEqual(["after"])
      expect(yield* connectCount("restart", "ok")).toBe(2)
    }).pipe(withMetricAttributes({ test: "restart" }))
  )

  it.live("sends publishes in the order they were called, also across a reconnect", () =>
    Effect.gen(function* () {
      const firstScope = yield* Scope.make()
      const first = yield* startBroker().pipe(Scope.provide(firstScope))
      const client = yield* clientOn(first.port, { publishTimeout: "3 seconds" })
      yield* connectedClient(client)
      yield* Scope.close(firstScope, Exit.void)
      yield* eventually(Effect.map(client.isConnected, (connected) => !connected))

      // Waits for the connection; the next one is called as soon as the client has one again.
      const waiting = yield* Effect.forkChild(client.publish("t", "older"))
      yield* Effect.yieldNow
      const second = yield* startBroker(makeBrokerControl(), first.port)
      while (!(yield* client.isConnected)) yield* Effect.yieldNow
      yield* client.publish("t", "newer")
      yield* Fiber.join(waiting)
      expect(second.control.messages.map((message) => message.payload)).toEqual(["older", "newer"])
    })
  )

  it.live(
    "drops a broker that stops answering pings (which publishes the will), then reconnects",
    () =>
      Effect.gen(function* () {
        const control = makeBrokerControl()
        control.answerPings = false
        const { port } = yield* startBroker(control)
        const will = { topic: "s/b/$gateway/main/health", payload: "offline", qos: 1, retain: true } as const
        const client = yield* clientOn(port, { keepAliveSeconds: 1, will })
        yield* connectedClient(client)
        // Silence is noticed after 1.5 keep alives (checked every half keep alive), then the client dials again.
        yield* eventually(
          Effect.sync(() => control.connects.length >= 2),
          5000
        )
        // The client dropped the connection without DISCONNECT, so the broker published its will.
        expect(control.retained.get(will.topic)).toBe("offline")
      }),
    10_000
  )
})

describe("MqttPublisher", () => {
  it.effect("parses broker URLs", () =>
    Effect.gen(function* () {
      expect(yield* parseBrokerUrl("mqtt://broker.local")).toEqual({ tls: false, host: "broker.local", port: 1883 })
      expect(yield* parseBrokerUrl("mqtts://broker.local")).toEqual({ tls: true, host: "broker.local", port: 8883 })
      expect(yield* parseBrokerUrl("mqtt://[::1]:1884")).toEqual({ tls: false, host: "::1", port: 1884 })
      expect((yield* Effect.flip(parseBrokerUrl("http://x"))).message).toContain("mqtt:// or mqtts://")
      expect((yield* Effect.flip(parseBrokerUrl("mqtt://u:p@x"))).message).toContain("must not contain credentials")
      expect((yield* Effect.flip(parseBrokerUrl("not a url"))).message).toContain("not a URL")
    })
  )

  it.live("publishes through the core Publisher with the password from the environment", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startBroker()
      const layer = MqttPublisher(
        {
          version: "auto",
          url: `mqtt://127.0.0.1:${port}`,
          clientId: "layer-gw",
          username: "gw",
          passwordEnv: "TEST_MQTT_PASSWORD"
        },
        { reconnectDelay: fastOptions.reconnectDelay }
      ).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ TEST_MQTT_PASSWORD: "pw" }))))

      yield* Effect.gen(function* () {
        const publisher = yield* Publisher
        yield* publisher.publish("s/b/d/p", "1", { retain: true })
        const error = yield* Effect.flip(publisher.publish("s/b/d/p", "1", { qos: 2 }))
        expect(error).toMatchObject({ _tag: "PublishError", reason: "rejected", message: "QoS 2 is not supported" })
      }).pipe(Effect.provide(layer))

      expect(control.connects).toMatchObject([{ clientId: "layer-gw", username: "gw", hasPassword: true }])
      expect(control.messages).toMatchObject([{ topic: "s/b/d/p", payload: "1", retain: true }])
    })
  )

  it.live("announces the gateway, replays retained messages after a broker restart and says goodbye", () =>
    Effect.gen(function* () {
      const healthTopic = "s/b/$gateway/main/health"
      const firstScope = yield* Scope.make()
      const first = yield* startBroker().pipe(Scope.provide(firstScope))
      const layer = MqttPublisher(
        { version: "auto", url: `mqtt://127.0.0.1:${first.port}`, clientId: "health-gw" },
        {
          reconnectDelay: fastOptions.reconnectDelay,
          publishTimeout: "3 seconds",
          health: { topic: healthTopic, online: Effect.succeed('{"status":"online"}') }
        }
      )
      const layerScope = yield* Scope.make()
      const publisher = Context.get(yield* Layer.buildWithScope(layer, layerScope), Publisher)

      // Online on connect; offline (connection lost) registered as the will.
      yield* eventually(Effect.sync(() => first.control.retained.get(healthTopic) === '{"status":"online"}'))
      expect(first.control.connects[0]?.will).toEqual({
        topic: healthTopic,
        payload: '{"status":"offline","reason":"connection-lost"}',
        qos: 1,
        retain: true
      })

      yield* publisher.publish("s/b/d/p/$meta", '{"unit":"°C"}', { retain: true })
      yield* publisher.publish("s/b/d/p", '{"value":1}')

      // A broker restart loses retained state; the publisher restores it, and only it.
      yield* Scope.close(firstScope, Exit.void)
      const second = yield* startBroker(makeBrokerControl(), first.port)
      yield* eventually(Effect.sync(() => second.control.retained.size === 2))
      expect(Object.fromEntries(second.control.retained)).toEqual({
        [healthTopic]: '{"status":"online"}',
        "s/b/d/p/$meta": '{"unit":"°C"}'
      })
      expect(second.control.messages.map((m) => m.topic)).not.toContain("s/b/d/p")

      yield* Scope.close(layerScope, Exit.void)
      expect(second.control.retained.get(healthTopic)).toBe('{"status":"offline","reason":"shutdown"}')
      yield* eventually(Effect.sync(() => second.control.cleanDisconnects === 1))
    })
  )

  it.live("replays every retained message the broker accepts, even when it refuses one", () =>
    Effect.gen(function* () {
      const firstScope = yield* Scope.make()
      const first = yield* startBroker().pipe(Scope.provide(firstScope))
      const layer = MqttPublisher(
        { version: "auto", url: `mqtt://127.0.0.1:${first.port}`, clientId: "replay-gw" },
        { reconnectDelay: fastOptions.reconnectDelay, publishTimeout: "3 seconds" }
      )
      const publisher = Context.get(yield* Layer.build(layer), Publisher)
      const topics = ["s/b/d/a/$meta", "s/b/d/b/$meta", "s/b/d/c/$meta"]
      yield* Effect.forEach(topics, (topic) => publisher.publish(topic, "{}", { retain: true }), { discard: true })

      yield* Scope.close(firstScope, Exit.void)
      const control = makeBrokerControl()
      control.refusedTopics.add("s/b/d/a/$meta")
      yield* startBroker(control, first.port)
      yield* eventually(Effect.sync(() => control.retained.size === 2))
      expect([...control.retained.keys()].toSorted()).toEqual(["s/b/d/b/$meta", "s/b/d/c/$meta"])
    })
  )

  it.effect("fails to build without the password variable, and says which one and where it goes", () =>
    Effect.gen(function* () {
      const layer = MqttPublisher({
        version: "auto",
        url: "mqtt://127.0.0.1",
        passwordEnv: "TEST_MISSING_PASSWORD"
      }).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))))
      const error = yield* Effect.flip(Layer.build(layer))
      expect(error._tag).toBe("MqttSettingsError")
      expect(error.message).toContain("TEST_MISSING_PASSWORD is not set")
      expect(error.message).toContain("ot-gateway.env (TEST_MISSING_PASSWORD=...)")
    })
  )
})
