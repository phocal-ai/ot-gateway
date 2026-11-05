/**
 * The status page's data: what the snapshot keeps, and the API served over
 * real HTTP and read back with the same typed client the page uses.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { OtGatewayApi } from "@ot-gateway/api"
import { makeHealthRegistry, parseConfig } from "@ot-gateway/core"
import { Effect, Fiber } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { get } from "node:http"
import { createServer } from "node:net"
import type { HostSnapshot } from "../src/Host.ts"
import { makeStatusState, serveStatus } from "../src/Status.ts"

const config = parseConfig(
  JSON.stringify({
    site: "s",
    building: "b",
    mqtt: { url: "mqtt://broker" },
    status: { webRoot: "/nonexistent" },
    devices: [
      {
        protocol: "modbus-tcp",
        id: "meter",
        host: "10.0.1.1",
        points: [
          { id: "power", name: "Power", unit: "unit:KiloW", table: "holding", address: 0, dataType: "float32" },
          {
            id: "setpoint",
            name: "Setpoint",
            table: "holding",
            address: 2,
            dataType: "float32",
            writable: true,
            limits: { min: 0, max: 10 }
          }
        ]
      }
    ]
  })
)

/** The status code of GET /api/status with the Host header set to `host`. */
const statusCodeFor = (port: number, host: string) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = get({ host: "127.0.0.1", port, path: "/api/status", headers: { host } }, (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        request.on("error", reject)
      })
  )

/** A port nothing listens on right now. */
const freePort = Effect.promise(
  () =>
    new Promise<number>((resolve) => {
      const probe = createServer()
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address()
        probe.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0))
      })
    })
)

