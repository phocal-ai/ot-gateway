/**
 * The status page's data: what the snapshot keeps, and the API served over
 * real HTTP and read back with the same typed client the page uses.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { OtGatewayApi } from "@ot-gateway/api"
import {
  bufferDrained,
  bufferDropped,
  bufferWritten,
  makeHealthRegistry,
  mqttConnects,
  parseConfig,
  publishFailures,
  valuesPublished,
  withMetricAttributes
} from "@ot-gateway/core"
import { openHistory } from "@ot-gateway/history"
import { Clock, Effect, FileSystem, Fiber, Layer, Metric, Schedule } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { get } from "node:http"
import { createServer } from "node:net"
import type { HostSnapshot } from "../src/Host.ts"
import { configView } from "../src/ConfigView.ts"
import { historyHandler, makeStatusState, serveStatus } from "../src/Status.ts"
import { GatewayEvents, gatewayEventsLayer, makeGatewayEvents } from "../src/Events.ts"

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

/**
 * `ask` again every 50 ms until `done` accepts its answer, for 5 s at most: a server that is still starting, or a
 * history that has not flushed yet under load, is waited for rather than slept past.
 */
const eventually = <A, E, R>(ask: Effect.Effect<A, E, R>, done: (answer: A) => boolean) =>
  ask.pipe(
    Effect.filterOrFail(done),
    Effect.retry({ schedule: Schedule.spaced("50 millis") }),
    Effect.timeout("5 seconds")
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

/** GET /api/status with the Host header set to `host`, or sent without one. */
const responseFor = (port: number, host: string | undefined) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = get(
          {
            host: "127.0.0.1",
            port,
            path: "/api/status",
            setHost: false,
            headers: host === undefined ? {} : { host }
          },
          (response) => {
            let body = ""
            response.setEncoding("utf8")
            response.on("data", (chunk: string) => (body += chunk))
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }))
          }
        )
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

const pointOf = (snapshot: { readonly devices: ReadonlyArray<{ readonly points: ReadonlyArray<unknown> }> }) =>
  snapshot.devices[0]?.points[0]

