/** `status` and `events`: what they print, in local clock time, and the exit code `status` gives. */
import { describe, expect, it } from "@effect/vitest"
import type { EventLog, GatewayStatus } from "@ot-gateway/api"
import { Effect } from "effect"
import { TestConsole } from "effect/testing"
import { localTime } from "../src/Output.ts"
import {
  ago,
  eventsWithin,
  formatEvents,
  formatStatus,
  isHealthy,
  parseSince,
  statusOutcome,
  unhealthySummary
} from "../src/StatusReport.ts"

/** A moment today on this machine's clock, so the expected lines hold in any time zone. */
const at = (hours: number, minutes: number, seconds: number) =>
  new Date(2026, 10, 11, hours, minutes, seconds).getTime()
const now = at(12, 19, 30)

const failingGateway: GatewayStatus = {
  site: "s",
  building: "b",
  id: "main",
  since: at(10, 19, 30),
  now,
  broker: {
    url: "mqtt://localhost:1883",
    connected: false,
    disconnectedSince: at(12, 18, 0),
    lastError: "could not connect: connection refused by 127.0.0.1:1883",
    connects: 1,
    failedConnects: 4,
    published: 900,
    publishFailures: 0
  },
  buffer: {
    path: "buf.sqlite",
    rows: 42,
    maxRows: 1000,
    dropped: 3,
    written: 45,
    delivered: 0,
    droppedBy: { overflow: 3 },
    failures: 0,
    disabled: false
  },
  devices: [
    {
      id: "ventilation-1",
      protocol: "simulator",
      status: "ok",
      pollIntervalMs: 2000,
      lastSuccess: now - 2_000,
      pointCount: 0,
      points: []
    },
    {
      id: "energy-meter",
      protocol: "modbus-tcp",
      status: "failing",
      pollIntervalMs: 5000,
      reason: "connection",
      failingSince: at(12, 18, 20),
      lastError: "could not connect: connection refused by 127.0.0.1:5020",
      failures: 14,
      pointCount: 4,
      points: []
    }
  ],
  commands: []
}

const healthyGateway: GatewayStatus = {
  ...failingGateway,
  broker: {
    url: "mqtt://localhost:1883",
    connected: true,
    connectedAt: at(10, 19, 31),
    connects: 1,
    failedConnects: 2,
    published: 900,
    publishFailures: 0
  },
  devices: failingGateway.devices.slice(0, 1)
}

describe("status", () => {
  it("says how long ago as coarsely as a glance needs", () => {
    expect(ago(12_000)).toBe("12 s")
    expect(ago(4 * 60_000)).toBe("4 min")
    expect(ago(3 * 3_600_000)).toBe("3 h")
    expect(ago(3 * 86_400_000)).toBe("3 d")
    expect(ago(-500)).toBe("0 s")
  })

  it("prints the gateway, its broker and one aligned line per device, with since when and why it fails", () => {
    expect(formatStatus(failingGateway).split("\n")).toEqual([
      "s/b gateway main, up 2 h (since 10:19:30)",
      "  broker mqtt://localhost:1883: NOT CONNECTED since 12:18:00 (90 s): could not connect: connection refused by 127.0.0.1:1883, 4 failed connect(s) since start",
      "  buffer: 42 of 1000 message(s) waiting, 3 DROPPED since start",
      "  2 device(s), 1 failing",
      "    ventilation-1  ok       simulator, 0 point(s), read 2 s ago",
      "    energy-meter   failing  modbus-tcp, 4 point(s), failing since 12:18:20 (70 s): could not connect: connection refused by 127.0.0.1:5020",
      "",
      "  What changed and when: ot-gateway events",
      "  The gateway's log (in its folder): docker compose logs gateway --since 10m"
    ])
  })

  it("says since when the broker is connected, and ends without a hint when all is well", () => {
    const lines = formatStatus(healthyGateway).split("\n")
    expect(lines[1]).toBe("  broker mqtt://localhost:1883: connected since 10:19:31, 2 failed connect(s) since start")
    expect(lines.at(-1)).toBe("    ventilation-1  ok       simulator, 0 point(s), read 2 s ago")
    expect(isHealthy(healthyGateway)).toBe(true)
    expect(unhealthySummary(healthyGateway)).toBeUndefined()
  })

  it("puts the date in front of a time from another day", () => {
    expect(localTime(at(12, 18, 20), at(12, 30, 0))).toBe("12:18:20")
    expect(localTime(new Date(2026, 10, 9, 8, 5, 0).getTime(), now)).toBe("2026-11-09 08:05:00")
  })

  it.effect("prints the report, then fails so the exit code is 1, when a device fails or the broker is away", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(statusOutcome(false)(failingGateway))
      expect(error._tag).toBe("GatewayUnhealthy")
      expect(error.message).toBe("1 of 2 device(s) failing, broker not connected")
      const [report] = (yield* TestConsole.logLines).map(String)
      expect(report).toContain("ot-gateway events")
    }).pipe(Effect.provide(TestConsole.layer))
  )

  it.effect("keeps --json one document with ok, whether it fails or not", () =>
    Effect.gen(function* () {
      yield* Effect.flip(statusOutcome(true)(failingGateway))
      yield* statusOutcome(true)(healthyGateway)
      const [failing, healthy] = (yield* TestConsole.logLines).map((line): unknown => JSON.parse(String(line)))
      expect(failing).toMatchObject({ ok: false, id: "main", devices: [{}, { failures: 14 }] })
      expect(healthy).toMatchObject({ ok: true })
    }).pipe(Effect.provide(TestConsole.layer))
  )
})

