/** `watch`: what it prints, and `watch --seconds` against the in-process test broker over real TCP. */
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { makeBrokerControl, serveMqtt } from "@ot-gateway/mqtt"
import { Effect, Exit, Fiber, Scope } from "effect"
import { TestConsole } from "effect/testing"
import { publishOnce } from "../src/Broker.ts"
import { clearHint, formatMessage, messageRecord, staleReason, watch, watchFilter } from "../src/Watch.ts"

const configFor = (port: number) =>
  parseConfig(JSON.stringify({ site: "s", building: "b", mqtt: { url: `mqtt://127.0.0.1:${port}` }, devices: [] }))

/** A test broker on `port` (0 for any) for the current scope; its port. */
const startBroker = (port: number) =>
  Effect.gen(function* () {
    const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port })
    yield* serveMqtt(server, makeBrokerControl()).pipe(Effect.forkScoped)
    return server.address._tag === "UnixPathAddress" ? 0 : server.address.port
  })

/** A port on this machine that nothing listens on: one a server had, closed again. */
const closedPort = Effect.scoped(
  Effect.map(NodeSocketServer.make({ host: "127.0.0.1", port: 0 }), (server) =>
    server.address._tag === "UnixPathAddress" ? 0 : server.address.port
  )
)

describe("watch", () => {
  it("subscribes to everything under the site and building", () => {
    expect(watchFilter({ site: "site-1", building: "building-a" })).toBe("site-1/building-a/#")
  })

  it("prints one line per message, marks retained ones and cuts long payloads", () => {
    const at = new Date(2026, 10, 5, 9, 4, 7)
    expect(formatMessage({ topic: "s/b/ventilation-1/temp", payload: '{"value":21.5}', retain: false }, at)).toBe(
      '09:04:07 s/b/ventilation-1/temp {"value":21.5}'
    )
    expect(
      formatMessage({ topic: "s/b/ventilation-1/temp/$meta", payload: '{\n  "unit": "x"\n}', retain: true }, at)
    ).toBe('09:04:07 retained s/b/ventilation-1/temp/$meta { "unit": "x" }')
    const long = formatMessage({ topic: "t", payload: "x".repeat(1000), retain: false }, at)
    expect(long.length).toBeLessThan(320)
    expect(long.endsWith("…")).toBe(true)
  })

  it("marks retained messages of another gateway, or of devices and points the config does not have", () => {
    const config = { id: "main", site: "s", building: "b", devices: [{ id: "meter", points: [{ id: "power" }] }] }
    const retained = (topic: string, payload = "1") => staleReason(config, { topic, payload, retain: true })
    expect(retained("s/b/meter/power")).toBeUndefined()
    expect(retained("s/b/meter/power/$meta", '{"gateway":"main"}')).toBeUndefined()
    expect(retained("s/b/$gateway/main/health")).toBeUndefined()
    expect(retained("s/b/$gateway/old-pi/health")).toBe("from gateway old-pi")
    expect(retained("s/b/meter/power/$meta", '{"gateway":"hall-b"}')).toBe("from gateway hall-b")
    expect(retained("s/b/meter/energy")).toBe("point not in this config")
    expect(retained("s/b/boiler/temp/$meta", "{}")).toBe("device not in this config")
    // Live messages, a clearing one and other buildings are not marked.
    expect(staleReason(config, { topic: "s/b/boiler/temp", payload: "1", retain: false })).toBeUndefined()
    expect(retained("s/b/boiler/temp", "")).toBeUndefined()
    expect(retained("s/other/boiler/temp")).toBeUndefined()
    const at = new Date(2026, 10, 5, 9, 4, 7)
    const old = { topic: "s/b/$gateway/old-pi/health", payload: "offline", retain: true }
    expect(formatMessage(old, at, "from gateway old-pi")).toBe(
      "09:04:07 retained (from gateway old-pi) s/b/$gateway/old-pi/health offline"
    )
    expect(JSON.parse(messageRecord(old, at, "from gateway old-pi"))).toMatchObject({ stale: "from gateway old-pi" })
  })

  it("keeps a publisher's control characters off the terminal: tabs become a space, the rest ?", () => {
    const at = new Date(2026, 10, 5, 9, 4, 7)
    const line = formatMessage(
      { topic: "s/b/\u001b[2Jx/\u009b31m", payload: "a\tb\r\u001b]0;title\u0007c\u009bd", retain: false },
      at
    )
    expect(line).toBe("09:04:07 s/b/?[2Jx/?31m a b ?]0;title?c?d")
    expect(line).not.toMatch(/\p{Cc}/u)
  })
})

