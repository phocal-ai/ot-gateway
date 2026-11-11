/**
 * Operating a running gateway from the command line: which gateway `status`, `events` and `history` ask, what
 * to check for a failing device, `events --follow` on the test clock, and `history`'s table and refusals.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import type { EventLog, GatewayStatus, HistorySeries, PointInfo } from "@ot-gateway/api"
import { makeHealthRegistry, parseConfig } from "@ot-gateway/core"
import { Effect, Fiber, FileSystem, Layer, Result } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { createServer } from "node:net"
import { makeGatewayEvents, GatewayEvents } from "../src/Events.ts"
import { checkIdentity, DEFAULT_STATUS_URL, resolveTarget, statusUrlOf, targetOf } from "../src/GatewayTarget.ts"
import { formatSeries, gapsOf, historyReport, parseSelection, selectPoints, seriesJson } from "../src/HistoryReport.ts"
import { localTime } from "../src/Output.ts"
import { historyHandler, makeStatusState, serveStatus } from "../src/Status.ts"
import {
  eventsReport,
  followEvents,
  formatStatus,
  GatewayUnreachable,
  sharedCause,
  statusJson
} from "../src/StatusReport.ts"

/** A moment today on this machine's clock, so the expected lines hold in any time zone. */
const at = (hours: number, minutes: number, seconds: number) =>
  new Date(2026, 10, 11, hours, minutes, seconds).getTime()
const now = at(12, 19, 30)

const gatewayJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    site: "plant-1",
    building: "hall-a",
    id: "main",
    mqtt: { url: "mqtt://broker" },
    status: { port: 18080, webRoot: "/nonexistent" },
    devices: [
      {
        protocol: "modbus-tcp",
        id: "energy-meter",
        host: "10.0.1.1",
        points: [
          {
            id: "active-power",
            name: "Active power",
            unit: "unit:KiloW",
            table: "holding",
            address: 0,
            dataType: "float32"
          },
          { id: "voltage", name: "Voltage", unit: "unit:V", table: "holding", address: 2, dataType: "float32" }
        ]
      }
    ],
    ...overrides
  })

const failingDevice = (id: string, failingSince: number): GatewayStatus["devices"][number] => ({
  id,
  protocol: "modbus-tcp",
  status: "failing",
  pollIntervalMs: 5000,
  reason: "connection",
  failingSince,
  lastError: "could not connect: connection refused by 10.0.1.1:502",
  failures: 3,
  pointCount: 2,
  points: []
})

const failing: GatewayStatus = {
  site: "plant-1",
  building: "hall-a",
  id: "main",
  since: at(10, 0, 0),
  now,
  configSince: at(10, 0, 0),
  broker: {
    url: "mqtt://broker:1883",
    connected: true,
    connectedAt: at(10, 0, 1),
    connects: 1,
    failedConnects: 0,
    published: 10,
    publishFailures: 0
  },
  devices: [
    failingDevice("energy-meter", at(12, 18, 20)),
    {
      id: "pv",
      protocol: "simulator",
      status: "ok",
      pollIntervalMs: 2000,
      lastSuccess: now - 1_000,
      pointCount: 1,
      points: []
    }
  ],
  commands: []
}

