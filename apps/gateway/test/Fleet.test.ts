/** `gateways`: the gateways a broker knows, from their retained health and `$meta`, against the in-process broker. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { makeBrokerControl, serveMqtt } from "@ot-gateway/mqtt"
import { Effect } from "effect"
import { publishOnce } from "../src/Broker.ts"
import {
  brokerSettings,
  fleetBroker,
  formatGatewayList,
  formatGatewayPoints,
  formatGatewayStatus,
  gatewayOf,
  gatewayPoints,
  gatewayStatus,
  healthFilter,
  listGateways,
  parseGatewayRef,
  pickGateway,
  pointsOf,
  statusFailure
} from "../src/Fleet.ts"

const now = Date.UTC(2026, 10, 27, 9, 0, 0)

const online = (devices: Record<string, unknown>) =>
  JSON.stringify({ status: "online", contract: "1.0", since: now - 3_600_000, ts: now - 20_000, devices })

const healthOf = (name: string, payload: string) => ({
  topic: name.replace(/\/([^/]+)$/, "/$gateway/$1/health"),
  payload
})

const meta = (fields: Record<string, unknown>) =>
  JSON.stringify({
    name: "Room temperature",
    unit: "unit:DEG_C",
    writable: false,
    publish: { mode: "sample" },
    ...fields
  })

describe("gatewayOf", () => {
  it("reads an online gateway, its devices sorted by id", () => {
    const gateway = gatewayOf(
      healthOf("s/b/main", online({ meter: { status: "ok", lastSuccess: now }, ahu: { status: "starting" } }))
    )
    expect(gateway).toMatchObject({ name: "s/b/main", site: "s", building: "b", id: "main", status: "online" })
    expect(gateway?.devices.map((device) => device.id)).toEqual(["ahu", "meter"])
  })

  it("reads an offline gateway with its reason, and an unreadable one as such", () => {
    expect(
      gatewayOf(healthOf("s/b/old", JSON.stringify({ status: "offline", reason: "connection-lost" })))
    ).toMatchObject({ status: "offline", reason: "connection-lost" })
    expect(gatewayOf(healthOf("s/b/odd", "not json"))?.status).toBe("unreadable")
  })

  it("passes over other topics and cleared health", () => {
    expect(gatewayOf({ topic: "s/b/meter/power", payload: "{}" })).toBeUndefined()
    expect(gatewayOf(healthOf("s/b/main", ""))).toBeUndefined()
  })
})

describe("gateway names", () => {
  it("takes site/building/id or an id alone, and refuses anything else", () =>
    Effect.gen(function* () {
      expect(yield* parseGatewayRef("s/b/main")).toEqual({ site: "s", building: "b", id: "main" })
      expect(yield* parseGatewayRef("main")).toEqual({ id: "main" })
      expect((yield* Effect.flip(parseGatewayRef("s/main"))).code).toBe("gateway-not-found")
      expect((yield* Effect.flip(parseGatewayRef("+"))).code).toBe("gateway-not-found")
      expect(healthFilter({ id: "main" })).toBe("+/+/$gateway/main/health")
    }).pipe(Effect.runSync))

  it("says when an id alone names two gateways", () =>
    Effect.gen(function* () {
      const gateways = [
        gatewayOf(healthOf("s/a/main", online({}))),
        gatewayOf(healthOf("s/b/main", online({})))
      ].flatMap((gateway) => (gateway === undefined ? [] : [gateway]))
      const error = yield* Effect.flip(pickGateway(gateways, { id: "main" }, "main"))
      expect(error.code).toBe("gateway-ambiguous")
      expect(error.message).toContain("s/a/main, s/b/main")
      expect((yield* pickGateway(gateways, { site: "s", building: "b", id: "main" }, "s/b/main")).name).toBe("s/b/main")
    }).pipe(Effect.runSync))
})

describe("pointsOf", () => {
  const gateway = gatewayOf(healthOf("s/b/main", online({ room: { status: "ok" } })))
  it("keeps the points that name the gateway, and its devices' points that name none", () => {
    if (gateway === undefined) throw new Error("no gateway")
    const points = pointsOf(gateway, [
      { topic: "s/b/room/temp/$meta", payload: meta({ gateway: "main" }) },
      { topic: "s/b/room/setpoint/$meta", payload: meta({ name: "Setpoint", writable: true }) },
      { topic: "s/b/other/temp/$meta", payload: meta({ gateway: "second" }) },
      { topic: "s/b/other/flow/$meta", payload: meta({}) },
      { topic: "x/b/room/temp/$meta", payload: meta({ gateway: "main" }) }
    ])
    expect(points.map((point) => point.topic)).toEqual(["s/b/room/setpoint", "s/b/room/temp"])
    expect(points[0]).toMatchObject({ device: "room", point: "setpoint", name: "Setpoint", writable: true })
  })
})

describe("text", () => {
  it("lists gateways one per line, and says what to check when there are none", () => {
    const gateways = [
      gatewayOf(
        healthOf("s/b/main", online({ meter: { status: "ok" }, ahu: { status: "failing", reason: "timeout" } }))
      ),
      gatewayOf(healthOf("s/b/old", JSON.stringify({ status: "offline", reason: "shutdown" })))
    ].flatMap((gateway) => (gateway === undefined ? [] : [gateway]))
    const text = formatGatewayList({ broker: "mqtt://broker:1883", gateways }, now)
    expect(text).toContain("2 gateway(s) on mqtt://broker:1883")
    expect(text).toContain("s/b/main  online      2 device(s): 1 ok, 1 failing")
    expect(text).toContain("heartbeat 20 s ago")
    expect(text).toContain("s/b/old   offline     shutdown")
    expect(formatGatewayList({ broker: "mqtt://broker:1883", gateways: [] }, now)).toContain("no gateway keeps")
  })

  it("prints a gateway's devices with why one fails, and fails the status for it", () => {
    const gateway = gatewayOf(
      healthOf(
        "s/b/main",
        online({ ahu: { status: "failing", reason: "timeout", failingSince: now - 60_000 }, meter: { status: "ok" } })
      )
    )
    if (gateway === undefined) throw new Error("no gateway")
    const text = formatGatewayStatus(gateway, now)
    expect(text).toMatch(/ahu\s+failing since .* \(timeout\)/)
    expect(statusFailure(gateway)?.code).toBe("gateway-unhealthy")
    const offline = gatewayOf(healthOf("s/b/main", JSON.stringify({ status: "offline", reason: "shutdown" })))
    expect(offline === undefined ? undefined : statusFailure(offline)?.code).toBe("gateway-offline")
  })

  it("prints points with unit and writable", () => {
    const text = formatGatewayPoints({
      gateway: "s/b/main",
      status: "online",
      points: [
        {
          device: "room",
          point: "setpoint",
          topic: "s/b/room/setpoint",
          name: "Setpoint",
          unit: "unit:DEG_C",
          writable: true
        }
      ]
    })
    expect(text).toContain("room/setpoint  Setpoint  [unit:DEG_C]  writable")
  })
})

describe("brokerSettings", () => {
  it("checks the URL as a config's, and reads the password from OT_GATEWAY_BROKER_PASSWORD with a login", () =>
    Effect.gen(function* () {
      expect(yield* brokerSettings("mqtt://broker:1883", undefined)).toEqual({
        url: "mqtt://broker:1883",
        version: "auto"
      })
      expect(yield* brokerSettings("mqtt://broker:1883", "viewer")).toMatchObject({
        username: "viewer",
        passwordEnv: "OT_GATEWAY_BROKER_PASSWORD"
      })
      expect((yield* Effect.flip(brokerSettings("http://broker", undefined))).code).toBe("no-broker")
      expect((yield* Effect.flip(brokerSettings("mqtt://user:pw@broker", undefined))).code).toBe("no-broker")
    }).pipe(Effect.runPromise))
})

/** A test broker for the current scope; its port. */
const startBroker = Effect.gen(function* () {
  const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
  yield* serveMqtt(server, makeBrokerControl()).pipe(Effect.forkScoped)
  return server.address._tag === "UnixPathAddress" ? 0 : server.address.port
})

