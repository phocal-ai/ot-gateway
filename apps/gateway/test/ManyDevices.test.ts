/**
 * A site of many devices in a terminal: every command sums them up and names only what needs a look, the first few;
 * `--all`, a pipe and --json keep every device. The wording is the same everywhere (`3 devices`, never `device(s)`).
 */
import { describe, expect, it } from "@effect/vitest"
import type { DeviceStatus, GatewayStatus, MessageStatus } from "@ot-gateway/api"
import { parseConfig } from "@ot-gateway/core"
import { Effect } from "effect"
import { describeConfig, describeMistakes } from "../src/Cli.ts"
import { diffConfigs, formatDiff, sideOfConfig } from "../src/Diff.ts"
import { devicesFinding, type Finding, formatDoctor, report } from "../src/Doctor.ts"
import { type FleetGateway, formatGatewayPoints, formatGatewayStatus } from "../src/Fleet.ts"
import { mistakesText } from "../src/LoadConfig.ts"
import { briefMessages, failingDeviceLines } from "../src/MessagesReport.ts"
import {
  type DeviceRead,
  formatReadReport,
  formatReadSummary,
  type PointRead,
  type ReadReport
} from "../src/ReadOnce.ts"
import { formatStatus } from "../src/StatusReport.ts"
import { formatSummary } from "../src/Watch.ts"
import { count, named, nounFor, plural } from "../src/Words.ts"

const ids = (prefix: string, how: number) =>
  Array.from({ length: how }, (_, index) => `${prefix}-${String(index + 1).padStart(3, "0")}`)

describe("words", () => {
  it("counts with the noun in the right number, grouped digits, never (s)", () => {
    expect(plural(1, "device")).toBe("1 device")
    expect(plural(0, "device")).toBe("0 devices")
    expect(plural(3027, "point")).toBe("3,027 points")
    expect(plural(2, "address", "addresses")).toBe("2 addresses")
    expect(nounFor(1, "topic")).toBe("topic")
    expect(count(1_000_000)).toBe("1,000,000")
  })

  it("names a few, and of many the first five and how many more", () => {
    expect(named([])).toBe("")
    expect(named(["a"])).toBe("a")
    expect(named(["a", "b", "c"])).toBe("a, b and c")
    expect(named(ids("m", 15))).toBe("m-001, m-002, m-003, m-004, m-005 and 10 more")
    expect(named(ids("m", 4), 2)).toBe("m-001, m-002 and 2 more")
  })
})

describe("doctor with many devices", () => {
  const devices: ReadonlyArray<Finding> = [
    ...ids("ahu", 200).map((id): Finding => ({ check: "device", status: "ok", subject: id, message: "answered" })),
    ...ids("meter", 12).map((id): Finding => ({
      check: "device",
      status: "fail",
      subject: id,
      message: "cannot reach it",
      code: "device-unreachable",
      hint: "is it on?",
      next: `ot-gateway probe ${id}`
    }))
  ]
  const doctor = report("ot-gateway.json", [
    { check: "config", status: "ok", message: "s/b gateway main, 212 devices" },
    ...devices,
    { check: "clock", status: "ok", message: "fine" }
  ])

  it("sums the devices up in a terminal and names the failing ones, the first five", () => {
    expect(formatDoctor(doctor, { brief: true }).split("\n")).toEqual([
      "✓ config     s/b gateway main, 212 devices",
      "✗ devices    200 of 212 devices ok, 12 failing",
      "✗ meter-001  cannot reach it",
      "✗ meter-002  cannot reach it",
      "✗ meter-003  cannot reach it",
      "✗ meter-004  cannot reach it",
      "✗ meter-005  cannot reach it",
      "             and 7 more: ot-gateway doctor --all lists every device",
      "✓ clock      fine",
      "",
      "12 problems. Next: ot-gateway probe meter-001"
    ])
  })

  it("lists every device with --all, and in a pipe with the hints", () => {
    expect(formatDoctor(doctor, { brief: true, all: true }).split("\n")).toHaveLength(1 + 212 + 1 + 2)
    const piped = formatDoctor(doctor, { brief: false }).split("\n")
    expect(piped).toContain("✓ ahu-200    answered")
    expect(piped).toContain("    next: ot-gateway probe meter-012")
  })

  it("sums up one device too, and lists it with --all", () => {
    const one = report("ot-gateway.json", [
      { check: "device", status: "ok", subject: "demo-room", message: "bacnet-ip device 1001: answered" }
    ])
    expect(formatDoctor(one, { brief: true })).toBe("✓ devices  1 device, all ok\n\nNo problems.")
    expect(formatDoctor(one, { brief: true, all: true })).toBe(
      "✓ demo-room  bacnet-ip device 1001: answered\n\nNo problems."
    )
  })

  it("says all ok, or what was not checked", () => {
    const ok = ids("a", 3).map((id): Finding => ({ check: "device", status: "ok", subject: id, message: "ok" }))
    expect(devicesFinding(ok)).toMatchObject({ status: "ok", message: "3 devices, all ok" })
    expect(
      devicesFinding([...ok, { check: "device", status: "skip", subject: "x", message: "no points to read" }])
    ).toMatchObject({ status: "ok", message: "3 of 4 devices ok, 1 not checked" })
  })
})

