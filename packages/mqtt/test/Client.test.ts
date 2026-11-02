/**
 * The client and publisher over real TCP, against the in-process test broker.
 */
import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { mqttConnected, mqttConnects, Publisher, withMetricAttributes } from "@plenum/core"
import { ConfigProvider, Effect, Exit, Layer, Metric, Redacted, Scope } from "effect"
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
        { clientId: "test-gw", username: "gw", hasPassword: true, cleanStart: true }
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

  it.live("fails a publish whose PUBACK never comes, or refuses the message", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startBroker()
      const client = yield* clientOn(port, { publishTimeout: "200 millis" })
      yield* connectedClient(client)

      control.ackPublishes = false
      const timedOut = yield* Effect.flip(client.publish("t", "x"))
      expect(timedOut).toMatchObject({ _tag: "MqttPublishError", topic: "t", message: "no PUBACK in time" })

      control.ackPublishes = true
      control.pubackReason = 0x87
      const refused = yield* Effect.flip(client.publish("t", "x"))
      expect(refused.message).toContain("refused the message: reason 0x87")
    })
  )

  it.live("rejects invalid topic names without sending", () =>
    Effect.gen(function* () {
      const { port, control } = yield* startBroker()
      const client = yield* clientOn(port)
      expect((yield* Effect.flip(client.publish("s/+/x", "x"))).message).toBe("topic contains a wildcard")
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

  it.live(
    "drops a broker that stops answering pings, then reconnects",
    () =>
      Effect.gen(function* () {
        const control = makeBrokerControl()
        control.answerPings = false
        const { port } = yield* startBroker(control)
        const client = yield* clientOn(port, { keepAliveSeconds: 1 })
        yield* connectedClient(client)
        // Silence is noticed after 1.5 keep alives (checked every half keep alive), then the client dials again.
        yield* eventually(
          Effect.sync(() => control.connects.length >= 2),
          5000
        )
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
        { url: `mqtt://127.0.0.1:${port}`, clientId: "layer-gw", username: "gw", passwordEnv: "TEST_MQTT_PASSWORD" },
        { reconnectDelay: fastOptions.reconnectDelay }
      ).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ TEST_MQTT_PASSWORD: "pw" }))))

      yield* Effect.gen(function* () {
        const publisher = yield* Publisher
        yield* publisher.publish("s/b/d/p", "1", { retain: true })
        const error = yield* Effect.flip(publisher.publish("s/b/d/p", "1", { qos: 2 }))
        expect(error).toMatchObject({ _tag: "PublishError", message: "QoS 2 is not supported" })
      }).pipe(Effect.provide(layer))

      expect(control.connects).toMatchObject([{ clientId: "layer-gw", username: "gw", hasPassword: true }])
      expect(control.messages).toMatchObject([{ topic: "s/b/d/p", payload: "1", retain: true }])
    })
  )

  it.effect("fails to build without the password variable", () =>
    Effect.gen(function* () {
      const layer = MqttPublisher({ url: "mqtt://127.0.0.1", passwordEnv: "TEST_MISSING_PASSWORD" }).pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
      )
      const error = yield* Effect.flip(Layer.build(layer))
      expect(error._tag).toBe("ConfigError")
    })
  )
})
