/**
 * The MQTT client and the whole gateway against real brokers (Mosquitto,
 * EMQX), not just our test broker: a spec misread the same way on both sides
 * of our own tests would pass them and fail here.
 *
 *   scripts/interop.sh            # starts the brokers in Docker and runs this
 *
 * Runs only with OT_GATEWAY_INTEROP=1; the brokers are in OT_GATEWAY_INTEROP_BROKERS
 * (comma-separated mqtt:// URLs).
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { makeRegisterBank, makeSimulatorControl, serveModbus, setPointValue } from "@ot-gateway/modbus"
import { encodeConnect, type InboundMessage, makeMqttClient, parseBrokerUrl } from "@ot-gateway/mqtt"
import { Effect, Fiber, Schema } from "effect"
import { runGateway } from "../../src/Gateway.ts"

const enabled = process.env["OT_GATEWAY_INTEROP"] === "1"
const brokers = (process.env["OT_GATEWAY_INTEROP_BROKERS"] ?? "mqtt://127.0.0.1:1883").split(",")

/** Wait for `condition`, polling, up to `timeoutMs`. */
const waitFor = (what: string, condition: () => boolean, timeoutMs = 10_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error(`timed out waiting for ${what}`))
      yield* Effect.sleep("50 millis")
    }
  })

/** A client like an application's: subscribes to `filters` and keeps what arrives. */
const appClient = Effect.fnUntraced(function* (
  url: string,
  clientId: string,
  filters: ReadonlyArray<{ readonly filter: string; readonly retainAsPublished?: boolean }>
) {
  const address = yield* parseBrokerUrl(url)
  const socket = yield* NodeSocket.makeNet({ host: address.host, port: address.port, openTimeout: "3 seconds" })
  const received: Array<InboundMessage> = []
  const client = yield* makeMqttClient(socket, {
    clientId,
    keepAliveSeconds: 5,
    subscriptions: filters.map(({ filter, retainAsPublished }) => ({
      filter,
      qos: 1 as const,
      ...(retainAsPublished === undefined ? {} : { retainAsPublished })
    })),
    onMessage: (message) => Effect.sync(() => received.push(message))
  })
  yield* waitFor(`${clientId} to connect`, () => true)
  yield* Effect.sleep("500 millis")
  return { client, received }
})

const unique = (name: string) => `ot-gateway-interop/${name}/${Math.random().toString(36).slice(2, 8)}`

const CommandResult = Schema.fromJsonString(
  Schema.Struct({ status: Schema.String, reason: Schema.optionalKey(Schema.String) })
)
const decodeResult = Schema.decodeUnknownSync(CommandResult)