describe("status", () => {
  it.effect("adds up the broker's connects and publishes over devices and outcomes, and keeps its last terms", () =>
    Effect.gen(function* () {
      const parsed = yield* parseConfig(
        JSON.stringify({ site: "broker-site", building: "b", mqtt: { url: "mqtt://broker" }, devices: [] })
      )
      const state = makeStatusState(parsed, makeHealthRegistry([]), 0)
      yield* Effect.gen(function* () {
        yield* Metric.update(Metric.withAttributes(mqttConnects, { outcome: "ok" }), 2)
        yield* Metric.update(Metric.withAttributes(mqttConnects, { outcome: "failed" }), 3)
        yield* Metric.update(Metric.withAttributes(mqttConnects, { outcome: "rejected" }), 1)
        yield* Metric.update(Metric.withAttributes(valuesPublished, { device: "a" }), 10)
        yield* Metric.update(Metric.withAttributes(valuesPublished, { device: "b" }), 5)
        yield* Metric.update(publishFailures, 4)
      }).pipe(withMetricAttributes({ site: "broker-site", building: "b" }))
      const connection = {
        protocolVersion: "5",
        maximumQoS: 1,
        retainAvailable: true,
        keepAliveSeconds: 30,
        receiveMaximum: 100
      } as const
      state.recordBrokerConnection(1_234, connection)
      expect((yield* state.snapshot("none")).broker).toEqual({
        url: "mqtt://broker",
        connected: false,
        connectedAt: 1_234,
        connection,
        connects: 2,
        failedConnects: 4,
        published: 15,
        publishFailures: 4
      })
    })
  )

  it.effect("says since when the broker is away and why, from the first failure of an outage until it is back", () =>
    Effect.gen(function* () {
      const parsed = yield* parseConfig(
        JSON.stringify({ site: "away-site", building: "b", mqtt: { url: "mqtt://broker" }, devices: [] })
      )
      const state = makeStatusState(parsed, makeHealthRegistry([]), 100)
      // Never connected: away since the gateway started.
      state.recordBrokerFailure(150, "could not connect: connection refused by 10.0.0.5:1883")
      expect((yield* state.snapshot("none")).broker).toMatchObject({
        connected: false,
        disconnectedSince: 100,
        lastError: "could not connect: connection refused by 10.0.0.5:1883"
      })
      const connection = {
        protocolVersion: "5",
        maximumQoS: 1,
        retainAvailable: true,
        keepAliveSeconds: 30,
        receiveMaximum: 100
      } as const
      state.recordBrokerConnection(200, connection)
      expect((yield* state.snapshot("none")).broker).not.toHaveProperty("disconnectedSince")
      // Lost later: away since then, whatever the redials say after.
      state.recordBrokerFailure(300, "connection closed by the peer")
      state.recordBrokerFailure(315, "could not connect: connection refused by 10.0.0.5:1883")
      expect((yield* state.snapshot("none")).broker).toMatchObject({
        disconnectedSince: 300,
        lastError: "could not connect: connection refused by 10.0.0.5:1883"
      })
    })
  )

  it.effect("shows since when a device fails, why in the driver's words, and how many cycles in a row", () =>
    Effect.gen(function* () {
      const parsed = yield* config
      const health = makeHealthRegistry(["meter"])
      const state = makeStatusState(parsed, health, 0)
      health.recordSuccess("meter", 1_000)
      health.recordFailure("meter", { reason: "timeout", message: "no response to 2 item(s) within 3s", at: 2_000 })
      health.recordFailure("meter", { reason: "timeout", message: "no response to 2 item(s) within 3s", at: 7_000 })
      const [device] = (yield* state.snapshot("none")).devices
      expect(device).toMatchObject({
        status: "failing",
        reason: "timeout",
        failingSince: 2_000,
        lastError: "no response to 2 item(s) within 3s",
        failures: 2,
        lastSuccess: 1_000
      })
      health.recordSuccess("meter", 8_000)
      const [recovered] = (yield* state.snapshot("none")).devices
      expect(recovered).not.toHaveProperty("failingSince")
      expect(recovered).not.toHaveProperty("lastError")
    })
  )

  it.effect("shows the config without points or secrets, and BACnet settings only when a device uses them", () =>
    Effect.gen(function* () {
      const view = configView(yield* config)
      expect(view.sections.map((section) => section.key)).toEqual(["gateway", "mqtt", "status"])
      expect(view.sections[0]?.entries).toEqual([
        { key: "site", value: "s" },
        { key: "building", value: "b" },
        { key: "id", value: "main" },
        { key: "healthIntervalMs", value: 60_000 }
      ])
      expect(view.sections[1]?.entries).toContainEqual({ key: "url", value: "mqtt://broker" })
      expect(view.devices).toHaveLength(1)
      expect(view.devices[0]).toMatchObject({ id: "meter", protocol: "modbus-tcp", pointCount: 2 })
      const keys = view.devices[0]?.entries.map((entry) => entry.key) ?? []
      expect(keys).toContain("host")
      expect(keys).not.toContain("points")
      expect(keys).not.toContain("id")
      expect(view.devices[0]?.entries).toContainEqual({ key: "publish", value: "every read" })
    })
  )

  it.effect("says how full the buffer is and adds up what it dropped, whatever the reason", () =>
    Effect.gen(function* () {
      const buffered = yield* parseConfig(
        JSON.stringify({
          site: "s",
          building: "b",
          mqtt: { url: "mqtt://localhost:1883", clientId: "status-buffer-test" },
          buffer: { path: "./buffer.sqlite", maxRows: 500 },
          devices: []
        })
      )
      const state = makeStatusState(buffered, makeHealthRegistry([]), 0)
      expect((yield* state.snapshot()).buffer).toEqual({
        path: "./buffer.sqlite",
        rows: 0,
        maxRows: 500,
        dropped: 0,
        written: 0,
        delivered: 0,
        droppedBy: { overflow: 0, rejected: 0, unreadable: 0, undeliverable: 0, lost: 0 },
        failures: 0,
        disabled: false
      })
      // As the buffer counts them: under the gateway's site and building, one series per reason.
      yield* Effect.gen(function* () {
        yield* Metric.update(Metric.withAttributes(bufferDropped, { reason: "overflow" }), 5)
        yield* Metric.update(Metric.withAttributes(bufferDropped, { reason: "rejected" }), 2)
        yield* Metric.update(bufferWritten, 40)
        yield* Metric.update(bufferDrained, 30)
      }).pipe(withMetricAttributes({ site: "s", building: "b" }))
      // Another gateway's counts in the same process are not this one's.
      yield* Metric.update(bufferWritten, 1000).pipe(withMetricAttributes({ site: "other", building: "b" }))
      const buffer = (yield* state.snapshot()).buffer
      expect(buffer).toMatchObject({ dropped: 7, written: 40, delivered: 30 })
      expect(buffer?.droppedBy).toMatchObject({ overflow: 5, rejected: 2 })
    })
  )

  it.effect("keeps each point's last value and the newest 50 commands", () =>
    Effect.gen(function* () {
      const parsed = yield* config
      const health = makeHealthRegistry(["meter"])
      health.recordSuccess("meter", 1_000)
      const state = makeStatusState(parsed, health, 500)
      // An undecodable payload shows as no value, not an error; the next good one replaces it.
      state.recordPublish("s/b/meter/power", "not json", { retained: false, at: 1 })
      expect((yield* state.snapshot()).devices[0]?.points[0]?.value).toBeUndefined()
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

      const snapshot = yield* state.snapshot()
      expect(snapshot.devices).toEqual([
        {
          id: "meter",
          protocol: "modbus-tcp",
          status: "ok",
          pollIntervalMs: 5000,
          lastSuccess: 1_000,
          pointCount: 2,
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
      expect(snapshot.broker).toEqual({
        url: "mqtt://broker",
        connected: false,
        connects: 0,
        failedConnects: 0,
        published: 0,
        publishFailures: 0
      })
      // No host monitor, no host section.
      expect(snapshot).not.toHaveProperty("host")
      // Without points: the health and the count, not a value per point.
      const overview = yield* state.snapshot("none")
      expect(overview.devices[0]).toMatchObject({ id: "meter", status: "ok", pointCount: 2, points: [] })
    })
  )

  it.effect("gives the last reads of the points asked for, in that order, and only configured ones", () =>
    Effect.gen(function* () {
      const state = makeStatusState(yield* config, makeHealthRegistry(["meter"]), 500)
      state.reads.record("meter", "power", 4.5, 800)
      expect(yield* state.values("meter/setpoint,meter/power,meter/nope,other/power,,meter")).toEqual({
        readings: [
          { device: "meter", point: "setpoint" },
          { device: "meter", point: "power", value: 4.5, ts: 800 }
        ]
      })
      const tooMany = Array.from({ length: 501 }, () => "meter/power").join(",")
      expect((yield* Effect.flip(state.values(tooMany)))._tag).toBe("ValuesQueryInvalid")
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

  it.effect("shows a point's last read before anything is published, and prefers it to what was", () =>
    Effect.gen(function* () {
      const state = makeStatusState(yield* config, makeHealthRegistry(["meter"]), 500)
      // An aggregate's first message comes at the end of its window; the read is there now.
      state.reads.record("meter", "power", 4.2, 20)
      expect(pointOf(yield* state.snapshot())).toMatchObject({ value: 4.2, ts: 20 })
      // A change or deadband point publishes less often than it is read.
      state.recordPublish("s/b/meter/power", '{"value":4.2,"ts":20}', { retained: false, at: 20 })
      state.reads.record("meter", "power", 4.25, 25)
      expect(pointOf(yield* state.snapshot())).toMatchObject({ value: 4.25, ts: 25 })
    })
  )

  it.effect("forgets a topic cleared with an empty retained message", () =>
    Effect.gen(function* () {
      const state = makeStatusState(yield* config, makeHealthRegistry(["meter"]), 500)
      state.recordPublish("s/b/meter/old/$meta", '{"name":"Old"}', { retained: true, at: 10 })
      state.recordPublish("s/b/meter/old/$meta", "", { retained: true, at: 11 })
      expect((yield* state.messages).messages).toEqual([])
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

  it.effect("ignores a topic longer than any the gateway publishes", () =>
    Effect.gen(function* () {
      const state = makeStatusState(yield* config, makeHealthRegistry(["meter"]), 500)
      // Below the topic cap: not kept.
      state.recordPublish(`s/b/${"x".repeat(600)}/p/$set/result`, "{}", { retained: false, at: 1 })
      expect((yield* state.messages).messages).toEqual([])
      for (let index = 0; index < 2_000; index++) {
        state.recordPublish(`s/b/meter/p${index}`, "x", { retained: false, at: index })
      }
      // At the cap: not counted as a dropped topic either.
      state.recordPublish(`s/b/meter/p0/${"y".repeat(600)}`, "{}", { retained: false, at: 3_001 })
      const { messages, droppedTopics } = yield* state.messages
      expect(messages).toHaveLength(2_000)
      expect(messages.every((message) => message.topic.length <= 512)).toBe(true)
      expect(droppedTopics).toBe(0)
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
      expect(yield* state.snapshot()).not.toHaveProperty("host")
      sample = {
        memoryBytes: 1e8,
        heapBytes: 4e7,
        cpuPercent: 2.5,
        eventLoopLagMs: { p99: 3, max: 9 },
        clockSteps: 0,
        temperatureC: 55
      }
      expect((yield* state.snapshot()).host).toEqual({ version: "v1.2.3", node: process.versions.node, ...sample })
    })
  )

  it.live("serves the snapshot on /api/status, read back with the page's typed client", () =>
    Effect.gen(function* () {
      const parsed = yield* config
      const port = yield* freePort
      const state = makeStatusState(parsed, makeHealthRegistry(["meter"]), 500)
      state.recordPublish("s/b/meter/power", '{"value":3,"ts":700}', { retained: false, at: 1 })
      const ring = yield* Effect.map(Clock.clockWith(Effect.succeed), (clock) => makeGatewayEvents(clock, 3))
      ring.started("v1", 1)
      ring.brokerDisconnected("connection closed by the peer")
      ring.brokerConnected(12)
      ring.bufferDrained()
      const server = yield* serveStatus({ bindAddress: "127.0.0.1", port, webRoot: "/nonexistent" }, state).pipe(
        Effect.provide([NodeServices.layer, Layer.succeed(GatewayEvents, ring)]),
        Effect.forkChild
      )
      yield* Effect.sleep("300 millis")
      const client = yield* HttpApiClient.make(OtGatewayApi, { baseUrl: `http://127.0.0.1:${port}` })
      // The ring holds 3: the start was let go, and `after` gives what is newer than an id.
      const log = yield* client.status.events({ query: {} })
      expect(log.events.map((event) => event.type)).toEqual([
        "broker-disconnected",
        "broker-connected",
        "buffer-drained"
      ])
      expect(log).toMatchObject({ capacity: 3, dropped: 1 })
      expect(log.events[1]).toMatchObject({ id: 3, buffered: 12 })
      const newer = yield* client.status.events({ query: { after: 3 } })
      expect(newer.events.map((event) => event.id)).toEqual([4])
      const future = yield* client.status.events({ query: { since: Date.now() + 60_000 } })
      expect(future.events).toEqual([])
      const status = yield* client.status.status({ query: {} })
      expect(status.devices[0]?.points[0]?.value).toBe(3)
      expect((yield* client.status.status({ query: { points: "none" } })).devices[0]?.points).toEqual([])
      const { readings } = yield* client.status.values({ query: { points: "meter/power" } })
      expect(readings).toEqual([{ device: "meter", point: "power", value: 3, ts: 700 }])
      const { messages } = yield* client.status.messages()
      expect(messages.map((message) => message.topic)).toEqual(["s/b/meter/power"])
      const { points } = yield* client.status.points()
      expect(points.map((point) => [point.topic, point.source])).toEqual([
        ["s/b/meter/power", "holding 0 · float32 ABCD"],
        ["s/b/meter/setpoint", "holding 2 · float32 ABCD"]
      ])
      const settings = yield* client.status.config()
      expect(settings.devices.map((device) => [device.id, device.pointCount])).toEqual([["meter", 2]])
      // Without a built web app, the root says so instead of failing.
      const root = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/`).then((response) => response.text()))
      expect(root).toContain("/api/status")
      // Another host name on a loopback-bound page is a DNS-rebinding attempt: refused.
      expect(yield* statusCodeFor(port, `rebind.example:${port}`)).toBe(421)
      expect(yield* statusCodeFor(port, `localhost:${port}`)).toBe(200)
      yield* Fiber.interrupt(server)
    }).pipe(Effect.provide(FetchHttpClient.layer))
  )

  it.live("on loopback, answers a loopback host name on any port, and refuses other names", () =>
    Effect.gen(function* () {
      const parsed = yield* config
      const port = yield* freePort
      const state = makeStatusState(parsed, makeHealthRegistry(["meter"]), 500)
      const server = yield* serveStatus({ bindAddress: "127.0.0.1", port, webRoot: "/nonexistent" }, state).pipe(
        Effect.provide([NodeServices.layer, gatewayEventsLayer()]),
        Effect.forkChild
      )
      yield* Effect.sleep("300 millis")
      // An SSH tunnel from another local port keeps the loopback name but not the port.
      for (const host of ["127.0.0.1:18080", "localhost:3000", "[::1]:9", "localhost"]) {
        expect([host, (yield* responseFor(port, host)).status]).toEqual([host, 200])
      }
      const misdirected =
        `Misdirected request: open the status page as http://127.0.0.1:${port} or ` +
        `http://localhost:${port} (an SSH tunnel to it works on any local port)`
      const refused = [
        `evil.example:${port}`,
        `127.0.0.1.evil.example:${port}`,
        "localhost.evil.example",
        "127.0.0.1:abc",
        "127.0.0.1:0",
        "127.0.0.1:70000",
        "127.0.0.1@evil.example",
        ""
      ]
      for (const host of refused) {
        expect({ host, ...(yield* responseFor(port, host)) }).toEqual({ host, status: 421, body: misdirected })
      }
      // Without a Host header, Node's HTTP server refuses an HTTP/1.1 request before the page sees it.
      expect((yield* responseFor(port, undefined)).status).toBe(400)
      yield* Fiber.interrupt(server)
    })
  )

  it.live("serves a point's history on /api/history, and says why when it cannot", () =>
    Effect.gen(function* () {
      const parsed = yield* config
      const port = yield* freePort
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ot-gateway-status-history-" })
      const history = yield* openHistory({ path: `${dir}/history.sqlite`, retentionDays: 7 }, { flushEveryMs: 50 })
      const now = Date.now()
      history.sink.record("meter", "power", 3, now - 2_000)
      history.sink.record("meter", "power", 5, now - 1_000)
      const state = makeStatusState(parsed, makeHealthRegistry(["meter"]), 500)
      const server = yield* serveStatus(
        { bindAddress: "127.0.0.1", port, webRoot: "/nonexistent" },
        state,
        historyHandler(parsed, history)
      ).pipe(Effect.forkChild)
      const client = yield* HttpApiClient.make(OtGatewayApi, { baseUrl: `http://127.0.0.1:${port}` })
      // Until the server is up and the history has flushed both readings (every 50 ms, later under load).
      const series = yield* eventually(
        client.status.history({ query: { device: "meter", point: "power", buckets: 1 } }),
        (answer) => answer.buckets.reduce((sum, bucket) => sum + bucket.count, 0) === 2
      )
      // The last hour in one bucket: an hour-wide step, so from the minute rollups.
      expect(series.resolution).toBe("minute")
      expect(series.buckets).toEqual([expect.objectContaining({ min: 3, max: 5, avg: 4, count: 2 })])
      const unknown = yield* Effect.flip(client.status.history({ query: { device: "meter", point: "nope" } }))
      expect(unknown._tag).toBe("HistoryQueryInvalid")
      const backwards = yield* Effect.flip(
        client.status.history({ query: { device: "meter", point: "power", from: now, to: now - 1 } })
      )
      expect(backwards._tag).toBe("HistoryQueryInvalid")
      yield* Fiber.interrupt(server)

      // Without a history block, the endpoint answers 404 with the reason.
      const bare = yield* serveStatus(
        { bindAddress: "127.0.0.1", port, webRoot: "/nonexistent" },
        state,
        historyHandler(parsed, undefined)
      ).pipe(Effect.forkChild)
      const none = yield* eventually(
        Effect.flip(client.status.history({ query: { device: "meter", point: "power" } })),
        (error) => error._tag === "HistoryUnavailable"
      )
      expect(none._tag).toBe("HistoryUnavailable")
      yield* Fiber.interrupt(bare)
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeServices.layer, gatewayEventsLayer()]))
  )
})
