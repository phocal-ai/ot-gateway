/** `status` and `events`: what they print, in local clock time, and the exit code `status` gives. */
import { describe, expect, it } from "@effect/vitest"
import { bacnetPortFailure, type DeviceStatus, type EventLog, type GatewayStatus, type Protocol } from "@ot-gateway/api"
import { Effect } from "effect"
import { HttpClientError, HttpClientRequest } from "effect/http"
import { TestConsole } from "effect/testing"
import { localTime } from "../src/Output.ts"
import {
  adviseEvents,
  ago,
  eventJson,
  eventsWithin,
  formatEvents,
  formatStatus,
  intervalText,
  isHealthy,
  parseSince,
  recentIncidents,
  sharedCause,
  statusJson,
  transportReason,
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

  it("says how often a device is read, as the page does", () => {
    expect(intervalText(5_000)).toBe("5 s")
    expect(intervalText(1_500)).toBe("1.5 s")
    expect(intervalText(500)).toBe("500 ms")
    expect(intervalText(60_000)).toBe("1 min")
  })

  it("prints the gateway, its broker and one aligned line per device, with since when and why it fails", () => {
    expect(formatStatus(failingGateway).split("\n")).toEqual([
      "s/b gateway main, up 2 h (since 10:19:30)",
      "  broker mqtt://localhost:1883: NOT CONNECTED since 12:18:00 (90 s): could not connect: connection refused by 127.0.0.1:1883, 4 failed connects since start",
      "  buffer: 42 of 1,000 messages waiting, 3 DROPPED since start",
      "  2 devices, 1 failing",
      "    ventilation-1  ok       simulator, 0 points every 2 s, read 2 s ago",
      "    energy-meter   failing  modbus-tcp, 4 points every 5 s, failing since 12:18:20 (70 s): could not connect: connection refused by 127.0.0.1:5020",
      "                   check: Is the device switched on and its Modbus TCP server (or its network module) enabled?",
      "",
      "  What changed and when: ot-gateway events",
      "  Its warnings and errors: ot-gateway logs --level warn (the whole log, in its folder: docker compose logs gateway --since 10m)"
    ])
  })

  it("says since when the broker is connected, and ends without a hint when all is well", () => {
    const lines = formatStatus(healthyGateway).split("\n")
    expect(lines[1]).toBe("  broker mqtt://localhost:1883: connected since 10:19:31, 2 failed connects since start")
    expect(lines.at(-1)).toBe("    ventilation-1  ok       simulator, 0 points every 2 s, read 2 s ago")
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
      expect(lines.at(-1)).toBe("    energy-meter   starting modbus-tcp, 4 points every 5 s, no read yet")
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
      "  1 device, 1 late",
      "    ventilation-1  late     simulator, 0 points every 2 s, no read for 40 s, though not failing: a polling cycle is stuck"
    ])
    expect(unhealthySummary(late)).toBe("1 of 1 device late")
  })

  it("puts the date in front of a time from another day", () => {
    expect(localTime(at(12, 18, 20), at(12, 30, 0))).toBe("12:18:20")
    expect(localTime(new Date(2026, 10, 9, 8, 5, 0).getTime(), now)).toBe("2026-11-09 08:05:00")
  })

  it.effect("prints the report, then fails so the exit code is 1, when a device fails or the broker is away", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(statusOutcome(false)(failingGateway))
      expect(error._tag).toBe("GatewayUnhealthy")
      expect(error.message).toBe("1 of 2 devices failing, broker not connected")
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

/** One BACnet timeout of boiler, from a device that answered before it or not. */
const boilerTimeout = (answeredBefore: boolean): EventLog => ({
  now,
  capacity: 500,
  dropped: 0,
  events: [
    {
      id: 1,
      at: at(12, 10, 0),
      type: "device-failing",
      device: "boiler",
      reason: "timeout",
      error: "no answer from 10.0.0.5:47808",
      ...(answeredBefore ? { answeredBefore } : {})
    }
  ]
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
      { id: 7, at: at(12, 19, 20), type: "buffer-drained", delivered: 1266, buffered: 1204, queued: 62 }
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
      "                        check: Is the device switched on and its Modbus TCP server (or its network module) enabled?",
      "                          then: Are the host and port in the config right? Modbus TCP is usually port 502.",
      "                          then: Is a firewall or a VLAN between the gateway and the device blocking the port?",
      "12:19:00  energy-meter  ok again after 40 s",
      "12:19:10  broker        connected again after 1 min 10 s, 1,204 messages waiting in the buffer at reconnect",
      "12:19:20  buffer        drained: 1,266 messages delivered from the buffer since the broker came back: the 1204 waiting at reconnect and 62 queued behind them"
    ])
    expect(formatEvents(log, Number.POSITIVE_INFINITY, "all").split("\n")[0]).toBe(
      "10:19:30  gateway       started (v1.2.3, 2 devices)"
    )
    expect(formatEvents(log, 5_000, "5s")).toBe("no events in the last 5s")
  })

  /** The line of one `buffer-drained` event with these counts. */
  const drainedLine = (fields: { delivered?: number; buffered?: number; queued?: number }) =>
    formatEvents(
      { ...log, events: [{ id: 7, at: at(12, 19, 20), type: "buffer-drained", ...fields }] },
      Number.POSITIVE_INFINITY,
      "all"
    ).split("\n")[0]

  it("adds a drained buffer up from the reconnect: waiting then, queued behind, dropped meanwhile", () => {
    expect(drainedLine({ delivered: 130, buffered: 124, queued: 8 })).toBe(
      "12:19:20  buffer  drained: 130 messages delivered from the buffer since the broker came back: the 124 waiting at reconnect and 8 queued behind them, less 2 the buffer dropped"
    )
    // Filled again on the same connection, or from an older gateway: the count alone.
    expect(drainedLine({ delivered: 6, buffered: 0, queued: 6 })).toBe(
      "12:19:20  buffer  drained: 6 messages delivered from the buffer"
    )
    expect(drainedLine({ delivered: 66 })).toBe("12:19:20  buffer  drained: 66 messages delivered from the buffer")
    expect(drainedLine({})).toBe("12:19:20  buffer  drained: every waiting message delivered")
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

  const outage: EventLog = {
    now,
    capacity: 500,
    dropped: 0,
    events: [
      {
        id: 1,
        at: at(12, 10, 0),
        type: "device-failing",
        device: "boiler",
        reason: "timeout",
        error: "no answer to Who-Is for device 1201"
      },
      { id: 2, at: at(12, 10, 4), type: "device-failing", device: "meter", reason: "connection", error: "timed out" },
      { id: 3, at: at(12, 12, 0), type: "device-recovered", device: "boiler", downMs: 120_000 },
      { id: 4, at: at(12, 12, 1), type: "device-recovered", device: "meter", downMs: 117_000 },
      { id: 5, at: at(12, 15, 0), type: "device-failing", device: "pump", reason: "protocol", error: "exception 2" }
    ]
  }
  const protocols = new Map<string, Protocol>([
    ["boiler", "bacnet-ip"],
    ["meter", "modbus-tcp"]
  ])
  const protocolOf = (device: string) => ({ protocol: protocols.get(device) })

  it("gives a cleared failure its hint by the device's protocol, and a shared cause after its group", () => {
    expect(formatEvents(outage, Number.POSITIVE_INFINITY, "all", protocolOf).split("\n")).toEqual([
      // In a shared outage the first check is what the devices share, not their config.
      "12:10:00  boiler  failing: no answer to Who-Is for device 1201",
      "                  check: Others failed with it: check what they share before its config, their power, the switch and cabling, and the gateway's own network link.",
      "                    then: Behind a BACnet router (an MS/TP trunk, another network number): is the router up, and does it route the device's network number?",
      "                    then: Is the device instance in the config the device's own (its Device object, not a point)?",
      "12:10:04  meter   failing: timed out",
      "                  2 devices (boiler, meter) stopped answering within 4 s of each other: likely a shared cause (power, a switch, the gateway's own network)",
      "12:12:00  boiler  ok again after 2 min",
      "12:12:01  meter   ok again after 1 min 57 s",
      "12:15:00  pump    failing: exception 2",
      // pump is gone from the config: only the rules for any protocol, so Modbus's words, not BACnet's.
      "                  check: Do the register addresses match the device's register map? Maps often count from 1 (40001) where the config counts from 0.",
      "                    then: Is the table right (holding or input registers, coils or discrete inputs)?",
      "                    then: Does the data type fit the map? A 32-bit value spans two registers."
    ])
  })

  it("leads with power, switch and cable for a device that answered before it failed, config for one that never did", () => {
    expect(formatEvents(boilerTimeout(false), Number.POSITIVE_INFINITY, "all", protocolOf).split("\n")[1]).toBe(
      "                  check: Is the device instance in the config the device's own (its Device object, not a point)?"
    )
    expect(formatEvents(boilerTimeout(true), Number.POSITIVE_INFINITY, "all", protocolOf).split("\n")[1]).toBe(
      "                  check: It answered earlier in this run, so its config worked: did it lose power, or a switch or cable on the way? A device whose network module hangs answers again after a restart."
    )
  })

  it("puts the hint and the shared cause into the JSON of the failures", () => {
    const advice = adviseEvents(outage.events, protocolOf)
    const [boiler, meter, , , pump] = outage.events.map((event) => eventJson(event, advice))
    expect(boiler).toMatchObject({ hint: { meaning: expect.stringContaining("Who-Is") } })
    expect(meter).toMatchObject({ sharedCause: expect.stringContaining("2 devices (boiler, meter)") })
    expect(boiler).toHaveProperty("sharedCause", meter?.sharedCause)
    expect(pump).not.toHaveProperty("sharedCause")
    for (const event of log.events.filter((other) => other.type !== "device-failing")) {
      expect(eventJson(event, adviseEvents(log.events, protocolOf))).not.toHaveProperty("hint")
    }
  })

  it("prints alarms raised, cleared, flapping and settled", () => {
    const alarms: EventLog = {
      ...log,
      events: [
        { id: 1, at: at(12, 0, 0), type: "alarm-raised", device: "ahu", point: "filter", value: true, first: true },
        {
          id: 2,
          at: at(12, 1, 0),
          type: "alarm-cleared",
          device: "ahu",
          point: "filter",
          value: false,
          activeMs: 60_000
        },
        { id: 3, at: at(12, 2, 0), type: "alarm-raised", device: "pump", point: "trip", value: 1 },
        {
          id: 4,
          at: at(12, 3, 0),
          type: "alarm-flapping",
          device: "pump",
          point: "trip",
          raised: 4,
          pattern: { onMs: 30_000, offMs: 30_000, raised: 4, overMs: 210_000 }
        },
        {
          id: 5,
          at: at(12, 12, 0),
          type: "alarm-settled",
          device: "pump",
          point: "trip",
          active: false,
          since: at(12, 7, 0),
          unlisted: 23,
          pattern: { onMs: 30_000, offMs: 90_000, raised: 8, overMs: 960_000 }
        }
      ]
    }
    expect(formatEvents(alarms, Number.POSITIVE_INFINITY, "all").split("\n")).toEqual([
      "12:00:00  ahu/filter  alarm active at its first read (value true)",
      "12:01:00  ahu/filter  alarm cleared after 1 min (value false)",
      "12:02:00  pump/trip   alarm raised (value 1)",
      "12:03:00  pump/trip   alarm raised 4 times in the last 15 min: flapping (on 30 s, off 30 s, 4 times in 4 min), so its changes are counted, not listed, until it keeps still for 5 min",
      // A fixed rhythm reads as wiring or a cycling device more than a real trip: say what to check.
      "                      check: A fixed on/off rhythm like this usually points to the input's wiring or contact, or a device cycling, more than a real trip.",
      "                        then: Check the contact and its terminals, and whether the device restarts or switches on a schedule at that rhythm.",
      "12:12:00  pump/trip   alarm keeps still, off since 12:07:00; 23 changes were counted, not listed (it flapped on 30 s, off 90 s, 8 times in 16 min)"
    ])
  })

  it("says an alarm found active or off when its device answered again, not that it was raised or cleared", () => {
    const answeredAgain: EventLog = {
      now: at(12, 30, 0),
      capacity: 500,
      dropped: 0,
      events: [
        {
          id: 1,
          at: at(12, 0, 0),
          type: "alarm-raised",
          device: "meter",
          point: "breaker",
          value: true,
          afterOutage: true
        },
        {
          id: 2,
          at: at(12, 5, 0),
          type: "alarm-cleared",
          device: "meter",
          point: "breaker",
          value: false,
          activeMs: 0,
          afterOutage: true,
          unknownMs: 93_000
        }
      ]
    }
    expect(formatEvents(answeredAgain, Number.POSITIVE_INFINITY, "all").split("\n")).toEqual([
      // From a gateway that does not say how long the state was unknown.
      "12:00:00  meter/breaker  alarm active when meter answered again (value true), unknown while its device had no data",
      "12:05:00  meter/breaker  alarm off when meter answered again (value false), unknown during the 1 min 33 s without data"
    ])
  })
})