describe.runIf(enabled)("interop: MQTT brokers", () => {
  for (const url of brokers) {
    describe(`broker ${url}`, () => {
      it.live(
        "delivers QoS 1, keeps retained messages, passes request/response properties through",
        () =>
          Effect.gen(function* () {
            const base = unique("basics")
            const app = yield* appClient(url, `${base.replaceAll("/", "-")}-app`, [
              { filter: `${base}/#`, retainAsPublished: true }
            ])
            const sender = yield* appClient(url, `${base.replaceAll("/", "-")}-sender`, [])
            yield* sender.client.publish(`${base}/live`, "1")
            yield* sender.client.publish(`${base}/kept`, "2", { retain: true })
            yield* sender.client.publish(`${base}/request`, "3", { correlationData: Uint8Array.of(9, 8) })
            yield* waitFor("three messages", () => app.received.length >= 3)
            const byTopic = Object.fromEntries(
              app.received.map((message) => [message.topic.slice(base.length), message])
            )
            expect(byTopic["/live"]?.retain).toBe(false)
            // Retain As Published: a live retained message keeps its flag.
            expect(byTopic["/kept"]?.retain).toBe(true)
            expect(byTopic["/request"]?.correlationData).toEqual(Uint8Array.of(9, 8))

            // A new subscriber gets the retained message, flagged as retained.
            const late = yield* appClient(url, `${base.replaceAll("/", "-")}-late`, [{ filter: `${base}/kept` }])
            yield* waitFor("the retained message", () => late.received.length >= 1)
            expect(late.received[0]?.retain).toBe(true)
            yield* sender.client.publish(`${base}/kept`, "", { retain: true })
          }).pipe(Effect.scoped),
        30_000
      )

      it.live(
        "keeps an idle connection alive with pings, and publishes the will of a client that vanishes",
        () =>
          Effect.gen(function* () {
            const base = unique("will")
            const address = yield* parseBrokerUrl(url)
            const watcher = yield* appClient(url, `${base.replaceAll("/", "-")}-watcher`, [{ filter: `${base}/#` }])

            const idle = yield* NodeSocket.makeNet({ host: address.host, port: address.port, openTimeout: "3 seconds" })
            const client = yield* makeMqttClient(idle, {
              clientId: `${base.replaceAll("/", "-")}-idle`,
              keepAliveSeconds: 2
            })
            yield* Effect.sleep("7 seconds")
            expect(yield* client.isConnected).toBe(true)

            // A raw connection with a will that closes without DISCONNECT, as a crashed gateway would.
            yield* Effect.scoped(
              Effect.gen(function* () {
                const raw = yield* NodeSocket.makeNet({
                  host: address.host,
                  port: address.port,
                  openTimeout: "3 seconds"
                })
                const writer = yield* raw.writer
                yield* raw.reader
                yield* writer.write(
                  encodeConnect({
                    clientId: `${base.replaceAll("/", "-")}-vanishing`,
                    keepAliveSeconds: 30,
                    cleanStart: true,
                    sessionExpirySeconds: 0,
                    will: { topic: `${base}/health`, payload: "offline", qos: 1, retain: true }
                  })
                )
                yield* Effect.sleep("500 millis")
              })
            )
            yield* waitFor("the will", () => watcher.received.some((message) => message.payload === "offline"))
          }).pipe(Effect.scoped),
        30_000
      )

      it.live(
        "runs the gateway end to end: values, health, and commands with their results",
        () =>
          Effect.gen(function* () {
            const site = `interop${Math.random().toString(36).slice(2, 8)}`
            // An independent port per broker run, so tests against two brokers never share a device.
            const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
            const port = "port" in server.address ? server.address.port : 0
            const config = yield* parseConfig(
              JSON.stringify({
                site,
                building: "b1",
                healthIntervalMs: 1_000,
                mqtt: { url, clientId: `${site}-gateway` },
                devices: [
                  {
                    protocol: "modbus-tcp",
                    id: "meter",
                    host: "127.0.0.1",
                    port,
                    pollIntervalMs: 500,
                    points: [
                      { id: "power", name: "Power", table: "holding", address: 100, dataType: "float32" },
                      {
                        id: "setpoint",
                        name: "Setpoint",
                        table: "holding",
                        address: 200,
                        dataType: "float32",
                        writable: true,
                        limits: { min: 15, max: 25 }
                      }
                    ]
                  }
                ]
              })
            )
            const device = config.devices[0]
            if (device?.protocol !== "modbus-tcp") return yield* Effect.die(new Error("no device"))
            const bank = makeRegisterBank()
            for (const point of device.points) setPointValue(bank, point, 20)
            const control = makeSimulatorControl()
            yield* serveModbus(server, bank, control).pipe(Effect.forkScoped)

            const app = yield* appClient(url, `${site}-app`, [{ filter: `${site}/#` }])
            const gateway = yield* runGateway(config).pipe(Effect.provide(NodeServices.layer), Effect.forkScoped)
            const health = `${site}/b1/$gateway/main/health`
            yield* waitFor(
              "a value and an online health message",
              () =>
                app.received.some((message) => message.topic === `${site}/b1/meter/power`) &&
                app.received.some((message) => message.topic === health && message.payload.includes('"online"'))
            )

            const set = `${site}/b1/meter/setpoint/$set`
            yield* app.client.publish(set, JSON.stringify({ value: 21.5 }), { correlationData: Uint8Array.of(1) })
            yield* app.client.publish(set, JSON.stringify({ value: 99 }), { correlationData: Uint8Array.of(2) })
            yield* app.client.publish(set, JSON.stringify({ value: 22 }), {
              retain: true,
              correlationData: Uint8Array.of(3)
            })
            const results = () =>
              app.received
                .filter((message) => message.topic === `${set}/result`)
                .map((message) => `${message.correlationData?.[0]} ${decodeResult(message.payload).status}`)
            yield* waitFor("three results", () => results().length >= 3)
            expect(results().toSorted()).toEqual(["1 written", "2 rejected", "3 rejected"])
            expect(control.writes).toHaveLength(1)
            yield* app.client.publish(set, "", { retain: true })

            yield* Fiber.interrupt(gateway)
            yield* waitFor("offline at shutdown", () =>
              app.received.some((message) => message.topic === health && message.payload.includes('"shutdown"'))
            )
          }).pipe(Effect.scoped),
        60_000
      )
    })
  }
})