describe("watch --seconds", () => {
  it.live("fails when it cannot reach the broker, instead of watching nothing", () =>
    Effect.gen(function* () {
      const config = yield* configFor(yield* closedPort)
      const error = yield* Effect.flip(watch(config, { seconds: 1 }))
      expect(error._tag).toBe("BrokerCommandError")
      expect(error.message).toMatch(/^could not connect to mqtt:\/\/127\.0\.0\.1:\d+/)
    }).pipe(Effect.provide(TestConsole.layer))
  )

  it.live("prints what the broker sends for the seconds asked, then stops", () =>
    Effect.gen(function* () {
      const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
      yield* serveMqtt(server, makeBrokerControl()).pipe(Effect.forkScoped)
      const config = yield* configFor(server.address._tag === "UnixPathAddress" ? 0 : server.address.port)
      yield* publishOnce(config, "s/b/meter/power", "42", { retain: true, qos: 1 })
      yield* watch(config, { seconds: 1 })
      // The client's own log lines reach the test console too: only the message lines count.
      const lines = (yield* TestConsole.logLines).map(String).filter((line) => line.includes("s/b/"))
      // The config has no devices, so the broker keeps it for something else; how to clear it is said once.
      expect(lines).toEqual([
        expect.stringMatching(/^\d\d:\d\d:\d\d retained \(device not in this config\) s\/b\/meter\/power 42$/)
      ])
      expect((yield* TestConsole.errorLines).map(String).filter((line) => line === clearHint)).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer))
  )

  it.live("says when it loses the broker, and fails when the broker is still gone at the end", () =>
    Effect.gen(function* () {
      const brokerScope = yield* Scope.make()
      const port = yield* startBroker(0).pipe(Scope.provide(brokerScope))
      const config = yield* configFor(port)
      const watching = yield* watch(config, { seconds: 2, json: true }).pipe(Effect.flip, Effect.forkChild)
      yield* Effect.sleep("500 millis")
      yield* Scope.close(brokerScope, Exit.void)
      const error = yield* Fiber.join(watching)
      expect(error.message).toMatch(/^lost mqtt:\/\/127\.0\.0\.1:\d+ at \d\d:\d\d:\d\d and it did not come back: /)
      // The client's own log lines reach the test console too: only the JSON lines are the watch's.
      const records = (yield* TestConsole.logLines)
        .map(String)
        .filter((line) => line.startsWith("{"))
        .map((line): unknown => JSON.parse(line))
      expect(records).toEqual([{ at: expect.any(String), event: "broker-disconnected", error: expect.any(String) }])
    }).pipe(Effect.provide(TestConsole.layer))
  )

  it.live("says when the broker is back, and ends well when it came back in time", () =>
    Effect.gen(function* () {
      const brokerScope = yield* Scope.make()
      const port = yield* startBroker(0).pipe(Scope.provide(brokerScope))
      const config = yield* configFor(port)
      const watching = yield* watch(config, { seconds: 4 }).pipe(Effect.forkChild)
      yield* Effect.sleep("500 millis")
      yield* Scope.close(brokerScope, Exit.void)
      yield* Effect.sleep("200 millis")
      yield* startBroker(port)
      yield* Fiber.join(watching)
      const lines = (yield* TestConsole.logLines).map(String).filter((line) => line.includes(" -- "))
      expect(lines).toEqual([
        expect.stringMatching(/^\d\d:\d\d:\d\d -- lost the broker: .*; reconnecting$/),
        expect.stringMatching(/^\d\d:\d\d:\d\d -- broker back after \d+ s$/)
      ])
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer))
  )
})