describe("status after an outage, and its alarms", () => {
  const recentLog: EventLog = {
    now,
    capacity: 500,
    dropped: 0,
    events: [
      { id: 1, at: at(11, 0, 0), type: "device-failing", device: "old", reason: "timeout", error: "" },
      { id: 2, at: at(12, 10, 0), type: "device-failing", device: "energy-meter", reason: "timeout", error: "" },
      { id: 3, at: at(12, 10, 5), type: "broker-disconnected", error: "connection closed by the peer" },
      { id: 4, at: at(12, 12, 30), type: "device-failing", device: "pv", reason: "timeout", error: "" },
      { id: 5, at: at(12, 13, 0), type: "device-failing", device: "energy-meter", reason: "timeout", error: "" }
    ]
  }

  it("names the devices that failed in the last 15 min, and the broker outages, from the events", () => {
    const recent = recentIncidents(recentLog)
    expect(recent).toEqual({
      windowMs: 900_000,
      failedDevices: ["energy-meter", "pv"],
      from: at(12, 10, 0),
      to: at(12, 13, 0),
      brokerOutages: 1,
      brokerOutageSpans: [{ from: at(12, 10, 5) }],
      outages: [
        { device: "energy-meter", detectedAt: at(12, 10, 0) },
        { device: "pv", detectedAt: at(12, 12, 30) },
        { device: "energy-meter", detectedAt: at(12, 13, 0) }
      ]
    })
    expect(recentIncidents({ ...recentLog, events: [] })).toEqual({
      windowMs: 900_000,
      failedDevices: [],
      brokerOutages: 0
    })
  })

  it.effect("says so under a healthy gateway's devices, lists active and flapping alarms, and stays ok", () =>
    Effect.gen(function* () {
      const withAlarms: GatewayStatus = {
        ...healthyGateway,
        alarms: [
          {
            device: "ahu",
            point: "filter",
            alarmWhen: "on",
            active: true,
            since: at(12, 17, 0),
            raised: 1,
            flapping: false
          },
          {
            device: "pump",
            point: "trip",
            alarmWhen: "off",
            active: false,
            since: at(12, 19, 0),
            raised: 7,
            flapping: true,
            pattern: { onMs: 30_000, offMs: 30_000, raised: 6, overMs: 360_000 }
          },
          { device: "pump", point: "door", alarmWhen: "on", active: false, raised: 0, flapping: false }
        ]
      }
      const lines = formatStatus(withAlarms, recentIncidents(recentLog)).split("\n")
      expect(lines.slice(-6)).toEqual([
        "  3 alarm points, 1 active",
        "    ahu/filter  ACTIVE since 12:17:00 (3 min), raised 1 time in the last 15 min",
        "    pump/trip   off since 12:19:00, raised 7 times in the last 15 min (flapping, on 30 s, off 30 s, 6 times in 6 min: its changes are counted, not listed, until it keeps still for 5 min)",
        "                check: A fixed on/off rhythm like this usually points to the input's wiring or contact, or a device cycling, more than a real trip.",
        "  2 devices failed in the last 15 min (12:10:00–12:13:00: energy-meter and pv), see ot-gateway events",
        "  broker connection lost once in the last 15 min (since 12:10:05), see ot-gateway events"
      ])
      expect(statusJson(withAlarms, recentIncidents(recentLog))).toMatchObject({
        ok: true,
        alarmsActive: 1,
        recent: { failedDevices: ["energy-meter", "pv"] },
        alarms: [{ device: "ahu", active: true }, {}, {}]
      })
      // An active alarm is the building's, not the gateway's: exit 0, unless a script asks for 1.
      yield* statusOutcome(false)(withAlarms, recentIncidents(recentLog))
      const alarmed = yield* Effect.flip(statusOutcome(false, { failOnAlarm: true })(withAlarms))
      expect(alarmed).toMatchObject({ _tag: "AlarmActive", message: "1 alarm active: ahu/filter" })
      const quiet = { ...withAlarms, alarms: (withAlarms.alarms ?? []).map((alarm) => ({ ...alarm, active: false })) }
      yield* statusOutcome(false, { failOnAlarm: true })(quiet)
    })
  )
})