describe("events", () => {
  const log: EventLog = {
    now,
    capacity: 500,
    dropped: 0,
    events: [
      { id: 1, at: at(10, 19, 30), type: "gateway-started", version: "v1.2.3", devices: 2 },
      { id: 2, at: at(10, 19, 31), type: "broker-connected" },
      { id: 3, at: at(12, 18, 0), type: "broker-disconnected", error: "connection closed by the peer" },
      {
        id: 4,
        at: at(12, 18, 20),
        type: "device-failing",
        device: "energy-meter",
        reason: "connection",
        error: "could not connect: connection refused by 127.0.0.1:5020"
      },
      { id: 5, at: at(12, 19, 0), type: "device-recovered", device: "energy-meter", downMs: 40_000 },
      { id: 6, at: at(12, 19, 10), type: "broker-connected", downMs: 70_000, buffered: 1204 },
      { id: 7, at: at(12, 19, 20), type: "buffer-drained" }
    ]
  }

  it("reads --since as seconds, minutes, hours, days or all", () => {
    expect(parseSince("30s")).toBe(30_000)
    expect(parseSince("10m")).toBe(600_000)
    expect(parseSince("2h")).toBe(7_200_000)
    expect(parseSince("1d")).toBe(86_400_000)
    expect(parseSince("all")).toBe(Number.POSITIVE_INFINITY)
    expect(parseSince("soon")).toBeUndefined()
    expect(parseSince("10")).toBeUndefined()
  })

  it("prints one line per event in local clock time, the subject aligned, within the window asked", () => {
    expect(formatEvents(log, 10 * 60_000, "10m").split("\n")).toEqual([
      "12:18:00  broker        disconnected: connection closed by the peer",
      "12:18:20  energy-meter  failing: could not connect: connection refused by 127.0.0.1:5020",
      "12:19:00  energy-meter  ok again after 40 s",
      "12:19:10  broker        connected again after 70 s, 1204 message(s) waiting in the buffer",
      "12:19:20  buffer        drained: every waiting message delivered"
    ])
    expect(formatEvents(log, Number.POSITIVE_INFINITY, "all").split("\n")[0]).toBe(
      "10:19:30  gateway       started (v1.2.3, 2 device(s))"
    )
    expect(formatEvents(log, 5_000, "5s")).toBe("no events in the last 5s")
  })

  it("says when the ring let older events go", () => {
    const trimmed: EventLog = { ...log, dropped: 12, events: log.events.slice(5) }
    expect(formatEvents(trimmed, Number.POSITIVE_INFINITY, "all").split("\n")[0]).toBe(
      "(the gateway keeps the latest 500 events; 12 older ones were let go)"
    )
    // At or after `now` minus the window: 12:19:00 is in the last 30 s of 12:19:30.
    expect(eventsWithin(log, 30_000).map((event) => event.id)).toEqual([5, 6, 7])
  })
})
