/**
 * The gateway's log ring and `ot-gateway logs`: the ring's line and byte bounds, that secrets never reach it, the
 * `/api/logs` endpoint, the command's text and `--json`, `--follow`, and a gateway older than the command.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import type { GatewayStatus, LogPage } from "@ot-gateway/api"
import { makeHealthRegistry, parseConfig } from "@ot-gateway/core"
import { Cause, Effect, Fiber, Layer, Logger, Option, Redacted } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { createServer as createHttpServer } from "node:http"
import { createServer } from "node:net"
import { GatewayEvents, makeGatewayEvents } from "../src/Events.ts"
import { targetOf } from "../src/GatewayTarget.ts"
import {
  GatewayLogs,
  gatewayLogsLayer,
  LOG_LIMITS,
  makeGatewayLogs,
  MAX_ANNOTATION,
  MAX_MESSAGE,
  REDACTED
} from "../src/LogRing.ts"
import { followLogs, formatLogLine, logsReport } from "../src/LogsReport.ts"
import { localTime } from "../src/Output.ts"
import { historyHandler, makeStatusState, serveStatus } from "../src/Status.ts"

/** Runs `effect` with the ring's logger as the only logger. */
const intoRing = (logs: ReturnType<typeof makeGatewayLogs>) => Effect.provide(Logger.layer([logs.logger]))

const small = { important: { lines: 3, bytes: 100_000 }, info: { lines: 2, bytes: 100_000 } }

describe("the log ring", () => {
  it.effect("keeps the latest lines of each ring, and info cannot push a warning out", () =>
    Effect.gen(function* () {
      const logs = makeGatewayLogs(small)
      yield* Effect.gen(function* () {
        for (let index = 1; index <= 5; index++) yield* Effect.logWarning(`warning ${index}`)
        for (let index = 1; index <= 50; index++) yield* Effect.logInfo(`info ${index}`)
        yield* Effect.logError("broken")
        yield* Effect.logDebug("not kept")
      }).pipe(intoRing(logs))
      const page = yield* logs.page()
      expect(page.lines.map((line) => line.message)).toEqual(["warning 4", "warning 5", "info 49", "info 50", "broken"])
      // In the order they were logged, across both rings.
      expect(page.lines.map((line) => line.id)).toEqual([4, 5, 54, 55, 56])
      expect(page.dropped).toBe(3 + 48)
      expect(page.maxLines).toBe(5)
      expect((yield* logs.page({ level: "warn" })).lines.map((line) => line.message)).toEqual([
        "warning 4",
        "warning 5",
        "broken"
      ])
      expect((yield* logs.page({ level: "error" })).lines.map((line) => line.level)).toEqual(["ERROR"])
      expect((yield* logs.page({ after: 54 })).lines.map((line) => line.id)).toEqual([55, 56])
      // An id it never gave (the asker saw an earlier run): everything it keeps.
      expect((yield* logs.page({ after: 1_000 })).lines).toHaveLength(5)
    })
  )

  it.effect("stays within its bytes, and cuts long messages and annotations", () =>
    Effect.gen(function* () {
      const logs = makeGatewayLogs({ important: { lines: 100, bytes: 3_000 }, info: { lines: 100, bytes: 3_000 } })
      const long = "x".repeat(5_000)
      yield* Effect.gen(function* () {
        for (let index = 0; index < 10; index++) {
          yield* Effect.logWarning(`${index} ${long}`).pipe(Effect.annotateLogs({ device: "meter", detail: long }))
        }
      }).pipe(intoRing(logs))
      const page = yield* logs.page()
      const [line] = page.lines
      expect(page.lines).toHaveLength(2)
      expect(page.dropped).toBe(8)
      expect(line?.message).toHaveLength(MAX_MESSAGE + 1)
      expect(line?.message.startsWith("8 xxx")).toBe(true)
      expect(line?.annotations?.["device"]).toBe("meter")
      expect(line?.annotations?.["detail"]).toHaveLength(MAX_ANNOTATION + 1)
      expect(line?.cut).toBe(true)
      expect(JSON.stringify(page.lines).length).toBeLessThan(2 * 3_000)
    })
  )

  it("fits the budget at its fullest", () => {
    expect(LOG_LIMITS.important.lines + LOG_LIMITS.info.lines).toBe(500)
    expect(LOG_LIMITS.important.bytes + LOG_LIMITS.info.bytes).toBe(256 * 1024)
  })

  it.effect("never keeps a secret: Redacted values, the broker password and the edit token", () =>
    Effect.gen(function* () {
      const logs = makeGatewayLogs()
      logs.addSecrets([Redacted.make("s3cret-pass"), "edit-token-123", ""])
      yield* Effect.gen(function* () {
        yield* Effect.logWarning("connect", Redacted.make("plain-redacted")).pipe(
          Effect.annotateLogs({ password: Redacted.make("annotated-redacted") })
        )
        yield* Effect.logError("broker refused s3cret-pass").pipe(
          Effect.annotateLogs({ url: "mqtt://user:s3cret-pass@host", "edit-token-123": "key" })
        )
        yield* Effect.logError("failed", Cause.fail(new Error("token edit-token-123 rejected")))
        yield* Effect.logInfo({ nested: { token: "edit-token-123" } })
      }).pipe(intoRing(logs))
      const kept = JSON.stringify((yield* logs.page()).lines)
      for (const secret of ["s3cret-pass", "edit-token-123", "plain-redacted", "annotated-redacted"]) {
        expect(kept).not.toContain(secret)
      }
      expect(kept).toContain(REDACTED)
      const [, refused, failed] = (yield* logs.page()).lines
      expect(refused?.message).toBe(`broker refused ${REDACTED}`)
      expect(refused?.annotations).toEqual({ url: `mqtt://user:${REDACTED}@host`, [REDACTED]: "key" })
      expect(failed?.cause).toContain(`token ${REDACTED} rejected`)
    })
  )

  it.effect("joins the loggers in place instead of replacing them", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = []
      const page = yield* Effect.gen(function* () {
        yield* Effect.logWarning("both")
        return yield* (yield* GatewayLogs).page()
      }).pipe(
        Effect.provide(gatewayLogsLayer()),
        Effect.provide(Logger.layer([Logger.make((options) => seen.push(options.message))]))
      )
      expect(seen).toEqual([["both"]])
      expect(page.lines.map((line) => line.message)).toEqual(["both"])
    })
  )
})

