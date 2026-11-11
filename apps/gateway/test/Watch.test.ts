/** `watch` and `status`: what they print, and `watch --seconds` against the in-process test broker over real TCP. */
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { describe, expect, it } from "@effect/vitest"
import type { GatewayStatus } from "@ot-gateway/api"
import { parseConfig } from "@ot-gateway/core"
import { makeBrokerControl, serveMqtt } from "@ot-gateway/mqtt"
import { Effect } from "effect"
import { TestConsole } from "effect/testing"
import { publishOnce } from "../src/Broker.ts"
import { ago, formatStatus } from "../src/StatusReport.ts"
import { formatMessage, watch, watchFilter } from "../src/Watch.ts"

const configFor = (port: number) =>
  parseConfig(JSON.stringify({ site: "s", building: "b", mqtt: { url: `mqtt://127.0.0.1:${port}` }, devices: [] }))

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
      expect(lines).toEqual([expect.stringMatching(/^\d\d:\d\d:\d\d retained s\/b\/meter\/power 42$/)])
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer))
  )
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
      broker: {
        url: "mqtt://localhost:1883",
        connected: false,
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
          lastSuccess: 598_000,
          pointCount: 0,
          points: []
        },
        {
          id: "energy-meter",
          protocol: "modbus-tcp",
          status: "failing",
          pollIntervalMs: 5000,
          reason: "Timeout",
          pointCount: 0,
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
      "    ventilation-1  ok       simulator, 0 point(s), read 2 s ago",
      "    energy-meter   failing  modbus-tcp, 0 point(s), no read yet (Timeout)"
    ])
  })
})
