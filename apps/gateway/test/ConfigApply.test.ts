/**
 * A config saved from the status page runs without a restart: over real HTTP, against a gateway on an in-memory
 * network. A save the gateway cannot start is rolled back (the previous config runs, the file holds it again), a
 * value buffered before an apply still reaches the broker after it, and a write that is not the page's own is
 * refused before it gets anywhere.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { EDIT_HEADER, EDIT_HEADER_VALUE } from "@ot-gateway/api"
import { makeBacnetNetwork } from "@ot-gateway/bacnet"
import { BacnetSettings, makeMemoryNetwork, parseConfig } from "@ot-gateway/core"
import { type BrokerControl, makeBrokerControl, serveMqtt } from "@ot-gateway/mqtt"
import { Clock, Effect, Exit, Fiber, FileSystem, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { createServer } from "node:net"
import { runGateway } from "../src/Gateway.ts"
import { configFileSource } from "../src/LoadConfig.ts"

const BROKER = "10.0.0.2"

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeObject = Schema.decodeUnknownSync(JsonObject)
const decodeEvents = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ type: Schema.String })))
const decodeBacnetSettings = Schema.decodeUnknownSync(BacnetSettings)
const decodeValue = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ ts: Schema.Number })))

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

/** A BACnet device nobody answers for: enough for the gateway to open its BACnet/IP port. */
const ahu = {
  protocol: "bacnet-ip",
  id: "ahu",
  deviceInstance: 2001,
  address: "10.0.2.1",
  points: [{ id: "supply-temp", name: "Supply temperature", objectType: "analog-input", instance: 1 }]
}

const configText = (
  port: number,
  changes: {
    site?: string
    id?: string
    clientId?: string
    buffer?: string
    /** The `bacnet` block, and a BACnet device with it. */
    bacnet?: Record<string, unknown>
  }
) =>
  `${JSON.stringify(
    {
      site: changes.site ?? "s",
      building: "b",
      ...(changes.id === undefined ? {} : { id: changes.id }),
      mqtt: { url: `mqtt://${BROKER}:1883`, clientId: changes.clientId ?? "gw" },
      buffer: { path: changes.buffer ?? "./buffer.sqlite" },
      status: { port, webRoot: "/nonexistent" },
      ...(changes.bacnet === undefined ? {} : { bacnet: changes.bacnet }),
      devices: [
        {
          protocol: "simulator",
          id: "meter",
          pollIntervalMs: 1000,
          points: [{ id: "power", name: "Power", waveform: "ramp", min: 0, max: 1000, periodSeconds: 1000 }]
        },
        ...(changes.bacnet === undefined ? [] : [ahu])
      ]
    },
    null,
    2
  )}\n`

/** Let real I/O (sockets, SQLite, HTTP) and virtual time move on together, `steps` half-seconds of the latter. */
const settle = (steps: number) =>
  Effect.gen(function* () {
    for (let step = 0; step < steps; step++) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2)))
      yield* TestClock.adjust("500 millis")
    }
  })

/** Run `request` (an HTTP call into the gateway) while virtual time moves on, as the gateway may wait on it. */
const whileTimePasses = <A>(request: () => Promise<A>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.promise(request).pipe(Effect.forkScoped)
    for (let step = 0; step < 200 && fiber.pollUnsafe() === undefined; step++) yield* settle(1)
    return yield* Fiber.join(fiber)
  })

interface Reply {
  readonly status: number
  readonly body: Record<string, unknown>
}

const call = (port: number, method: string, path: string, init: { body?: unknown; headers?: Record<string, string> }) =>
  whileTimePasses(async (): Promise<Reply> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    })
    const text = await response.text()
    return { status: response.status, body: text === "" ? {} : decodeObject(text) }
  })

const pageHeaders = (port: number) => ({ origin: `http://127.0.0.1:${port}`, [EDIT_HEADER]: EDIT_HEADER_VALUE })

