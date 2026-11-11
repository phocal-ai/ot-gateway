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
  configSince: at(10, 19, 30),
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
      "                   check: Is the device switched on and its Modbus TCP server (or its network module) enabled?",
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

  const startingGateway: GatewayStatus = {
    ...failingGateway,
    since: now - 2_000,
    broker: {
      url: "mqtt://localhost:1883",
      connected: false,
      connects: 0,
      failedConnects: 0,
      published: 0,
      publishFailures: 0
    },
    devices: failingGateway.devices.map((device) => ({
      id: device.id,
      protocol: device.protocol,
      status: "starting" as const,
      pollIntervalMs: device.pollIntervalMs,
      pointCount: device.pointCount,
      points: []
    }))
  }

  it.effect("says a gateway that has just started is connecting, and exits 0 for it", () =>
    Effect.gen(function* () {
      const lines = formatStatus(startingGateway).split("\n")
      expect(lines[1]).toBe("  broker mqtt://localhost:1883: connecting (started 2 s ago)")
      expect(lines.at(-1)).toBe("    energy-meter   starting modbus-tcp, 4 point(s), no read yet")
      yield* statusOutcome(true)(startingGateway)
      const [report] = (yield* TestConsole.logLines).map((line): unknown => JSON.parse(String(line)))
      expect(report).toMatchObject({ ok: true, broker: { connected: false, failedConnects: 0 } })
    }).pipe(Effect.provide(TestConsole.layer))
  )

  it("counts the broker as away after a failed connect, or once a connection was lost", () => {
    const failedOnce = { ...startingGateway, broker: { ...startingGateway.broker, failedConnects: 1 } }
    expect(unhealthySummary(failedOnce)).toBe("broker not connected")
    const lost = {
      ...startingGateway,
      broker: { ...startingGateway.broker, connects: 1, disconnectedSince: now - 1_000 }
    }
    expect(unhealthySummary(lost)).toBe("broker not connected")
  })

  it("marks an ok device late when no read came for three intervals, and fails for it", () => {
    const late: GatewayStatus = {
      ...healthyGateway,
      devices: healthyGateway.devices.map((device) => ({ ...device, lastSuccess: now - 40_000 }))
    }
    expect(formatStatus(late).split("\n").slice(3, 5)).toEqual([
      "  1 device(s), 1 late",
      "    ventilation-1  late     simulator, 0 point(s), no read for 40 s, though not failing: a polling cycle is stuck"
    ])
    expect(unhealthySummary(late)).toBe("1 of 1 device(s) late")
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
      { id: 7, at: at(12, 19, 20), type: "buffer-drained", delivered: 1266 }
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
      "12:19:10  broker        connected again after 70 s, 1204 message(s) waiting in the buffer at reconnect",
      "12:19:20  buffer        drained: 1266 message(s) delivered from the buffer since it was last empty"
    ])
    expect(formatEvents(log, Number.POSITIVE_INFINITY, "all").split("\n")[0]).toBe(
      "10:19:30  gateway       started (v1.2.3, 2 device(s))"
    )
    expect(formatEvents(log, 5_000, "5s")).toBe("no events in the last 5s")
  })

  it("prints a config applied from the status page, and one that was rolled back", () => {
    const edits: EventLog = {
      ...log,
      events: [
        { id: 8, at: at(12, 19, 25), type: "config-applied", summary: "gateway: site; broker: clientId" },
        { id: 9, at: at(12, 19, 28), type: "config-apply-failed", error: "the broker did not answer" }
      ]
    }
    expect(formatEvents(edits, Number.POSITIVE_INFINITY, "all").split("\n")).toEqual([
      "12:19:25  config  applied from the status page: gateway: site; broker: clientId",
      "12:19:28  config  not applied, the previous config runs again: the broker did not answer"
    ])
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