/** A moment today on this machine's clock, so the expected lines hold in any time zone. */
const at = (hours: number, minutes: number, seconds: number) =>
  new Date(2026, 10, 11, hours, minutes, seconds).getTime()
const now = at(12, 19, 30)

describe("logs as text", () => {
  it("prints time, level, message, annotations, and the cause's first lines under it", () => {
    const line = formatLogLine(
      {
        id: 1,
        at: at(12, 18, 20),
        level: "WARN",
        message: "write refused",
        annotations: { device: "meter", error: "not writable" },
        cause: "Error: one\n    at a\n    at b\n    at c\n    at d\n    at e"
      },
      now
    )
    const time = localTime(at(12, 18, 20), now)
    const indent = " ".repeat(time.length + 2)
    expect(line.split("\n")).toEqual([
      `${time}  WARN   write refused  device=meter error="not writable"`,
      `${indent}Error: one`,
      `${indent}    at a`,
      `${indent}    at b`,
      `${indent}    at c`,
      `${indent}(2 more; --json has them)`
    ])
  })

  it("prints no terminal control characters from the gateway", () => {
    expect(formatLogLine({ id: 1, at: now, level: "INFO", message: "a\u001b[31mb" }, now)).toContain("a?[31mb")
  })

  it.effect("follows new lines, says when the gateway is away or restarted", () =>
    Effect.gen(function* () {
      const page = (lines: LogPage["lines"]): LogPage => ({ now, lines, maxLines: 500, maxBytes: 1, dropped: 0 })
      const answers = [
        Effect.succeed(Option.some(page([{ id: 5, at: now, level: "ERROR", message: "decode failed" }]))),
        Effect.succeed(Option.none()),
        Effect.succeed(Option.some(page([{ id: 1, at: now, level: "INFO", message: "started" }])))
      ]
      const asked: Array<number> = []
      const follow = yield* followLogs(
        (after) => {
          asked.push(after)
          return answers.shift() ?? Effect.succeed(Option.some(page([])))
        },
        4,
        { json: false }
      ).pipe(Effect.forkChild)
      for (let poll = 0; poll < 4; poll++) yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(follow)
      expect(asked).toEqual([4, 5, 5, 1])
      expect((yield* TestConsole.logLines).map(String)).toEqual([
        `${localTime(now)}  ERROR  decode failed`,
        `${localTime(now)}  INFO   started`
      ])
      expect((yield* TestConsole.errorLines).map(String)).toEqual([
        "lost the gateway, asking again: the gateway at that address serves no logs now (an older version?)",
        "the gateway answers again",
        "the gateway restarted: its log starts over"
      ])
    }).pipe(Effect.provide(TestConsole.layer))
  )
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

const gatewayJson = (port: number) =>
  JSON.stringify({
    site: "plant-1",
    building: "hall-a",
    id: "main",
    mqtt: { url: "mqtt://broker" },
    status: { port, webRoot: "/nonexistent" },
    devices: [
      {
        protocol: "modbus-tcp",
        id: "energy-meter",
        host: "10.0.1.1",
        points: [
          { id: "active-power", name: "Power", unit: "unit:KiloW", table: "holding", address: 0, dataType: "float32" }
        ]
      }
    ]
  })

describe("against a running status page", () => {
  it.live(
    "serves /api/logs, and logs prints it as text and JSON",
    () =>
      Effect.gen(function* () {
        const port = yield* freePort
        const config = yield* parseConfig(gatewayJson(port))
        const state = makeStatusState(config, makeHealthRegistry(["energy-meter"]), Date.now())
        const events = makeGatewayEvents(yield* Effect.clockWith(Effect.succeed))
        const logs = makeGatewayLogs()
        logs.addSecrets(["hunter2"])
        yield* Effect.gen(function* () {
          yield* Effect.logInfo("gateway started").pipe(Effect.annotateLogs({ devices: 1 }))
          yield* Effect.logWarning("energy-meter failing").pipe(
            Effect.annotateLogs({ device: "energy-meter", error: "password hunter2 refused" })
          )
        }).pipe(intoRing(logs))
        const server = yield* serveStatus(
          config.status ?? { bindAddress: "127.0.0.1", port },
          state,
          historyHandler(config, undefined)
        ).pipe(
          Effect.provide([NodeServices.layer, Layer.succeed(GatewayEvents, events), Layer.succeed(GatewayLogs, logs)]),
          Effect.forkChild
        )
        yield* Effect.sleep("300 millis")
        const target = yield* targetOf("ot-gateway.json", config, undefined)

        yield* logsReport(target, { since: "1h", sinceMs: 3_600_000, level: "info" })
        // The server's own "status page" line goes to the test console too: the report is the last two.
        const text = (yield* TestConsole.logLines).map(String).slice(-2)
        expect(text[0]).toBe(`plant-1/hall-a gateway main at http://127.0.0.1:${port}: log lines`)
        const printed = text[1]?.split("\n") ?? []
        expect(printed).toHaveLength(2)
        expect(printed[0]).toMatch(/^\S+ {2}INFO {3}gateway started {2}devices=1$/)
        expect(printed[1]).toMatch(
          /^\S+ {2}WARN {3}energy-meter failing {2}device=energy-meter error="password <redacted> refused"$/
        )

        yield* logsReport(target, { since: "1h", sinceMs: 3_600_000, level: "warn", json: true })
        const json: unknown = JSON.parse((yield* TestConsole.logLines).map(String).at(-1) ?? "")
        expect(json).toMatchObject({
          ok: true,
          gateway: { site: "plant-1", building: "hall-a", id: "main" },
          maxLines: 500,
          dropped: 0,
          lines: [{ id: 2, level: "WARN", message: "energy-meter failing", annotations: { device: "energy-meter" } }]
        })
        expect(JSON.stringify(json)).not.toContain("hunter2")

        yield* logsReport(target, { since: "1h", sinceMs: 3_600_000, level: "error" })
        expect((yield* TestConsole.logLines).map(String).at(-1)).toBe("  no errors in the last 1h")
        yield* Fiber.interrupt(server)
      }).pipe(Effect.provide(TestConsole.layer)),
    20_000
  )

  const status: GatewayStatus = {
    site: "plant-1",
    building: "hall-a",
    id: "main",
    since: Date.now() - 60_000,
    now: Date.now(),
    configSince: Date.now() - 60_000,
    broker: {
      url: "mqtt://broker:1883",
      connected: true,
      connects: 1,
      failedConnects: 0,
      published: 0,
      publishFailures: 0
    },
    devices: [],
    commands: []
  }

  /** A gateway from before `/api/logs`: its status, and for any other path a 404 or (with its page built) the app. */
  const olderGateway = (port: number, otherPaths: "404" | "app") =>
    Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<ReturnType<typeof createHttpServer>>((resolve) => {
            const server = createHttpServer((request, response) => {
              if (request.url?.startsWith("/api/status") === true) {
                response.writeHead(200, { "content-type": "application/json" })
                response.end(JSON.stringify(status))
              } else if (otherPaths === "404") {
                response.writeHead(404, { "content-type": "text/plain" })
                response.end("Not Found")
              } else {
                response.writeHead(200, { "content-type": "text/html" })
                response.end("<!doctype html><title>OT Gateway</title>")
              }
            })
            server.listen(port, "127.0.0.1", () => resolve(server))
          })
      ),
      (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
    )

  for (const otherPaths of ["404", "app"] as const) {
    it.live(`says a gateway answering ${otherPaths} for /api/logs is older than the command`, () =>
      Effect.gen(function* () {
        const port = yield* freePort
        yield* olderGateway(port, otherPaths)
        const target = { url: `http://127.0.0.1:${port}` }
        const error = yield* Effect.flip(logsReport(target, { since: "1h", sinceMs: 3_600_000, level: "info" }))
        expect(error._tag).toBe("LogsUnsupported")
        expect(error.message).toContain("this gateway is older than the logs command: plant-1/hall-a gateway main")
        expect(error.message).toContain("docker compose logs gateway")
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer))
    )
  }
})