/** A gateway started from `ot-gateway.json` in a folder of its own, with its status page on a free port. */
const startGateway = (options: { readonly brokerUp: boolean; readonly bacnet?: Record<string, unknown> }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const folder = yield* fs.makeTempDirectoryScoped()
    const path = `${folder}/ot-gateway.json`
    const port = yield* freePort
    yield* fs.writeFileString(path, configText(port, options.bacnet === undefined ? {} : { bacnet: options.bacnet }))
    const network = makeMemoryNetwork()
    const control = makeBrokerControl()
    const startBroker = Effect.gen(function* () {
      const server = yield* network.listen(BROKER, 1883)
      yield* serveMqtt(server, control).pipe(Effect.forkScoped)
    })
    if (options.brokerUp) yield* startBroker
    const source = yield* configFileSource(path)
    const config = source.resolve(yield* parseConfig(yield* fs.readFileString(path)))
    const running = yield* runGateway(config, { network: network.host("10.0.0.1"), configFile: source }).pipe(
      Effect.forkScoped
    )
    yield* settle(10)
    return { fs, folder, path, port, control, startBroker, running, network }
  })

const read = (port: number) => call(port, "GET", "/api/config/file", {})

const save = (port: number, text: string, etag: unknown) =>
  call(port, "PUT", "/api/config/file", { body: { text, etag }, headers: pageHeaders(port) })

const eventTypes = (port: number) =>
  Effect.map(call(port, "GET", "/api/events", {}), (reply) =>
    decodeEvents(reply.body["events"]).map((event) => event.type)
  )

const topicsUnder = (control: BrokerControl, prefix: string) =>
  control.messages.filter((message) => message.topic.startsWith(prefix))

