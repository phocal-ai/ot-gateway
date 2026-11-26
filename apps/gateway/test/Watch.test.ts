/** `watch`: what it prints, and `watch --seconds` against the in-process test broker over real TCP. */
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { makeBrokerControl, serveMqtt } from "@ot-gateway/mqtt"
import { Effect, Exit, Fiber, Scope } from "effect"
import { TestConsole } from "effect/testing"
import { publishOnce } from "../src/Broker.ts"
import {
  clearHint,
  contractViolation,
  describeViolation,
  formatContractSummary,
  formatMessage,
  formatSummary,
  messageRecord,
  pointArrivals,
  staleReason,
  untilValuesSeconds,
  watch,
  watchFilter
} from "../src/Watch.ts"

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

/** A meter read every 5 s, one point on change only and one with a heartbeat; a BACnet device asked by COV. */
const buildingFor = (port: number) =>
  parseConfig(
    JSON.stringify({
      site: "s",
      building: "b",
      mqtt: { url: `mqtt://127.0.0.1:${port}` },
      devices: [
        {
          id: "meter",
          protocol: "simulator",
          pollIntervalMs: 5000,
          points: [
            { id: "power", name: "Power", waveform: "sine", min: 0, max: 10, periodSeconds: 60 },
            { id: "tripped", name: "Tripped", waveform: "constant", min: 0, max: 0, publish: { mode: "change" } },
            {
              id: "energy",
              name: "Energy",
              waveform: "ramp",
              min: 0,
              max: 10,
              periodSeconds: 60,
              publish: { mode: "change", maxSilenceMs: 120_000 }
            }
          ]
        },
        {
          id: "heat-pump",
          protocol: "bacnet-ip",
          address: "127.0.0.1",
          deviceInstance: 2001,
          points: [{ id: "flow", name: "Flow", objectType: "analog-input", instance: 1 }]
        }
      ]
    })
  )

/** A value message on `topic`, live unless `retain`. */
const value = (topic: string, retain = false) => ({ topic, payload: '{"value":1}', retain })

describe("watch: which points sent a value", () => {
  it.effect("counts live values of configured points, and tells points that send only on change apart", () =>
    Effect.gen(function* () {
      const config = yield* buildingFor(1883)
      const arrivals = pointArrivals(config, watchFilter(config))
      // The heartbeat goes out with the first read after maxSilenceMs: up to a poll later.
      expect(arrivals.slowestDueMs).toBe(125_000)
      expect(untilValuesSeconds(arrivals.slowestDueMs)).toBe(155)
      expect(untilValuesSeconds(undefined)).toBe(60)
      // Retained (an older run's), $meta, unknown points and empty payloads are not values.
      expect(arrivals.record(value("s/b/meter/power", true))).toBe(false)
      expect(arrivals.record(value("s/b/meter/power/$meta"))).toBe(false)
      expect(arrivals.record(value("s/b/meter/voltage"))).toBe(false)
      expect(arrivals.record({ topic: "s/b/meter/power", payload: "", retain: false })).toBe(false)
      expect(arrivals.record(value("s/b/meter/power"))).toBe(false)
      expect(arrivals.devices()).toEqual([
        { id: "meter", arrived: ["power"], missing: ["energy"], onChange: ["tripped"] },
        { id: "heat-pump", arrived: [], missing: [], onChange: ["flow"] }
      ])
      // The last point on a timer: done, though the ones on change only stay quiet.
      expect(arrivals.record(value("s/b/meter/energy"))).toBe(true)
    })
  )

  it.effect("with only points that send on change, waits for the first value of any", () =>
    Effect.gen(function* () {
      const config = yield* buildingFor(1883)
      const arrivals = pointArrivals(config, "s/b/heat-pump/#")
      expect(arrivals.slowestDueMs).toBeUndefined()
      expect(arrivals.record({ topic: "s/b/heat-pump/flow", payload: "21", retain: false })).toBe(true)
      expect(pointArrivals(config, "other/#").expects).toBe(false)
    })
  )

  it("sums it up in one line", () => {
    expect(
      formatSummary({
        event: "summary",
        seconds: 10,
        messages: 20,
        points: 4,
        arrived: 1,
        missing: 1,
        devices: [
          { id: "meter", arrived: ["power"], missing: ["energy"], onChange: ["tripped"] },
          { id: "heat-pump", arrived: [], missing: [], onChange: ["flow"] }
        ]
      })
    ).toBe(
      "-- 1 of 4 point(s) sent a value in 10 s (20 message(s)); none from meter: energy; on change only, unchanged so far: meter: tripped; heat-pump: flow"
    )
  })
})

