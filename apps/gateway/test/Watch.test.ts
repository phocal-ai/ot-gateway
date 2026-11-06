/** `watch` and `status`: what they print. */
import { describe, expect, it } from "@effect/vitest"
import type { GatewayStatus } from "@ot-gateway/api"
import { ago, formatStatus } from "../src/StatusReport.ts"
import { formatMessage, watchFilter } from "../src/Watch.ts"

describe("watch", () => {
  it("subscribes to everything under the site and building", () => {
    expect(watchFilter({ site: "vienna-hq", building: "main" })).toBe("vienna-hq/main/#")
  })

  it("prints one line per message, marks retained ones and cuts long payloads", () => {
    const at = new Date(2026, 10, 5, 9, 4, 7)
    expect(formatMessage({ topic: "s/b/ahu-1/temp", payload: '{"value":21.5}', retain: false }, at)).toBe(
      '09:04:07 s/b/ahu-1/temp {"value":21.5}'
    )
    expect(formatMessage({ topic: "s/b/ahu-1/temp/$meta", payload: '{\n  "unit": "x"\n}', retain: true }, at)).toBe(
      '09:04:07 retained s/b/ahu-1/temp/$meta { "unit": "x" }'
    )
    const long = formatMessage({ topic: "t", payload: "x".repeat(1000), retain: false }, at)
    expect(long.length).toBeLessThan(320)
    expect(long.endsWith("…")).toBe(true)
  })
})

describe("status", () => {
  it("says how long ago as coarsely as a glance needs", () => {
    expect(ago(12_000)).toBe("12 s")
    expect(ago(4 * 60_000)).toBe("4 min")
    expect(ago(3 * 3_600_000)).toBe("3 h")
    expect(ago(3 * 86_400_000)).toBe("3 d")
    expect(ago(-500)).toBe("0 s")
  })

  it("prints the gateway, its broker and one aligned line per device", () => {
    const status: GatewayStatus = {
      site: "s",
      building: "b",
      id: "main",
      since: 0,
      now: 600_000,
      broker: { url: "mqtt://localhost:1883", connected: false },
      buffer: { path: "buf.sqlite", rows: 42, maxRows: 1000, dropped: 3 },
      devices: [
        { id: "ahu-1", protocol: "simulator", status: "ok", pollIntervalMs: 2000, lastSuccess: 598_000, points: [] },
        {
          id: "main-meter",
          protocol: "modbus-tcp",
          status: "failing",
          pollIntervalMs: 5000,
          reason: "Timeout",
          points: []
        }
      ],
      commands: []
    }
    expect(formatStatus(status).split("\n")).toEqual([
      "s/b gateway main, up 10 min",
      "  broker mqtt://localhost:1883: NOT CONNECTED",
      "  buffer: 42 of 1000 message(s) waiting, 3 DROPPED since start",
      "  2 device(s), 1 failing",
      "    ahu-1       ok       simulator, 0 point(s), read 2 s ago",
      "    main-meter  failing  modbus-tcp, 0 point(s), no read yet (Timeout)"
    ])
  })
})