describe("against a broker", () => {
  it.live("lists the gateways, one's status and its points from what the broker keeps", () =>
    Effect.gen(function* () {
      const port = yield* startBroker
      const config = yield* parseConfig(
        JSON.stringify({ site: "s", building: "b", mqtt: { url: `mqtt://127.0.0.1:${port}` }, devices: [] })
      )
      const retained = { retain: true, qos: 1 } as const
      yield* publishOnce(
        config,
        "s/b/$gateway/main/health",
        online({ room: { status: "ok", lastSuccess: now } }),
        retained
      )
      yield* publishOnce(
        config,
        "s/b/$gateway/old/health",
        JSON.stringify({ status: "offline", reason: "shutdown" }),
        retained
      )
      yield* publishOnce(config, "s/b/room/temp/$meta", meta({ gateway: "main" }), retained)
      yield* publishOnce(config, "s/b/room/temp", JSON.stringify({ value: 21, ts: now }), { retain: false, qos: 1 })

      const list = yield* listGateways(config.mqtt, "500 millis")
      expect(list.gateways.map((gateway) => [gateway.name, gateway.status])).toEqual([
        ["s/b/main", "online"],
        ["s/b/old", "offline"]
      ])

      const status = yield* gatewayStatus(config.mqtt, "main", "500 millis")
      expect(status.ok).toBe(true)
      expect(status.gateway.devices).toEqual([{ id: "room", status: "ok", lastSuccess: now }])

      const points = yield* gatewayPoints(config.mqtt, "s/b/main", "500 millis")
      expect(points.points.map((point) => point.topic)).toEqual(["s/b/room/temp"])

      const missing = yield* Effect.flip(gatewayStatus(config.mqtt, "nope", "300 millis"))
      expect(missing._tag === "FleetError" ? missing.code : missing._tag).toBe("gateway-not-found")
    }).pipe(Effect.scoped)
  )
})

describe("refusals", () => {
  it.live("fails with subscribe-refused when the broker's rules refuse the health topics", () =>
    Effect.gen(function* () {
      const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
      const control = makeBrokerControl()
      control.refusedFilters.add("+/+/$gateway/+/health")
      yield* serveMqtt(server, control).pipe(Effect.forkScoped)
      const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port
      const settings = yield* brokerSettings(`mqtt://127.0.0.1:${port}`, undefined)
      const error = yield* Effect.flip(listGateways(settings, "200 millis"))
      expect(error._tag === "FleetError" ? error.code : error._tag).toBe("subscribe-refused")
    }).pipe(Effect.scoped)
  )

  it.effect("refuses --username without --broker, and calls unreadable health unreadable, not offline", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(fleetBroker({ broker: undefined, username: "viewer", config: "x.json" }))
      expect(error._tag).toBe("UsageMistake")
      const odd = gatewayOf(healthOf("s/b/odd", JSON.stringify({ status: "rebooting" })))
      expect(odd === undefined ? undefined : statusFailure(odd)?.code).toBe("health-unreadable")
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