/** Two Modbus devices behind one gateway or one IP: the same host. */
const onOneHost = () => ({ protocol: "modbus-tcp" as const, host: "10.0.1.20" })
/** Every device on this machine, as `pnpm bench` serves them. */
const onLoopback = () => ({ protocol: "modbus-tcp" as const, host: "127.0.0.1" })

describe("outages as the data saw them, counters and a shared host", () => {
  // The walk's outage: last read 12:10:00, called failing 12:10:08, answering again 12:12:20.
  const outageLog: EventLog = {
    now,
    capacity: 500,
    dropped: 0,
    events: [
      {
        id: 1,
        at: at(12, 10, 8),
        type: "device-failing",
        device: "energy-meter",
        reason: "timeout",
        error: "timed out",
        answeredBefore: true,
        lastReadAt: at(12, 10, 0)
      },
      {
        id: 2,
        at: at(12, 12, 20),
        type: "device-recovered",
        device: "energy-meter",
        downMs: 132_000,
        lastReadAt: at(12, 10, 0),
        failingSince: at(12, 10, 8),
        noDataMs: 140_000
      },
      {
        id: 4,
        at: at(12, 15, 0),
        type: "device-failing",
        device: "heat-pump",
        reason: "timeout",
        error: "timed out",
        lastReadAt: at(12, 14, 50)
      }
    ],
    valueEvents: [
      {
        id: 3,
        at: at(12, 12, 25),
        type: "counter-went-back",
        device: "energy-meter",
        point: "energy-total",
        unit: "KiloW-HR",
        from: 12_000.5,
        to: 4_270
      }
    ]
  }

  it("prints a failure from its last read, when it was detected, and an outage from the last read to the next", () => {
    const lines = formatEvents(outageLog, Number.POSITIVE_INFINITY, "all").split("\n")
    expect(lines.filter((line) => /^\d/.test(line))).toEqual([
      "12:10:08  energy-meter               failing: timed out (last read 12:10:00)",
      "12:12:20  energy-meter               answering again: no data 12:10:00–12:12:20 (2 min 20 s), detected 12:10:08",
      "12:12:25  energy-meter/energy-total  counter went back from 12000.5 to 4270 kWh: meter reset or replaced?",
      "12:15:00  heat-pump                  failing: timed out (last read 12:14:50)"
    ])
  })

  it("lists each recent failure under status with its span, and the counters that went back", () => {
    const recent = recentIncidents(outageLog)
    expect(recent.outages).toEqual([
      {
        device: "energy-meter",
        lastReadAt: at(12, 10, 0),
        detectedAt: at(12, 10, 8),
        recoveredAt: at(12, 12, 20),
        noDataMs: 140_000
      },
      { device: "heat-pump", lastReadAt: at(12, 14, 50), detectedAt: at(12, 15, 0) }
    ])
    expect(formatStatus(healthyGateway, recent).split("\n").slice(-4)).toEqual([
      "  2 devices failed in the last 15 min, see ot-gateway events:",
      "    energy-meter  no data 12:10:00–12:12:20 (2 min 20 s), detected 12:10:08",
      "    heat-pump     no data since 12:14:50, detected 12:15:00, still failing",
      "  energy-meter/energy-total at 12:12:25: counter went back from 12000.5 to 4270 kWh: meter reset or replaced?"
    ])
  })

  it("says how much faster a jumped counter rose than its fastest rise of the last hour", () => {
    const jumped: EventLog = {
      ...outageLog,
      events: [],
      valueEvents: [
        {
          id: 1,
          at: at(12, 12, 25),
          type: "counter-jumped",
          device: "energy-meter",
          point: "energy-total",
          unit: "KiloW-HR",
          from: 4_270,
          to: 12_000,
          elapsedMs: 145_000,
          usualPerHour: 3.6
        }
      ]
    }
    expect(formatEvents(jumped, Number.POSITIVE_INFINITY, "all")).toBe(
      "12:12:25  energy-meter/energy-total  counter jumped from 4270 to 12000 kWh in 2 min 25 s, more than 10× its fastest rise of the last hour (3.6 kWh/h): meter reset or replaced, or another device answering at its address?"
    )
  })

  it("says how much a counter rose against its reading when the gateway did not know its pace yet", () => {
    const early: EventLog = {
      ...outageLog,
      events: [],
      valueEvents: [
        {
          id: 1,
          at: at(12, 12, 25),
          type: "counter-jumped",
          device: "energy-meter",
          point: "energy-total",
          unit: "KiloW-HR",
          from: 12_055,
          to: 24_936,
          elapsedMs: 93_000
        },
        {
          id: 2,
          at: at(12, 13, 0),
          type: "counter-jumped",
          device: "energy-meter",
          point: "energy-total",
          unit: "KiloW-HR",
          from: 24_936,
          to: 30_000,
          elapsedMs: 60_000
        }
      ]
    }
    expect(formatEvents(early, Number.POSITIVE_INFINITY, "all").split("\n")).toEqual([
      "12:12:25  energy-meter/energy-total  counter jumped from 12055 to 24936 kWh: rose by 12881 kWh in 1 min 33 s, 1.1× its reading: meter reset or replaced, or another device answering at its address?",
      "12:13:00  energy-meter/energy-total  counter jumped from 24936 to 30000 kWh: rose by 5064 kWh in 1 min, 20 % of its reading: meter reset or replaced, or another device answering at its address?"
    ])
  })

  it("names the host two failing devices share, as the likelier cause than a switch", () => {
    const together: EventLog = {
      ...outageLog,
      events: [
        { id: 1, at: at(12, 10, 0), type: "device-failing", device: "meter-a", reason: "timeout", error: "timed out" },
        { id: 2, at: at(12, 10, 3), type: "device-failing", device: "meter-b", reason: "timeout", error: "timed out" }
      ],
      valueEvents: []
    }
    const lines = formatEvents(together, Number.POSITIVE_INFINITY, "all", onOneHost).split("\n")
    expect(lines[1]).toBe(
      "                   check: Others on 10.0.1.20 failed with it: check the host itself, its power and its network link before its config."
    )
    expect(lines.at(-1)).toContain("both on 10.0.1.20: likely the host itself, its power or its network link")
  })
})