describe("watch --until-values", () => {
  it.live("stops once every point on a timer sent a value, and ends with the summary", () =>
    Effect.gen(function* () {
      const port = yield* startBroker(0)
      const config = yield* buildingFor(port)
      const watching = yield* watch(config, { untilValues: true, json: true }).pipe(Effect.forkChild)
      yield* Effect.sleep("300 millis")
      yield* publishOnce(config, "s/b/meter/power", "1", { retain: false, qos: 1 })
      yield* publishOnce(config, "s/b/meter/energy", "2", { retain: false, qos: 1 })
      yield* Fiber.join(watching)
      const last = (yield* TestConsole.logLines).map(String).findLast((line) => line.startsWith("{"))
      expect(JSON.parse(String(last))).toMatchObject({ event: "summary", points: 4, arrived: 2, missing: 0 })
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer))
  )

  it.live("fails naming the points that sent nothing in time", () =>
    Effect.gen(function* () {
      const port = yield* startBroker(0)
      const config = yield* buildingFor(port)
      const watching = yield* watch(config, { untilValues: true, seconds: 1 }).pipe(Effect.flip, Effect.forkChild)
      yield* Effect.sleep("300 millis")
      yield* publishOnce(config, "s/b/meter/power", "1", { retain: false, qos: 1 })
      expect(yield* Fiber.join(watching)).toMatchObject({
        _tag: "WatchError",
        code: "values-missing",
        message: "1 of 4 point(s) sent no value within 1 s",
        missing: ["meter/energy"]
      })
      // Only points that send on change, and none did: nothing shows the gateway works.
      const quiet = yield* Effect.flip(watch(config, { untilValues: true, topic: "s/b/heat-pump/#", seconds: 1 }))
      expect(quiet).toMatchObject({ code: "values-missing", message: "no point sent a value within 1 s" })
      expect(quiet).toMatchObject({ missing: ["heat-pump/flow"] })
      const failed = yield* Effect.flip(watch(config, { untilValues: true, topic: "other/#", seconds: 1 }))
      expect(failed).toMatchObject({ code: "nothing-to-wait-for" })
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer))
  )
})