describe("the gateway to ask", () => {
  it("asks a page bound to every interface on loopback, and one bound to an address there", () => {
    expect(statusUrlOf({ bindAddress: "0.0.0.0", port: 8080 })).toBe("http://127.0.0.1:8080")
    expect(statusUrlOf({ bindAddress: "10.0.0.20", port: 9000 })).toBe("http://10.0.0.20:9000")
  })

  it.effect("takes the address from the config's status block, and --url over it; expects the config's gateway", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig(gatewayJson())
      expect(yield* targetOf("site/ot-gateway.json", config, undefined)).toEqual({
        url: "http://127.0.0.1:18080",
        expected: { path: "site/ot-gateway.json", site: "plant-1", building: "hall-a", id: "main" }
      })
      const elsewhere = yield* targetOf("site/ot-gateway.json", config, "http://10.0.0.20:8080")
      expect(elsewhere.url).toBe("http://10.0.0.20:8080")
      expect(elsewhere.expected?.id).toBe("main")
    })
  )

  it.effect("says a config without a status block has nothing to ask", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig(gatewayJson({ status: undefined }))
      const error = yield* Effect.flip(targetOf("ot-gateway.json", config, undefined))
      expect(error._tag).toBe("NoStatusPage")
      expect(error.message).toContain('Add "status": {}')
    })
  )

  it.effect("reads a named config, and without one and none here asks the default address", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${folder}/gw.json`, gatewayJson())
      const named = yield* resolveTarget({ config: `${folder}/gw.json` })
      expect(named.url).toBe("http://127.0.0.1:18080")
      expect(named).toMatchObject({ expected: { site: "plant-1" } })
      // The tests run in apps/gateway, which has no ot-gateway.json.
      expect(yield* resolveTarget({})).toEqual({ url: DEFAULT_STATUS_URL })
      expect(yield* resolveTarget({ url: "http://pi:8080" })).toEqual({ url: "http://pi:8080" })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("refuses another gateway than the config's, naming both, and takes any without a config", () =>
    Effect.gen(function* () {
      const expected = { path: "ot-gateway.json", site: "plant-1", building: "hall-a", id: "main" }
      const target = { url: "http://127.0.0.1:8080", expected }
      yield* checkIdentity(target, { site: "plant-1", building: "hall-a", id: "main" })
      const error = yield* Effect.flip(checkIdentity(target, { site: "demo-site", building: "building-a", id: "main" }))
      expect(error._tag).toBe("GatewayMismatch")
      expect(error.message).toContain("WRONG GATEWAY")
      expect(error.message).toContain(
        "is demo-site/building-a gateway main, but ot-gateway.json describes plant-1/hall-a"
      )
      yield* checkIdentity({ url: target.url }, { site: "demo-site", building: "building-a", id: "x" })
    })
  )
})

describe("status: what to check", () => {
  it("prints the first thing to check under a failing device", () => {
    const lines = formatStatus(failing).split("\n")
    const index = lines.findIndex((line) => line.includes("energy-meter  failing"))
    expect(lines[index + 1]).toBe(
      "                  check: Is the device switched on and its Modbus TCP server (or its network module) enabled?"
    )
  })

  it("gives each failing device its hints in --json, and none to the others", () => {
    const [meter, pv] = statusJson(failing).devices
    expect(meter).toMatchObject({ hints: { meaning: expect.stringMatching(/nothing accepts a connection/) } })
    expect(meter && "hints" in meter ? meter.hints.checks.length : 0).toBe(3)
    expect(pv).not.toHaveProperty("hints")
  })

  it("names a shared cause when every device stopped answering within seconds of the others", () => {
    const all = [
      failingDevice("a", at(12, 18, 20)),
      failingDevice("b", at(12, 18, 26)),
      failingDevice("c", at(12, 18, 23))
    ]
    expect(sharedCause(all)).toBe(
      "all 3 devices stopped answering within 6 s of each other: likely a shared cause (power, a switch, the gateway's own network)"
    )
    expect(formatStatus({ ...failing, devices: all })).toContain("likely a shared cause")
    // Apart in time, one device still answering, or only one device: each its own problem.
    expect(sharedCause([failingDevice("a", at(12, 18, 20)), failingDevice("b", at(12, 18, 40))])).toBeUndefined()
    expect(sharedCause(failing.devices)).toBeUndefined()
    expect(sharedCause([failingDevice("a", at(12, 18, 20))])).toBeUndefined()
    expect(formatStatus(failing)).not.toContain("shared cause")
  })
})

const log = (events: EventLog["events"]): EventLog => ({ now, capacity: 500, dropped: 0, events })

describe("events --follow", () => {
  it.effect("prints each new event as it comes, says when the gateway is away and when it restarted", () =>
    Effect.gen(function* () {
      const answers: Array<Effect.Effect<EventLog, GatewayUnreachable>> = [
        Effect.succeed(log([])),
        Effect.succeed(log([{ id: 5, at: at(12, 19, 32), type: "device-recovered", device: "meter", downMs: 40_000 }])),
        Effect.fail(new GatewayUnreachable({ url: "u", message: "no gateway status at u" })),
        Effect.fail(new GatewayUnreachable({ url: "u", message: "no gateway status at u" })),
        Effect.succeed(log([{ id: 1, at: at(12, 19, 40), type: "gateway-started", version: "v2", devices: 1 }]))
      ]
      const asked: Array<number> = []
      const follow = yield* followEvents(
        (after) => {
          asked.push(after)
          return answers.shift() ?? Effect.succeed(log([]))
        },
        4,
        { json: false }
      ).pipe(Effect.forkChild)
      for (let poll = 0; poll < 6; poll++) yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(follow)
      expect(asked).toEqual([4, 4, 5, 5, 5, 1])
      expect((yield* TestConsole.logLines).map(String)).toEqual([
        `${localTime(at(12, 19, 32), now)}  meter  ok again after 40 s`,
        `${localTime(at(12, 19, 40), now)}  gateway  started (v2, 1 device(s))`
      ])
      expect((yield* TestConsole.errorLines).map(String)).toEqual([
        "lost the gateway, asking again: no gateway status at u",
        "the gateway answers again",
        "the gateway restarted: its events start over"
      ])
    }).pipe(Effect.provide(TestConsole.layer))
  )

  it.effect("prints one JSON event per line with --json", () =>
    Effect.gen(function* () {
      const event = { id: 2, at: now, type: "buffer-drained" as const, delivered: 66 }
      const follow = yield* followEvents((after) => Effect.succeed(log(after < 2 ? [event] : [])), 1, {
        json: true
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust("4 seconds")
      yield* Fiber.interrupt(follow)
      expect((yield* TestConsole.logLines).map((line): unknown => JSON.parse(String(line)))).toEqual([event])
    }).pipe(Effect.provide(TestConsole.layer))
  )
})

describe("history", () => {
  const power: PointInfo = {
    device: "energy-meter",
    id: "active-power",
    name: "Active power",
    unit: "unit:KiloW",
    writable: false,
    topic: "plant-1/hall-a/energy-meter/active-power",
    source: "holding 0 · float32 ABCD",
    read: "polled every 5 s",
    cov: false,
    publish: "every read"
  }
  const voltage: PointInfo = { ...power, id: "voltage", name: "Voltage", unit: "unit:V" }
  const catalog = [power, voltage, { ...power, device: "pv", id: "ac-power" }]

  it("reads device/point, a device, and several comma-separated", () => {
    expect(parseSelection("energy-meter/active-power")).toEqual([{ device: "energy-meter", point: "active-power" }])
    expect(parseSelection("energy-meter, pv/ac-power")).toEqual([
      { device: "energy-meter" },
      { device: "pv", point: "ac-power" }
    ])
    expect(parseSelection(" , ")).toBeUndefined()
  })

  it("picks a device's points, and names the closest when one is not the gateway's", () => {
    const picked = selectPoints(catalog, [{ device: "energy-meter" }])
    expect(Result.isSuccess(picked) ? picked.success.map((point) => point.id) : []).toEqual(["active-power", "voltage"])
    const typo = selectPoints(catalog, [{ device: "energy-meter", point: "active-pwer" }])
    expect(Result.isFailure(typo) ? typo.failure.message : "").toBe(
      "energy-meter has no point active-pwer (did you mean active-power?); its points: active-power, voltage"
    )
    const device = selectPoints(catalog, [{ device: "energy-meeter" }])
    expect(Result.isFailure(device) ? device.failure.message : "").toBe(
      "the gateway has no device energy-meeter (did you mean energy-meter?); ot-gateway status lists them"
    )
  })

  const series: HistorySeries = {
    device: "energy-meter",
    point: "active-power",
    from: at(12, 10, 0),
    to: at(12, 15, 30),
    stepMs: 60_000,
    resolution: "minute",
    buckets: [
      { t: at(12, 10, 0), min: 12.1, max: 12.9, avg: 12.4, count: 12 },
      { t: at(12, 13, 0), min: 3, max: 3, avg: 3, count: 1 }
    ]
  }

  it("finds the slots without a read, merged, up to the end of the range", () => {
    expect(gapsOf(series)).toEqual([
      { from: at(12, 11, 0), to: at(12, 13, 0) },
      { from: at(12, 14, 0), to: at(12, 15, 30) }
    ])
  })

  it("prints a line per bucket in local time with the unit, and gaps as gaps", () => {
    expect(formatSeries(power, series, now)).toEqual([
      "energy-meter/active-power (Active power, kW): 1 min buckets from the per-minute rollups",
      "  12:10:00  avg 12.4 kW  min 12.1  max 12.9  (12 reads)",
      "  12:11:00  no reads for 2 min, until 12:13:00",
      "  12:13:00  3 kW  (1 read)",
      "  12:14:00  not written yet"
    ])
    const older = { ...series, to: at(12, 18, 0) }
    expect(formatSeries(power, older, now).at(-1)).toBe(
      "  12:14:00  no reads since then (the gateway writes reads to its history every 30 s)"
    )
    expect(formatSeries(power, { ...series, buckets: [] }, now)).toEqual([
      "energy-meter/active-power (Active power, kW): 1 min buckets from the per-minute rollups",
      "  no reads in this range (the gateway writes reads to its history every 30 s)"
    ])
  })

  it("gives --json the API's series with the point's name, unit and gaps", () => {
    expect(seriesJson(power, series)).toMatchObject({
      ...series,
      name: "Active power",
      unit: "unit:KiloW",
      unitLabel: "kW",
      gaps: gapsOf(series)
    })
  })
})

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

describe("against a running status page", () => {
  it.live("names the gateway, refuses the wrong one, and says how to turn the history on", () =>
    Effect.gen(function* () {
      const port = yield* freePort
      const config = yield* parseConfig(gatewayJson({ status: { port, webRoot: "/nonexistent" } }))
      const state = makeStatusState(config, makeHealthRegistry(["energy-meter"]), Date.now())
      const ring = makeGatewayEvents(yield* Effect.clockWith(Effect.succeed))
      ring.started("v1", 1)
      const server = yield* serveStatus(
        config.status ?? { bindAddress: "127.0.0.1", port },
        state,
        historyHandler(config, undefined)
      ).pipe(Effect.provide([NodeServices.layer, Layer.succeed(GatewayEvents, ring)]), Effect.forkChild)
      yield* Effect.sleep("300 millis")
      const target = yield* targetOf("ot-gateway.json", config, undefined)
      yield* eventsReport(target, { since: "1h", sinceMs: 3_600_000 })
      const lines = (yield* TestConsole.logLines).map(String)
      expect(lines.find((line) => line.startsWith("plant-1"))).toBe(
        `plant-1/hall-a gateway main at http://127.0.0.1:${port}`
      )

      const other = yield* targetOf("other.json", { ...config, id: "second" }, undefined)
      expect((yield* Effect.flip(eventsReport(other, { since: "1h", sinceMs: 3_600_000 })))._tag).toBe(
        "GatewayMismatch"
      )

      const off = yield* Effect.flip(
        historyReport(target, [{ device: "energy-meter" }], { since: "10m", sinceMs: 600_000 })
      )
      expect(off._tag).toBe("HistoryError")
      expect(off.message).toContain('Add "history"')
      const unknown = yield* Effect.flip(
        historyReport(target, [{ device: "meter" }], { since: "10m", sinceMs: 600_000 })
      )
      expect(unknown.message).toContain("no device meter")
      yield* Fiber.interrupt(server)
    }).pipe(Effect.provide(TestConsole.layer))
  )
})
