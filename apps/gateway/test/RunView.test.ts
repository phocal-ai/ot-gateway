import { describe, expect, it } from "@effect/vitest"
import { humanRun } from "../src/Cli.ts"
import { changeLine, overviewLines, settled } from "../src/RunView.ts"
import { plainUi } from "../src/Ui.ts"

const config = {
  site: "hall",
  building: "main",
  mqtt: { url: "mqtt://localhost:1883" },
  devices: [{ id: "room" }, { id: "meter" }]
} as const

describe("run in a terminal", () => {
  it("shows the overview and the changes only when both ends are a terminal and --verbose is not given", () => {
    expect(humanRun(false, true, true)).toBe(true)
    expect(humanRun(true, true, true)).toBe(false)
    expect(humanRun(false, false, true)).toBe(false)
    expect(humanRun(false, true, undefined)).toBe(false)
  })

  it("waits for the broker and every device before the overview", () => {
    const broker = { url: "mqtt://localhost:1883", connected: true }
    const ok = { id: "room", status: "ok", pointCount: 3 } as const
    expect(settled({ broker, devices: [ok] })).toBe(true)
    expect(settled({ broker, devices: [ok, { id: "meter", status: "starting", pointCount: 2 }] })).toBe(false)
    expect(settled({ broker: { ...broker, connected: false }, devices: [ok] })).toBe(false)
    expect(settled({ broker: { ...broker, connected: false, lastError: "refused" }, devices: [ok] })).toBe(true)
  })

  it("says in a few lines what runs: the broker, each device, the status page, the topics and how to stop", () => {
    const lines = overviewLines(
      plainUi,
      config,
      {
        broker: { url: "mqtt://localhost:1883", connected: true },
        devices: [
          { id: "room", status: "ok", pointCount: 3 },
          { id: "meter", status: "failing", pointCount: 2, lastError: "could not connect: connection refused" }
        ]
      },
      "http://127.0.0.1:8080"
    )
    expect(lines).toEqual([
      "✔ Broker mqtt://localhost:1883 connected",
      "✔ room: 3 points read",
      "✖ meter: could not connect: connection refused",
      "",
      "  Status page  http://127.0.0.1:8080\n  Topics       hall/main/<device>/<point>\n  Stop         Ctrl-C  the changes that matter show up below"
    ])
  })

  it("marks a change by which way it went", () => {
    const at = new Date(2026, 10, 27, 10, 40, 7).getTime()
    const failing = changeLine(
      plainUi,
      { id: 2, at, type: "device-failing", device: "room", reason: "timeout", error: "no reply" },
      at
    )
    expect(failing).toMatch(/^✖ 10:40:07 {2}room {2}failing: no reply/)
    const back = changeLine(plainUi, { id: 3, at, type: "broker-connected", retries: 0 }, at)
    expect(back).toMatch(/^✔ 10:40:07 {2}broker/)
  })
})