describe("watch --seconds", () => {
  it.live("fails when it cannot reach the broker, instead of watching nothing", () =>
    Effect.gen(function* () {
      const config = yield* configFor(yield* closedPort)
      const error = yield* Effect.flip(watch(config, { seconds: 1 }))
      expect(error._tag).toBe("BrokerCommandError")
      expect(error.message).toMatch(/^could not connect to mqtt:\/\/127\.0\.0\.1:\d+/)
      expect(error).toMatchObject({ code: "broker-unreachable" })
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

describe("watch --check", () => {
  const site = { site: "s", building: "b" }
  const verdict = (payload: string, topic = "s/b/meter/power") => contractViolation(site, { topic, payload })

  it("passes what the contract allows, and says which message and what is wrong otherwise", () => {
    expect(verdict('{"value":21.5,"unit":"unit:DEG_C","ts":1764075600000}')).toBe("ok")
    expect(verdict('{"value":21.5,"ts":1.5}')).toMatchObject({ message: "value", issues: [{ path: "ts" }] })
    // Strict, as the gateway's own tests: a field the contract does not have is off it too.
    expect(verdict('{"value":1,"ts":1,"extra":2}')).toMatchObject({ message: "value" })
    expect(verdict("not json")).toMatchObject({ message: "value", issues: [expect.objectContaining({})] })
    expect(contractViolation(site, { topic: "s/b/meter/power/$set", payload: '{"value":1,"x":1}' })).toMatchObject({
      message: "command"
    })
  })

  it("lets an empty message clear a retained topic, and leaves topics outside the contract alone", () => {
    expect(verdict("", "s/b/meter/power/$meta")).toBe("ok")
    expect(verdict("", "s/b/$gateway/main/health")).toBe("ok")
    expect(verdict("", "s/b/meter/power")).toMatchObject({ message: "value" })
    expect(verdict("x", "s/b/$gateway/main/check/1")).toBeUndefined()
    expect(verdict("x", "other/b/meter/power")).toBeUndefined()
    expect(verdict("x", "s/b/meter")).toBeUndefined()
  })

  it("names the message and every mistake on one line, and in the JSON line", () => {
    const violation = { message: "value" as const, issues: [{ path: "ts", message: "Expected an integer" }] }
    expect(describeViolation(violation)).toBe("off contract (value): ts: Expected an integer")
    const at = new Date(2026, 10, 5, 9, 4, 7)
    const record = messageRecord({ topic: "s/b/m/p", payload: '{"ts":1.5}', retain: false }, at, undefined, violation)
    expect(JSON.parse(record)).toMatchObject({ topic: "s/b/m/p", contract: violation, payload: { ts: 1.5 } })
    expect(formatContractSummary({ event: "contract", version: "1.0", checked: 3, off: 0 })).toBe(
      "-- 3 message(s) checked against the MQTT contract 1.0: all on it"
    )
  })

  // Retained, so the broker hands them to the watch when it subscribes, however long that takes.
  it.live("prints only the messages off the contract, sums up, and fails when there was one", () =>
    Effect.gen(function* () {
      const port = yield* startBroker(0)
      const config = yield* configFor(port)
      const retained = { retain: true, qos: 1 } as const
      yield* publishOnce(config, "s/b/meter/power", '{"value":1,"ts":1764075600000}', retained)
      yield* publishOnce(config, "s/b/meter/energy", '{"value":"1","ts":1764075600000}', retained)
      yield* publishOnce(config, "s/b/$gateway/main/check/1", "anything", retained)
      const error = yield* Effect.flip(watch(config, { seconds: 1, json: true, check: true }))
      expect(error).toMatchObject({ _tag: "WatchError", code: "off-contract" })
      expect(error.message).toBe("1 of 2 message(s) under s/b were off the MQTT contract 1.0")
      const records = (yield* TestConsole.logLines)
        .map(String)
        .filter((line) => line.startsWith("{"))
        .map((line): unknown => JSON.parse(line))
      expect(records).toEqual([
        expect.objectContaining({ topic: "s/b/meter/energy", contract: expect.objectContaining({ message: "value" }) }),
        { event: "contract", version: "1.0", checked: 2, off: 1 }
      ])
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer))
  )

  it.live("ends well when every message was on the contract, and fails when there was none to check", () =>
    Effect.gen(function* () {
      const port = yield* startBroker(0)
      const config = yield* configFor(port)
      const nothing = yield* Effect.flip(watch(config, { seconds: 1, check: true }))
      expect(nothing).toMatchObject({ _tag: "WatchError", code: "nothing-checked" })
      const offline = '{"status":"offline","reason":"shutdown"}'
      yield* publishOnce(config, "s/b/$gateway/main/health", offline, { retain: true, qos: 1 })
      yield* watch(config, { seconds: 1, check: true })
      const lines = (yield* TestConsole.logLines)
        .map(String)
        .filter((line) => line.includes("s/b/") || line.startsWith("--"))
      expect(lines).toEqual([
        "-- 0 message(s) checked against the MQTT contract 1.0: all on it",
        "-- 1 message(s) checked against the MQTT contract 1.0: all on it"
      ])
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer))
  )

  it.live("with --until-values, puts the summary of the points first and keeps missing values as the code", () =>
    Effect.gen(function* () {
      const port = yield* startBroker(0)
      const config = yield* buildingFor(port)
      yield* publishOnce(config, "s/b/meter/power", '{"value":1,"ts":0.5}', { retain: true, qos: 1 })
      const error = yield* Effect.flip(watch(config, { seconds: 1, json: true, check: true, untilValues: true }))
      expect(error).toMatchObject({ code: "values-missing" })
      expect(error.message).toMatch(/; and 1 of 1 message\(s\) under s\/b were off the MQTT contract 1\.0$/)
      const events = (yield* TestConsole.logLines)
        .map(String)
        .filter((line) => line.startsWith('{"event"'))
        .map((line): unknown => JSON.parse(line))
      expect(events).toEqual([
        expect.objectContaining({ event: "summary" }),
        { event: "contract", version: "1.0", checked: 1, off: 1 }
      ])
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer))
  )
})
