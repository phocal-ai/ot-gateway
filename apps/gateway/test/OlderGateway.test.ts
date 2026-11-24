/**
 * The CLI reads gateways of the previous minor release (docs/operations.md). `fixtures/v0.12.0` holds the answers
 * of a real v0.12.0 gateway (its demo), captured from the endpoints the CLI reads; a v0.12.0 gateway serves no
 * `/api/events` and no `/api/messages/window`. These tests serve them as that gateway did and run the current
 * decoders and reports against them, so a field made required again, or an endpoint asked for unconditionally,
 * fails here before it reaches a user who updated the CLI first.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { GatewayStatus, HistorySeries, Messages, PointCatalog, PointReadings } from "@ot-gateway/api"
import { Effect, Schema } from "effect"
import { TestConsole } from "effect/testing"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { EVENTS_RELEASE, isBefore, parseRelease, servesEvents, tooOldMessage } from "../src/GatewayRelease.ts"
import { historyReport } from "../src/HistoryReport.ts"
import { messagesReport } from "../src/MessagesReport.ts"
import { eventsReport, fetchStatusFor, formatStatus } from "../src/StatusReport.ts"

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/v0.12.0/${name}`, import.meta.url)), "utf8"))

/** What the v0.12.0 gateway answered at each path the CLI asks; anything else was a 404 there. */
const answerOf = (url: URL, edit: (path: string, body: unknown) => unknown): unknown => {
  const body = (() => {
    switch (url.pathname) {
      case "/api/status":
        return fixture(url.searchParams.get("points") === "none" ? "status-points-none.json" : "status.json")
      case "/api/messages":
        return fixture("messages.json")
      case "/api/points":
        return fixture("points.json")
      case "/api/values":
        return fixture("values.json")
      case "/api/history":
        return fixture(
          url.searchParams.get("point") === "breaker-tripped" ? "history-breaker-tripped.json" : "history.json"
        )
      default:
        return undefined
    }
  })()
  return body === undefined ? undefined : edit(url.pathname, body)
}

/** A server that answers as the v0.12.0 gateway did, on a free loopback port, for the test's scope. */
const serveFixtures = (edit: (path: string, body: unknown) => unknown = (_path, body) => body) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        const answer = answerOf(new URL(request.url ?? "/", "http://localhost"), edit)
        if (answer === undefined) {
          response.writeHead(404, { "content-type": "text/plain" }).end("Not Found")
          return
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer))
      })
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        const port = typeof address === "object" && address !== null ? address.port : 0
        resume(Effect.succeed({ url: `http://127.0.0.1:${port}`, close: () => server.close() }))
      })
    }),
    (served) => Effect.sync(served.close)
  )

const target = (url: string) => ({
  url,
  expected: { path: "ot-gateway.json", site: "demo-site", building: "building-a", id: "main" }
})

const lastLog = Effect.map(TestConsole.logLines, (lines) => lines.map(String).at(-1) ?? "")

describe("a v0.12.0 gateway's answers", () => {
  it("decode with the current schemas, with a sensible reading of what it did not send", () => {
    const status = Schema.decodeUnknownSync(GatewayStatus)(fixture("status.json"))
    // It could not change its config while running: the config started with it.
    expect(status.configSince).toBe(status.since)
    expect(status.host?.version).toBe("v0.12.0")
    expect(status.devices.map((device) => device.id)).toEqual(["pv-inverter", "energy-meter", "heat-pump"])
    expect(Schema.decodeUnknownSync(GatewayStatus)(fixture("status-points-none.json")).configSince).toBeTypeOf("number")

    const messages = Schema.decodeUnknownSync(Messages)(fixture("messages.json"))
    expect(messages.messages.length).toBeGreaterThan(0)
    // It did not count what reached the broker: not known, rather than 0 or all.
    expect(messages.messages.every((message) => message.delivered === undefined)).toBe(true)

    const catalog = Schema.decodeUnknownSync(PointCatalog)(fixture("points.json"))
    expect(catalog.points).toHaveLength(8)
    // Not said: a stretch without reads then shows as a gap rather than hiding one.
    expect(catalog.points.every((point) => !point.cov && point.read === undefined)).toBe(true)

    expect(Schema.decodeUnknownSync(PointReadings)(fixture("values.json")).readings).toHaveLength(2)
    expect(Schema.decodeUnknownSync(HistorySeries)(fixture("history.json")).buckets.length).toBeGreaterThan(0)
    expect(Schema.decodeUnknownSync(HistorySeries)(fixture("history-breaker-tripped.json")).resolution).toBe("read")
  })

  it("encode, on the gateway, with every field the current release sends", () => {
    const status = Schema.decodeUnknownSync(GatewayStatus)(fixture("status.json"))
    expect(Schema.encodeSync(GatewayStatus)(status)).toMatchObject({ configSince: status.since })
  })
})