/** A Modbus device on this machine, failing since `failingSince`. */
const failingOn = (id: string, failingSince: number): DeviceStatus => ({
  id,
  protocol: "modbus-tcp",
  status: "failing",
  pollIntervalMs: 5000,
  reason: "timeout",
  failingSince,
  host: "127.0.0.1",
  pointCount: 3,
  points: []
})

/** A request to the status page that found nothing, with `cause` as fetch gave it. */
const failed = (cause: unknown) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request: HttpClientRequest.get("http://127.0.0.1:8080"), cause })
  })

describe("a gateway that is not there", () => {
  it("says why in the socket's words: fetch's cause, then the error's own", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
      code: "ECONNREFUSED",
      address: "127.0.0.1",
      port: 8080
    })
    expect(transportReason(failed(new TypeError("fetch failed", { cause: refused })))).toBe(
      "connection refused by 127.0.0.1:8080"
    )
    expect(transportReason(failed(new Error("socket hang up")))).toBe("socket hang up")
    // Nothing more specific: the error's own words, never a guess.
    expect(transportReason(failed("no Error at all"))).toMatch(/Transport error/)
  })
})

describe("one outage of devices and broker on this machine", () => {
  const outage: EventLog = {
    now,
    capacity: 500,
    dropped: 0,
    events: [
      { id: 1, at: at(12, 0, 0), type: "gateway-started", version: "1.0.0", devices: 2 },
      { id: 2, at: at(12, 15, 35), type: "broker-disconnected", error: "connection closed by the peer" },
      { id: 3, at: at(12, 15, 36), type: "device-failing", device: "energy-meter", reason: "timeout", error: "" },
      { id: 4, at: at(12, 15, 41), type: "device-failing", device: "heat-pump", reason: "timeout", error: "" },
      { id: 5, at: at(12, 17, 43), type: "broker-connected", downMs: 128_000, retries: 14 }
    ]
  }

  it("names the broker with the devices when it sits on their host, loopback in any spelling", () => {
    const lines = formatEvents(outage, Number.POSITIVE_INFINITY, "all", onLoopback, { brokerHost: "localhost" })
    expect(lines).toContain(
      "2 devices (energy-meter, heat-pump) and the broker stopped answering within 6 s of each other, all on 127.0.0.1: likely the host itself, its power or its network link"
    )
    // A broker elsewhere is not part of it.
    expect(formatEvents(outage, Number.POSITIVE_INFINITY, "all", onLoopback, { brokerHost: "10.0.0.9" })).toContain(
      "2 devices (energy-meter, heat-pump) stopped answering within 5 s of each other, both on 127.0.0.1"
    )
    expect(adviseEvents(outage.events, onLoopback, "::1").get(3)?.sharedCause).toContain("and the broker")
  })

  it("says so in status while both are away", () => {
    const devices = [failingOn("energy-meter", at(12, 18, 20)), failingOn("heat-pump", at(12, 18, 22))]
    const broker = { ...failingGateway.broker, disconnectedSince: at(12, 18, 15) }
    expect(sharedCause(devices, broker)).toBe(
      "all 2 devices and the broker stopped answering within 7 s of each other, all on 127.0.0.1: likely the host itself, its power or its network link"
    )
    expect(sharedCause(devices)).toContain("all 2 devices stopped answering within 2 s of each other, both on")
    expect(formatStatus({ ...failingGateway, broker, devices })).toContain("all 2 devices and the broker")
  })

  it("sees no shared cause when one of them fails on the gateway's own port, and says what is wrong in one line", () => {
    const portTaken = {
      ...failingOn("heat-pump", at(12, 18, 22)),
      protocol: "bacnet-ip" as const,
      reason: "connection",
      lastError: bacnetPortFailure(47808, "0.0.0.0:47808 is in use by another program")
    }
    const devices = [failingOn("energy-meter", at(12, 18, 20)), portTaken]
    expect(sharedCause(devices)).toBeUndefined()
    // The others are judged without it: two on one host that failed together still share a cause.
    const three = [...devices, failingOn("pump", at(12, 18, 21))]
    expect(sharedCause(three)).toBe(
      "2 devices (energy-meter, pump) stopped answering within 1 s of each other, both on 127.0.0.1: likely the host itself, its power or its network link"
    )
    const report = statusJson({ ...failingGateway, devices })
    expect(report.problem).toMatch(/^2 of 2 devices failing/)
    expect(report.devices[1]).toMatchObject({ hints: { meaning: expect.stringContaining("holds its BACnet/IP port") } })
    expect(statusJson(healthyGateway)).not.toHaveProperty("problem")
  })

  it("reads the failed connects as the outage's retries, one problem, not two", () => {
    const recent = recentIncidents(outage)
    expect(recent.brokerOutageSpans).toEqual([
      { from: at(12, 15, 35), to: at(12, 17, 43), downMs: 128_000, retries: 14 }
    ])
    const back: GatewayStatus = {
      ...healthyGateway,
      broker: { ...healthyGateway.broker, connectedAt: at(12, 17, 43), connects: 2, failedConnects: 14 }
    }
    const lines = formatStatus(back, recent).split("\n")
    expect(lines[1]).toBe("  broker mqtt://localhost:1883: connected since 12:17:43")
    expect(lines).toContain(
      "  broker connection lost once in the last 15 min (12:15:35–12:17:43, 2 min 8 s, 14 retries), see ot-gateway events"
    )
    // Failed connects the outages listed do not cover are still counted on the broker's line.
    const more = { ...back, broker: { ...back.broker, failedConnects: 20 } }
    expect(formatStatus(more, recent).split("\n")[1]).toBe(
      "  broker mqtt://localhost:1883: connected since 12:17:43, 20 failed connects since start"
    )
  })

  it("says when the window reaches back past the gateway's start", () => {
    const started = at(12, 11, 30)
    const lines = formatEvents(outage, 20 * 60_000, "20m", onLoopback, { started }).split("\n")
    expect(lines[0]).toBe("the gateway started at 12:11:30: nothing is known before that")
    expect(formatEvents(outage, 5 * 60_000, "5m", onLoopback, { started })).not.toContain("gateway started at")
    expect(formatEvents({ ...outage, events: [] }, 20 * 60_000, "20m", onLoopback, { started })).toBe(
      "the gateway started at 12:11:30: nothing is known before that\nno events in the last 20m"
    )
  })
})