const bigConfig = Effect.runSync(
  parseConfig(
    JSON.stringify({
      site: "s",
      building: "b",
      id: "main",
      mqtt: { url: "mqtt://127.0.0.1:1883" },
      devices: [
        ...ids("ahu", 20).map((id) => ({
          protocol: "simulator",
          id,
          points: [{ id: "t", name: "T", waveform: "sine", min: 0, max: 1 }]
        })),
        {
          protocol: "modbus-tcp",
          id: "meter",
          host: "10.0.0.5",
          points: [
            {
              id: "setpoint",
              name: "Setpoint",
              table: "holding",
              address: 0,
              dataType: "uint16",
              writable: true,
              limits: { min: 0, max: 10 }
            }
          ]
        }
      ]
    })
  )
)

const smallConfig = (devices: ReadonlyArray<unknown>) =>
  Effect.runSync(
    parseConfig(JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://127.0.0.1:1883" }, devices }))
  )

describe("check with many devices", () => {
  it("sums them up by protocol in a terminal, and lists each otherwise", () => {
    const brief = describeConfig(bigConfig, { brief: true }).split("\n")
    expect(brief.slice(-5)).toEqual([
      "✓ devices  21 devices, 21 points, 1 writable",
      "             simulator   20 devices, 20 points",
      "             modbus-tcp  1 device, 1 point, 1 writable",
      "",
      "Config ok, 1 warning."
    ])
    const all = describeConfig(bigConfig).split("\n")
    expect(all).toContain("             ahu-020  simulator simulated, 1 point, every 5 s")
    expect(all.filter((line) => line.trimStart().startsWith("ahu-"))).toHaveLength(20)
  })

  it("sums up one device too, says when there are none, and names the protocol", () => {
    const one = smallConfig([
      { protocol: "simulator", id: "room", points: [{ id: "t", name: "T", waveform: "sine", min: 0, max: 1 }] }
    ])
    const brief = describeConfig(one, { brief: true, next: "ot-gateway doctor" }).split("\n")
    expect(brief).toContain("✓ devices  1 device, 1 point, simulator")
    expect(brief.some((line) => line.includes("room"))).toBe(false)
    expect(brief.at(-1)).toBe("Config ok, 1 warning. Next: ot-gateway doctor")
    expect(describeConfig(one)).toContain("\n             room  simulator simulated, 1 point, every 5 s")
    const none = describeConfig(smallConfig([]), { brief: true }).split("\n")
    expect(none).toContain("! devices  none yet: ot-gateway discover finds them")
    expect(none.at(-1)).toBe("Config ok, 2 warnings.")
  })

  it("lists a few mistakes each with its path, and groups many by what is wrong", () => {
    expect(
      describeMistakes("bad.json", [
        { path: "site", message: "Expected a slug" },
        { path: "devices.0.host", message: "Missing key" }
      ]).split("\n")
    ).toEqual([
      "✗ config  bad.json is not valid: 2 mistakes",
      "          site            Expected a slug",
      "          devices.0.host  Missing key"
    ])
    const many = Array.from({ length: 40 }, (_, index) => ({
      path: `devices.${index}.points.0.name`,
      message: "Missing key"
    }))
    expect(describeMistakes("bad.json", [...many, { path: "site", message: "Expected a slug" }]).split("\n")).toEqual([
      "✗ config  bad.json is not valid: 41 mistakes",
      "          Missing key: devices.0.points.0.name, devices.1.points.0.name, devices.2.points.0.name and 37 more",
      "          Expected a slug: site",
      "          check --json lists every mistake with its path"
    ])
  })

  it("puts a mistake repeated on every point in one line, with its first paths", () => {
    const issues = [
      ...Array.from({ length: 3000 }, (_, index) => ({
        path: `devices.${Math.floor(index / 15)}.points.${index % 15}.name`,
        message: "Missing key"
      })),
      { path: "site", message: "Expected a slug" }
    ]
    expect(mistakesText(issues).split("\n")).toEqual([
      "3,001 mistakes, 2 kinds",
      "Missing key",
      "  at devices.0.points.0.name, devices.0.points.1.name, devices.0.points.2.name and 2,997 more",
      "Expected a slug",
      "  at site",
      "check --json lists every mistake with its path"
    ])
  })
})

const point = (device: string, id: string, error?: string): PointRead => ({
  id,
  name: id,
  topic: `s/b/${device}/${id}`,
  ok: error === undefined,
  ...(error === undefined ? { value: 21 } : { error: { code: "device-exception", message: error } })
})

const read = (device: string, points: ReadonlyArray<PointRead>, error?: string): DeviceRead => ({
  device,
  protocol: error === undefined ? "simulator" : "modbus-tcp",
  target: error === undefined ? "simulated" : "10.0.0.5:502, unit 1",
  ok: error === undefined && points.every((each) => each.ok),
  ...(error === undefined ? {} : { error: { code: "device-unreachable", message: error } }),
  points,
  durationMs: 1
})

describe("read with many points", () => {
  const readReport: ReadReport = {
    ok: false,
    site: "s",
    building: "b",
    at: 0,
    durationMs: 1200,
    summary: { devices: 33, points: 66, read: 50, failed: 16 },
    devices: [
      ...ids("ahu", 25).map((id) => read(id, [point(id, "t"), point(id, "h")])),
      read("ahu-099", [point("ahu-099", "t", "exception 2"), point("ahu-099", "h", "exception 2")]),
      ...ids("meter", 7).map((id) => read(id, [], "could not connect"))
    ]
  }

  it("says how many were read and what failed, the first few, and how to see the values", () => {
    expect(formatReadSummary(readReport).split("\n")).toEqual([
      "50 of 66 points read, 16 failed, in 1.2 s",
      "7 devices not read:",
      "  meter-001  could not connect",
      "  meter-002  could not connect",
      "  meter-003  could not connect",
      "  meter-004  could not connect",
      "  meter-005  could not connect",
      "  and 2 more",
      "2 points failed:",
      "  ahu-099/t  exception 2",
      "  ahu-099/h  exception 2",
      "",
      "--all shows every value, read <device> one device's"
    ])
  })

  it("still lists every value for a pipe", () => {
    expect(
      formatReadReport(readReport)
        .split("\n")
        .filter((line) => line.startsWith("ahu-0"))
    ).toHaveLength(52)
  })
})

const device = (id: string, status: "ok" | "failing"): DeviceStatus => ({
  id,
  protocol: "modbus-tcp",
  status,
  pollIntervalMs: 5000,
  pointCount: 2,
  points: [],
  ...(status === "ok"
    ? { lastSuccess: 1_000_000 - 1000 }
    : { reason: "connection", failingSince: 1_000_000 - 30_000, lastError: "could not connect" })
})

describe("status with many devices", () => {
  const status: GatewayStatus = {
    site: "s",
    building: "b",
    id: "main",
    since: 1_000_000 - 60_000,
    now: 1_000_000,
    configSince: 1_000_000 - 60_000,
    broker: {
      url: "mqtt://localhost:1883",
      connected: true,
      connectedAt: 1_000_000 - 60_000,
      connects: 1,
      failedConnects: 0,
      published: 10,
      publishFailures: 0
    },
    devices: [...ids("ahu", 40).map((id) => device(id, "ok")), ...ids("meter", 8).map((id) => device(id, "failing"))],
    commands: []
  }

  it("counts the devices and lists only the failing ones, each hint once", () => {
    const lines = formatStatus(status, undefined, { brief: true }).split("\n")
    expect(lines[1]).toMatch(/^ {2}broker /)
    expect(lines[2]).toBe("  48 devices: 40 ok, 8 failing")
    expect(lines.filter((line) => line.startsWith("    meter-"))).toHaveLength(5)
    expect(lines.filter((line) => line.includes("check: "))).toHaveLength(1)
    expect(lines).toContain("    and 3 more failing")
    expect(lines).toContain("    --all lists every device")
    expect(lines.some((line) => line.includes("ahu-001"))).toBe(false)
  })

  it("puts the failing devices before the ones still starting", () => {
    const starting: DeviceStatus = { ...device("x", "ok"), status: "starting" }
    const restarted: GatewayStatus = {
      ...status,
      devices: [
        ...ids("new", 8).map((id) => ({ ...starting, id })),
        ...ids("ahu", 10).map((id) => device(id, "ok")),
        device("meter", "failing")
      ]
    }
    const lines = formatStatus(restarted, undefined, { brief: true }).split("\n")
    expect(lines[3]).toMatch(/^ {4}meter +failing /)
    expect(lines).toContain("    and 4 more starting")
  })

  it("lists every device and every hint otherwise", () => {
    const lines = formatStatus(status).split("\n")
    expect(lines[2]).toBe("  48 devices, 8 failing")
    expect(lines.filter((line) => /^ {4}(ahu|meter)-/.test(line))).toHaveLength(48)
    expect(lines.filter((line) => line.includes("check: "))).toHaveLength(8)
  })
})

describe("gateways with many devices and points", () => {
  const gateway: FleetGateway = {
    site: "s",
    building: "b",
    id: "main",
    name: "s/b/main",
    status: "online",
    devices: [
      ...ids("ahu", 30).map((id) => ({ id, status: "ok" as const })),
      ...ids("meter", 6).map((id) => ({ id, status: "failing" as const, reason: "connection" as const }))
    ]
  }

  it("lists only the failing devices of a gateway, the first few", () => {
    const lines = formatGatewayStatus(gateway, 0, { brief: true }).split("\n")
    expect(lines[0]).toMatch(/36 devices: 30 ok, 6 failing/)
    expect(lines.slice(1)).toEqual([
      "  meter-001  failing (connection)",
      "  meter-002  failing (connection)",
      "  meter-003  failing (connection)",
      "  meter-004  failing (connection)",
      "  meter-005  failing (connection)",
      "  and 1 more failing",
      "  --all lists every device"
    ])
    expect(formatGatewayStatus(gateway, 0).split("\n")).toHaveLength(37)
  })

  it("counts a gateway's points and names the writable ones", () => {
    const points = ids("ahu", 30).map((id) => ({
      device: id,
      point: "t",
      topic: `s/b/${id}/t`,
      name: "T",
      writable: id === "ahu-007"
    }))
    expect(formatGatewayPoints({ gateway: "s/b/main", status: "online", points }, { brief: true }).split("\n")).toEqual(
      [
        "s/b/main: 30 points on 30 devices, 1 writable:",
        "  ahu-007/t  T  writable",
        "  --all lists every point, --json each with its topic"
      ]
    )
  })
})

const side = (prefix: string) =>
  sideOfConfig(
    Effect.runSync(
      parseConfig(
        JSON.stringify({
          site: "s",
          building: "b",
          id: "main",
          mqtt: { url: "mqtt://127.0.0.1:1883" },
          devices: ids(prefix, 12).map((id) => ({
            protocol: "simulator",
            id,
            points: ["a", "b", "c"].map((each) => ({ id: each, name: each, waveform: "sine", min: 0, max: 1 }))
          }))
        })
      )
    )
  )

describe("diff with many devices", () => {
  it("sums the topics up per device in a terminal, the first ten devices", () => {
    const diff = diffConfigs(side("ahu"), side("fcu"))
    const lines = formatDiff(diff, "title", { command: "ot-gateway" }, { brief: true }).split("\n")
    expect(lines).toContain("  + s/b/fcu-001/…  3 new topics")
    expect(lines).toContain("  … and 2 more devices")
    expect(lines.filter((line) => line.startsWith("  + "))).toHaveLength(10)
    expect(formatDiff(diff, "title", { command: "ot-gateway" }).split("\n")).toContain("  + s/b/fcu-012/c  new topic")
  })
})

const message = (topic: string, sent: number, delivered: number): MessageStatus => ({
  topic,
  payload: "{}",
  truncated: false,
  retained: false,
  at: 0,
  count: sent,
  delivered,
  notSent: 0,
  lost: 0
})

describe("messages and watch with many devices", () => {
  it("names many failing devices in one line", () => {
    const status = {
      now: 0,
      devices: ids("meter", 9).map((id) => ({ id, status: "failing" as const }))
    }
    expect(failingDeviceLines(status, [])).toEqual([
      "  (9 failing devices send no values: meter-001, meter-002, meter-003, meter-004, meter-005 and 4 more; ot-gateway status says why)"
    ])
  })

  it("picks the topics that did not reach the broker, then the busiest", () => {
    const messages = [
      ...ids("ahu", 30).map((id, index) => message(`s/b/${id}/t`, index, index)),
      message("s/b/meter/p", 5, 2)
    ]
    const picked = briefMessages(messages)
    expect(picked.shortCount).toBe(1)
    expect(picked.short.map((each) => each.topic)).toEqual(["s/b/meter/p"])
    expect(picked.busiest.map((each) => each.topic)).toEqual([
      "s/b/ahu-030/t",
      "s/b/ahu-029/t",
      "s/b/ahu-028/t",
      "s/b/ahu-027/t",
      "s/b/ahu-026/t"
    ])
  })

  it("names a few silent devices in watch's summary, all of a device's points as a count", () => {
    const summary = {
      event: "summary" as const,
      seconds: 10,
      messages: 4,
      points: 33,
      arrived: 3,
      missing: 30,
      devices: [
        { id: "ok", arrived: ["a", "b", "c"], missing: [], onChange: [] },
        ...ids("ahu", 7).map((id) => ({ id, arrived: [], missing: ["t", "h", "c", "d"], onChange: [] })),
        { id: "fan", arrived: [], missing: ["a", "b"], onChange: [] }
      ]
    }
    expect(formatSummary(summary)).toBe(
      "-- 3 of 33 points sent a value in 10 s (4 messages); none from ahu-001: all 4; ahu-002: all 4; ahu-003: all 4; ahu-004: all 4; ahu-005: all 4; and 3 more devices"
    )
  })
})