describe("status", () => {
  it.effect("keeps each point's last value and the newest 50 commands", () =>
    Effect.gen(function* () {
      const parsed = yield* config
      const health = makeHealthRegistry(["meter"])
      health.recordSuccess("meter", 1_000)
      const state = makeStatusState(parsed, health, 500)
      // An undecodable payload shows as no value, not an error; the next good one replaces it.
      state.recordPublish("s/b/meter/power", "not json", { retained: false, at: 1 })
      expect((yield* state.snapshot).devices[0]?.points[0]?.value).toBeUndefined()
      state.recordPublish("s/b/meter/power", '{"value":12.5,"ts":900,"unit":"unit:KiloW"}', { retained: false, at: 1 })
      state.recordPublish("s/b/meter/power/$meta", '{"name":"Power"}', { retained: false, at: 1 })
      state.recordPublish("other/site/meter/power", '{"value":99,"ts":1}', { retained: false, at: 1 })
      for (let index = 0; index < 52; index++) {
        state.recordCommand(index, { device: "meter", point: "setpoint" }, { status: "written", value: index })
      }
      state.recordCommand(
        60,
        { device: "meter", point: "setpoint" },
        {
          status: "rejected",
          reason: "out-of-range",
          message: "99 is outside 0 to 10"
        }
      )

      const snapshot = yield* state.snapshot
      expect(snapshot.devices).toEqual([
        {
          id: "meter",
          protocol: "modbus-tcp",
          status: "ok",
          pollIntervalMs: 5000,
          lastSuccess: 1_000,
          points: [
            { id: "power", name: "Power", unit: "unit:KiloW", writable: false, value: 12.5, ts: 900 },
            { id: "setpoint", name: "Setpoint", writable: true }
          ]
        }
      ])
      expect(snapshot.commands).toHaveLength(50)
      expect(snapshot.commands[0]).toEqual({
        at: 60,
        device: "meter",
        point: "setpoint",
        status: "rejected",
        reason: "out-of-range"
      })
      expect(snapshot.broker).toEqual({ url: "mqtt://broker", connected: false })
      // No host monitor, no host section.
      expect(snapshot).not.toHaveProperty("host")
    })
  )

  it.effect("keeps the latest message per topic under the site and building, sorted, with retain and a count", () =>
    Effect.gen(function* () {
      const state = makeStatusState(yield* config, makeHealthRegistry(["meter"]), 500)
      state.recordPublish("s/b/meter/power/$meta", '{"name":"Power"}', { retained: true, at: 10 })
      state.recordPublish("s/b/meter/power", '{"value":1,"ts":11}', { retained: false, at: 11 })
      state.recordPublish("s/b/meter/power", '{"value":2,"ts":12}', { retained: false, at: 12 })
      state.recordPublish("s/b/$gateway/main/health", '{"status":"online"}', { retained: true, at: 13 })
      state.recordPublish("other/site/meter/power", '{"value":99,"ts":1}', { retained: false, at: 14 })
      expect(yield* state.messages).toEqual({
        messages: [
          {
            topic: "s/b/$gateway/main/health",
            payload: '{"status":"online"}',
            truncated: false,
            retained: true,
            at: 13,
            count: 1
          },
          {
            topic: "s/b/meter/power",
            payload: '{"value":2,"ts":12}',
            truncated: false,
            retained: false,
            at: 12,
            count: 2
          },
          {
            topic: "s/b/meter/power/$meta",
            payload: '{"name":"Power"}',
            truncated: false,
            retained: true,
            at: 10,
            count: 1
          }
        ],
        droppedTopics: 0
      })
    })
  )

  it.effect("bounds what it keeps: 2,000 topics, and 2,000 characters of each payload", () =>
    Effect.gen(function* () {
      const state = makeStatusState(yield* config, makeHealthRegistry(["meter"]), 500)
      for (let index = 0; index < 2_005; index++) {
        state.recordPublish(`s/b/meter/p${index}`, "x".repeat(index === 0 ? 2_500 : 1), { retained: false, at: index })
      }
      // A topic already kept is still updated once the cap is reached.
      state.recordPublish("s/b/meter/p0", "y".repeat(2_500), { retained: false, at: 9_999 })
      const { messages, droppedTopics } = yield* state.messages
      expect(messages).toHaveLength(2_000)
      expect(droppedTopics).toBe(5)
      const first = messages.find((message) => message.topic === "s/b/meter/p0")
      expect(first?.payload).toHaveLength(2_000)
      expect(first?.truncated).toBe(true)
      expect(first?.count).toBe(2)
    })
  )

  it.effect("shows the host monitor's last sample with the gateway's version", () =>
    Effect.gen(function* () {
      const parsed = yield* config
      let sample: HostSnapshot | undefined
      const state = makeStatusState(parsed, makeHealthRegistry(["meter"]), 500, {
        latest: () => sample,
        version: "v1.2.3"
      })
      expect(yield* state.snapshot).not.toHaveProperty("host")
      sample = {
        memoryBytes: 1e8,
        heapBytes: 4e7,
        cpuPercent: 2.5,
        eventLoopLagMs: { p99: 3, max: 9 },
        clockSteps: 0,
        temperatureC: 55
      }
      expect((yield* state.snapshot).host).toEqual({ version: "v1.2.3", node: process.versions.node, ...sample })
    })
  )

  it.live("serves the snapshot on /api/status, read back with the page's typed client", () =>
    Effect.gen(function* () {
      const parsed = yield* config
      const port = yield* freePort
      const state = makeStatusState(parsed, makeHealthRegistry(["meter"]), 500)
      state.recordPublish("s/b/meter/power", '{"value":3,"ts":700}', { retained: false, at: 1 })
      const server = yield* serveStatus({ bindAddress: "127.0.0.1", port, webRoot: "/nonexistent" }, state).pipe(
        Effect.provide(NodeServices.layer),
        Effect.forkChild
      )
      yield* Effect.sleep("300 millis")
      const client = yield* HttpApiClient.make(OtGatewayApi, { baseUrl: `http://127.0.0.1:${port}` })
      const status = yield* client.status.status()
      expect(status.devices[0]?.points[0]?.value).toBe(3)
      const { messages } = yield* client.status.messages()
      expect(messages.map((message) => message.topic)).toEqual(["s/b/meter/power"])
      // Without a built web app, the root says so instead of failing.
      const root = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/`).then((response) => response.text()))
      expect(root).toContain("/api/status")
      // Another host name on a loopback-bound page is a DNS-rebinding attempt: refused.
      expect(yield* statusCodeFor(port, `rebind.example:${port}`)).toBe(421)
      expect(yield* statusCodeFor(port, `localhost:${port}`)).toBe(200)
      yield* Fiber.interrupt(server)
    }).pipe(Effect.provide(FetchHttpClient.layer))
  )
})