describe("applying a config saved from the status page", () => {
  it.effect("runs the saved config without a restart, and keeps the previous file as .bak", () =>
    Effect.gen(function* () {
      const { fs, path, port, control, running } = yield* startGateway({ brokerUp: true })
      const edit = yield* call(port, "GET", "/api/config/edit", {})
      expect(edit.body).toMatchObject({ enabled: true, auth: "none", path })
      const before = yield* read(port)
      expect(before.status).toBe(200)
      const saved = yield* save(port, configText(port, { site: "t", clientId: "gw-2" }), before.body["etag"])
      expect(saved.status).toBe(200)
      expect(saved.body).toMatchObject({ applied: { changes: ["gateway: site", "broker: clientId"] } })
      expect(yield* fs.readFileString(path)).toBe(configText(port, { site: "t", clientId: "gw-2" }))
      expect(yield* fs.readFileString(`${path}.bak`)).toBe(configText(port, {}))
      yield* settle(10)
      expect(topicsUnder(control, "t/b/meter/").length).toBeGreaterThan(0)
      expect(control.connects.map((connect) => connect.clientId)).toContain("gw-2")
      expect(yield* eventTypes(port)).toContain("config-applied")
      const view = yield* call(port, "GET", "/api/status?points=none", {})
      expect(view.body).toMatchObject({ site: "t", building: "b" })
      // The same ETag again: the file changed since, so the save is refused and the page offers to reload.
      const stale = yield* save(port, configText(port, { site: "u" }), before.body["etag"])
      expect(stale.status).toBe(409)
      expect(stale.body).toMatchObject({ _tag: "ConfigConflict", etag: saved.body["etag"] })
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("rolls a config back that does not start: the previous one runs, the file holds it again", () =>
    Effect.gen(function* () {
      const { fs, path, port, control, running } = yield* startGateway({ brokerUp: true })
      const before = yield* read(port)
      // An outbox under a regular file cannot be created.
      const broken = configText(port, { site: "t", buffer: "./ot-gateway.json/buffer.sqlite" })
      const refused = yield* save(port, broken, before.body["etag"])
      expect(refused.status).toBe(422)
      expect(refused.body).toMatchObject({ _tag: "ConfigApplyFailed" })
      expect(String(refused.body["message"])).toContain("holds the previous config again")
      expect(yield* fs.readFileString(path)).toBe(configText(port, {}))
      expect(yield* eventTypes(port)).toContain("config-apply-failed")
      const view = yield* call(port, "GET", "/api/status?points=none", {})
      expect(view.body).toMatchObject({ site: "s", building: "b" })
      const sent = control.messages.length
      yield* settle(10)
      expect(topicsUnder(control, "s/b/meter/").length).toBeGreaterThan(0)
      expect(control.messages.length).toBeGreaterThan(sent)
      expect(topicsUnder(control, "t/")).toEqual([])
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("delivers values buffered before an apply once the broker is back", () =>
    Effect.gen(function* () {
      const { port, control, startBroker, running } = yield* startGateway({ brokerUp: false })
      yield* settle(10)
      const appliedAt = yield* Clock.currentTimeMillis
      const before = yield* read(port)
      // The broker is away: a change that keeps the broker settings applies without waiting for it.
      const saved = yield* save(port, configText(port, { id: "second" }), before.body["etag"])
      expect(saved.status).toBe(200)
      yield* startBroker
      yield* settle(120)
      const delivered = topicsUnder(control, "s/b/meter/power")
        .filter((message) => !message.topic.endsWith("$meta"))
        .map((message) => decodeValue(message.payload).ts)
      expect(delivered.filter((ts) => ts < appliedAt).length).toBeGreaterThanOrEqual(5)
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("moves the BACnet/IP socket to a new port in-process, and rolls back a port another program holds", () =>
    Effect.gen(function* () {
      const { fs, path, port, running, network } = yield* startGateway({ brokerUp: true, bacnet: {} })
      const gatewayHost = network.host("10.0.0.1")
      /** Whether a UDP port of the gateway's host can be bound now: free, or held by the gateway. */
      const bindable = (udpPort: number) =>
        makeBacnetNetwork(decodeBacnetSettings({ port: udpPort }), gatewayHost).pipe(
          Effect.scoped,
          Effect.exit,
          Effect.map(Exit.isSuccess)
        )
      expect(yield* bindable(47808)).toBe(false)
      // Another program holds 47830.
      const holder = yield* Scope.make()
      yield* makeBacnetNetwork(decodeBacnetSettings({ port: 47830 }), gatewayHost).pipe(Scope.provide(holder))
      const before = yield* read(port)
      const refused = yield* save(port, configText(port, { bacnet: { port: 47830 } }), before.body["etag"])
      expect(refused.status).toBe(422)
      expect(String(refused.body["message"])).toContain("BACnet/IP port 47830 cannot be opened")
      expect(yield* fs.readFileString(path)).toBe(configText(port, { bacnet: {} }))
      yield* settle(2)
      expect(yield* bindable(47808)).toBe(false)
      yield* Scope.close(holder, Exit.void)

      const again = yield* read(port)
      const saved = yield* save(port, configText(port, { bacnet: { port: 47831 } }), again.body["etag"])
      expect(saved.status).toBe(200)
      expect(saved.body).toMatchObject({ applied: { changes: ["BACnet/IP: port"], restartNeeded: [] } })
      expect(yield* bindable(47831)).toBe(false)
      expect(yield* bindable(47808)).toBe(true)
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("refuses a write without the page's header, from another origin, or with no origin", () =>
    Effect.gen(function* () {
      const { fs, path, port, running } = yield* startGateway({ brokerUp: true })
      const before = yield* read(port)
      const body = { text: configText(port, { site: "t" }), etag: before.body["etag"] }
      const noHeader = yield* call(port, "PUT", "/api/config/file", {
        body,
        headers: { origin: `http://127.0.0.1:${port}` }
      })
      const foreign = yield* call(port, "PUT", "/api/config/file", {
        body,
        headers: { origin: "http://evil.example", [EDIT_HEADER]: EDIT_HEADER_VALUE }
      })
      const noOrigin = yield* call(port, "PUT", "/api/config/file", {
        body,
        headers: { [EDIT_HEADER]: EDIT_HEADER_VALUE }
      })
      const check = yield* call(port, "POST", "/api/config/check", { body: { text: "{}" } })
      for (const refused of [noHeader, foreign, noOrigin, check]) {
        expect(refused.status).toBe(403)
        expect(refused.body).toMatchObject({ _tag: "EditingDisabled" })
      }
      expect(yield* fs.readFileString(path)).toBe(configText(port, {}))
      // The page's own check gets every issue with its path.
      const checked = yield* call(port, "POST", "/api/config/check", {
        body: { text: JSON.stringify({ site: "Not A Slug", building: "b", mqtt: { url: "x" }, devices: [] }) },
        headers: pageHeaders(port)
      })
      expect(checked.body).toMatchObject({ valid: false, issues: [{ path: ["site"] }, { path: ["mqtt", "url"] }] })
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