describe("the release of a gateway", () => {
  it("reads tags, bare versions and git describe; other builds count as current", () => {
    expect(parseRelease("v0.12.0")).toEqual([0, 12, 0])
    expect(parseRelease("0.13.1")).toEqual([0, 13, 1])
    expect(parseRelease("v0.12.0-5-gabc1234")).toEqual([0, 12, 0])
    expect(parseRelease("dev")).toBeUndefined()
    expect(isBefore("v0.12.0", EVENTS_RELEASE)).toBe(true)
    expect(isBefore("v0.13.0", EVENTS_RELEASE)).toBe(false)
    expect(isBefore("v1.0.0", EVENTS_RELEASE)).toBe(false)
    expect(isBefore("dev", EVENTS_RELEASE)).toBe(false)
    expect(servesEvents({})).toBe(true)
    expect(
      tooOldMessage({ gatewayVersion: "v0.12.0", cliVersion: "0.13.0", what: "events", release: EVENTS_RELEASE })
    ).toBe(
      "this gateway runs v0.12.0, the CLI is v0.13.0: events needs a gateway of v0.13.0 or later. Upgrade the gateway, or run the CLI at v0.12.0 (npx ot-gateway@0.12.0)"
    )
  })
})

describe("the CLI against a v0.12.0 gateway", () => {
  it.live(
    "status reports it, without the events it does not keep",
    () =>
      Effect.gen(function* () {
        const served = yield* serveFixtures()
        const { status, recent } = yield* fetchStatusFor(target(served.url))
        expect(recent).toBeUndefined()
        const lines = formatStatus(status).split("\n")
        expect(lines[0]).toMatch(/^demo-site\/building-a gateway main, up /)
        expect(lines).toContain("  3 device(s)")
        expect(lines.some((line) => /^ {4}energy-meter +ok +modbus-tcp, 3 point\(s\) every 5 s, /.test(line))).toBe(
          true
        )
        expect(lines.at(-1)).toBe(
          "  (this gateway runs v0.12.0, which keeps no events: upgrade it to v0.13.0 or later to see what failed lately)"
        )
        const json = yield* fetchStatusFor(target(served.url), { json: true })
        expect(json.status.devices.flatMap((device) => device.points).length).toBeGreaterThan(0)
      }).pipe(Effect.scoped, Effect.provide([TestConsole.layer, NodeServices.layer])),
    20_000
  )

  it.live(
    "events and messages --since name both versions instead of failing to decode",
    () =>
      Effect.gen(function* () {
        const served = yield* serveFixtures()
        const events = yield* Effect.flip(eventsReport(target(served.url), { since: "1h", sinceMs: 3_600_000 }))
        expect(events._tag).toBe("GatewayTooOld")
        expect(events.message).toMatch(
          /^this gateway runs v0\.12\.0, the CLI is \S+: events needs a gateway of v0\.13\.0 or later\. Upgrade the gateway, or run the CLI at v0\.12\.0/
        )
        const window = yield* Effect.flip(messagesReport(target(served.url), [], { since: "5m", sinceMs: 300_000 }))
        expect(window._tag).toBe("GatewayTooOld")
        expect(window.message).toContain("messages --since needs a gateway of v0.13.0 or later")
      }).pipe(Effect.scoped, Effect.provide([TestConsole.layer, NodeServices.layer])),
    20_000
  )

  it.live(
    "one that names no version yet (before its first host sample) is asked whether it keeps events",
    () =>
      Effect.gen(function* () {
        const served = yield* serveFixtures((path, body) =>
          path === "/api/status"
            ? Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => key !== "host"))
            : body
        )
        const { recent } = yield* fetchStatusFor(target(served.url))
        expect(recent).toBeUndefined()
        const events = yield* Effect.flip(eventsReport(target(served.url), { since: "1h", sinceMs: 3_600_000 }))
        expect(events._tag).toBe("GatewayTooOld")
        expect(events.message).toMatch(
          /^the gateway at \S+ serves no events, so it runs a release before v0\.13\.0, and the CLI is \S+: events needs a gateway of v0\.13\.0 or later/
        )
      }).pipe(Effect.scoped, Effect.provide([TestConsole.layer, NodeServices.layer])),
    20_000
  )

  it.live(
    "messages counts what was sent, and says it does not know what reached the broker",
    () =>
      Effect.gen(function* () {
        const served = yield* serveFixtures()
        yield* messagesReport(target(served.url), [{ device: "energy-meter", point: "active-power" }])
        const report = (yield* lastLog).split("\n")
        expect(report[0]).toMatch(/^demo-site\/building-a gateway main at .*: messages per topic since it started at /)
        expect(report[1]).toMatch(/^ {2}energy-meter\/active-power {8}\d+ sent, {2}last \S+ {2}\{"value":/)
        expect(report.join("\n")).not.toContain("reached the broker,")
        expect(report).toContain(
          "  (this gateway does not count what reached the broker: upgrade it to v0.13.0 or later for that)"
        )
        expect(report.find((line) => line.startsWith("  total: "))).toMatch(
          /^ {2}total: \d+ sent \(\d+ value\(s\), 1 \$meta, 0 health\)$/
        )
        yield* messagesReport(target(served.url), [], { json: true })
        expect(JSON.parse(yield* lastLog)).toMatchObject({ ok: true, totals: { waiting: 0, lost: 0, notSent: 0 } })
      }).pipe(Effect.scoped, Effect.provide([TestConsole.layer, NodeServices.layer])),
    20_000
  )

  it.live(
    "history prints its buckets, a switch's too, without the events it does not keep",
    () =>
      Effect.gen(function* () {
        const served = yield* serveFixtures()
        yield* historyReport(
          target(served.url),
          [
            { device: "energy-meter", point: "active-power" },
            { device: "energy-meter", point: "breaker-tripped" }
          ],
          { since: "3m", sinceMs: 180_000 }
        )
        const report = (yield* lastLog).split("\n")
        expect(report[0]).toMatch(/^demo-site\/building-a gateway main at .*: the last 3m, until /)
        expect(report).toContain(
          "energy-meter/active-power (Energy meter active power, kW): 18 s buckets from every read"
        )
        expect(
          report.some((line) => /^ {2}\S+ {2}avg [\d.]+ kW {2}min [\d.]+ {2}max [\d.]+ {2}\(\d+ reads\)$/.test(line))
        ).toBe(true)
        expect(report.some((line) => line.startsWith("energy-meter/breaker-tripped"))).toBe(true)
      }).pipe(Effect.scoped, Effect.provide([TestConsole.layer, NodeServices.layer])),
    20_000
  )

  it.live(
    "an answer it cannot read names the gateway's version, not a gateway that is not running",
    () =>
      Effect.gen(function* () {
        // As if a later CLI required a field v0.12.0 never sent: `/api/points` without `source`.
        const served = yield* serveFixtures((path, body) =>
          path === "/api/points" ? { points: [{ device: "energy-meter", id: "active-power" }] } : body
        )
        const error = yield* Effect.flip(
          historyReport(target(served.url), [{ device: "energy-meter" }], { since: "3m", sinceMs: 180_000 })
        )
        expect(error._tag).toBe("GatewayAnswerUnreadable")
        expect(error.message).toMatch(
          /^this gateway runs v0\.12\.0, the CLI is \S+, and the CLI cannot read its answer \(.+\)\. Upgrade the gateway, or run the CLI at v0\.12\.0$/
        )
        expect(error.message).not.toContain("Is the gateway running")
      }).pipe(Effect.scoped, Effect.provide([TestConsole.layer, NodeServices.layer])),
    20_000
  )
})
