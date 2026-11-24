/**
 * Setting devices up from the status page, over real HTTP against a gateway on an in-memory network: a device and
 * the broker tested with settings not saved yet, and a points list checked row by row and added. Each endpoint is
 * guarded like every write, bounded (one test at a time, not the same device twice within a second, a body
 * limit), and answers in typed results the page shows as they are.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { EDIT_HEADER, EDIT_HEADER_VALUE, MAX_IMPORT_BYTES } from "@ot-gateway/api"
import { makeSimulatedDevice, serveSimulatedDevice } from "@ot-gateway/bacnet"
import { makeMemoryNetwork, type ModbusPoint, parseConfig } from "@ot-gateway/core"
import { makeRegisterBank, makeSimulatorControl, serveModbus, setPointValue } from "@ot-gateway/modbus"
import { makeBrokerControl, serveMqtt } from "@ot-gateway/mqtt"
import { Effect, Fiber, FileSystem, Schema } from "effect"
import { TestClock } from "effect/testing"
import { createServer } from "node:net"
import { runGateway } from "../src/Gateway.ts"
import { configFileSource } from "../src/LoadConfig.ts"

const BROKER = "10.0.0.2"
const METER = "10.0.0.3"
const HEAT_PUMP = "10.0.0.4"

const decodeObject = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

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

const settle = (steps: number) =>
  Effect.gen(function* () {
    for (let step = 0; step < steps; step++) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2)))
      yield* TestClock.adjust("500 millis")
    }
  })

const whileTimePasses = <A>(request: () => Promise<A>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.promise(request).pipe(Effect.forkScoped)
    for (let step = 0; step < 200 && fiber.pollUnsafe() === undefined; step++) yield* settle(1)
    return yield* Fiber.join(fiber)
  })

interface Reply {
  readonly status: number
  readonly body: Record<string, unknown>
}

const request = (port: number, method: string, path: string, body: unknown, headers: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }).then(async (response): Promise<Reply> => {
    const text = await response.text()
    return { status: response.status, body: text.startsWith("{") ? decodeObject(text) : { text } }
  })

const pageHeaders = (port: number) => ({ origin: `http://127.0.0.1:${port}`, [EDIT_HEADER]: EDIT_HEADER_VALUE })

const post = (port: number, path: string, body: unknown) =>
  whileTimePasses(() => request(port, "POST", path, body, pageHeaders(port)))

const power: ModbusPoint = {
  id: "power",
  name: "Active power",
  unit: "kW",
  writable: false,
  table: "holding",
  address: 100,
  dataType: "float32",
  byteOrder: "ABCD"
}
const energy: ModbusPoint = {
  ...power,
  id: "energy",
  name: "Energy",
  unit: "kWh",
  table: "input",
  address: 0,
  dataType: "uint32"
}

/** The meter as the page would send it: power and energy, and a register the device does not have. */
const meter = {
  protocol: "modbus-tcp",
  id: "meter",
  host: METER,
  points: [
    { id: "power", name: "Active power", unit: "kW", table: "holding", address: 100, dataType: "float32" },
    {
      id: "energy",
      name: "Energy",
      unit: "kWh",
      table: "input",
      address: 0,
      dataType: "uint32",
      scaling: { factor: 0.1 }
    },
    { id: "missing", name: "Missing", table: "holding", address: 9000, dataType: "uint16" }
  ]
}

const heatPump = {
  protocol: "bacnet-ip",
  id: "heat-pump",
  deviceInstance: 2001,
  address: `${HEAT_PUMP}:47808`,
  points: [{ id: "flow", name: "Flow temperature", unit: "unit:DEG_C", objectType: "analog-input", instance: 1 }]
}

const configText = (port: number, devices: ReadonlyArray<unknown>) =>
  `${JSON.stringify(
    {
      site: "s",
      building: "b",
      mqtt: { url: `mqtt://${BROKER}:1883` },
      status: { port, webRoot: "/nonexistent" },
      devices
    },
    null,
    2
  )}\n`

/** A gateway from a folder of its own, on a network with a broker, a Modbus meter and a BACnet heat pump. */
const startGateway = (devices: ReadonlyArray<unknown>, options: { readonly meterConnections?: number } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const folder = yield* fs.makeTempDirectoryScoped()
    const path = `${folder}/ot-gateway.json`
    const port = yield* freePort
    yield* fs.writeFileString(path, configText(port, devices))
    const network = makeMemoryNetwork()
    const broker = makeBrokerControl()
    yield* serveMqtt(yield* network.listen(BROKER, 1883), broker).pipe(Effect.forkScoped)
    const bank = makeRegisterBank()
    setPointValue(bank, power, 12.5)
    setPointValue(bank, energy, 4321)
    const meterControl = makeSimulatorControl()
    if (options.meterConnections !== undefined) meterControl.maxConnections = options.meterConnections
    yield* serveModbus(yield* network.listen(METER, 502), bank, meterControl).pipe(Effect.forkScoped)
    const simulated = makeSimulatedDevice({
      instance: 2001,
      name: "Heat pump",
      objects: [
        {
          objectType: "analog-input",
          instance: 1,
          name: "Flow",
          presentValue: { type: "real", value: 41.5 },
          units: 62
        },
        {
          objectType: "binary-input",
          instance: 2,
          name: "Heat pump compressor fault",
          presentValue: { type: "enumerated", value: 1 }
        },
        { objectType: "analog-output", instance: 3, name: "Setpoint", presentValue: { type: "real", value: 45 } }
      ]
    })
    yield* serveSimulatedDevice(
      yield* network.host(HEAT_PUMP).udp({ address: HEAT_PUMP, port: 47_808 }),
      simulated
    ).pipe(Effect.forkScoped)
    const source = yield* configFileSource(path)
    const config = source.resolve(yield* parseConfig(yield* fs.readFileString(path)))
    const running = yield* runGateway(config, { network: network.host("10.0.0.1"), configFile: source }).pipe(
      Effect.forkScoped
    )
    yield* settle(10)
    return { fs, path, port, running, meterControl, broker }
  })

describe("testing a device from the status page", () => {
  it.effect("reads each point once with unsaved settings: scaled values with units, and why one failed", () =>
    Effect.gen(function* () {
      const { fs, path, port, running } = yield* startGateway([])
      const before = yield* fs.readFileString(path)
      const reply = yield* post(port, "/api/test/read", { text: configText(port, [meter]), device: 0 })
      expect(reply.status).toBe(200)
      expect(reply.body).toMatchObject({
        device: "meter",
        protocol: "modbus-tcp",
        target: `${METER}:502, unit 1`,
        ok: false,
        points: [
          { id: "power", value: 12.5, unit: "kW" },
          { id: "energy", value: 432.1, raw: 4321, unit: "kWh" },
          { id: "missing", error: { reason: "protocol" } }
        ]
      })
      // Only the points asked for, by their place in the device.
      yield* settle(4)
      const one = yield* post(port, "/api/test/read", { text: configText(port, [meter]), device: 0, points: [1] })
      expect(one.body).toMatchObject({ ok: true, points: [{ id: "energy", value: 432.1 }] })
      // A test writes nothing.
      expect(yield* fs.readFileString(path)).toBe(before)
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("reads a BACnet device at its address over a port of its own", () =>
    Effect.gen(function* () {
      const { port, running } = yield* startGateway([])
      const reply = yield* post(port, "/api/test/read", { text: configText(port, [heatPump]), device: 0 })
      expect(reply.body).toMatchObject({
        ok: true,
        target: `device 2001 at ${HEAT_PUMP}:47808`,
        points: [{ id: "flow", value: 41.5, unit: "unit:DEG_C" }]
      })
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("says when a device refuses a second connection while the gateway holds one", () =>
    Effect.gen(function* () {
      const { port, running, meterControl } = yield* startGateway([{ ...meter, points: meter.points.slice(0, 1) }], {
        meterConnections: 1
      })
      expect(meterControl.accepted).toBe(1)
      const reply = yield* post(port, "/api/test/read", { text: configText(port, [meter]), device: 0 })
      expect(reply.body).toMatchObject({ ok: false, error: { reason: "connection" }, points: [] })
      expect(String(reply.body["note"])).toContain("second connection")
      // The gateway's own connection is still the one it had.
      expect(meterControl.accepted).toBe(1)
      expect(meterControl.open).toBe(1)
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("answers a device that cannot be reached within its deadline, as a connection or timeout failure", () =>
    Effect.gen(function* () {
      const { port, running, meterControl } = yield* startGateway([])
      meterControl.silent = true
      const reply = yield* post(port, "/api/test/read", { text: configText(port, [meter]), device: 0 })
      expect(reply.status).toBe(200)
      expect(reply.body).toMatchObject({ ok: false, error: { reason: "timeout" }, points: [] })
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("refuses an unchecked candidate with the issues at the device's own path", () =>
    Effect.gen(function* () {
      const { port, running } = yield* startGateway([])
      const broken = { ...meter, points: [meter.points[0], { ...meter.points[1], address: -1 }] }
      // The test of devices[1], point 1: issues name devices.1.points.1, as in the page's candidate.
      const reply = yield* post(port, "/api/test/read", {
        text: configText(port, [heatPump, broken]),
        device: 1,
        points: [1]
      })
      expect(reply.status).toBe(400)
      expect(reply.body).toMatchObject({
        _tag: "TestInvalid",
        issues: [{ path: ["devices", 1, "points", 1, "address"] }]
      })
      const none = yield* post(port, "/api/test/read", { text: configText(port, []), device: 3 })
      expect(none.status).toBe(400)
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("runs one test at a time and does not ask the same device twice within a second", () =>
    Effect.gen(function* () {
      const { port, running } = yield* startGateway([])
      const body = { text: configText(port, [meter]), device: 0, points: [0] }
      const [first, second] = yield* whileTimePasses(() =>
        Promise.all([
          request(port, "POST", "/api/test/read", body, pageHeaders(port)),
          request(port, "POST", "/api/test/read", body, pageHeaders(port))
        ])
      )
      expect([first.status, second.status].toSorted((a, b) => a - b)).toEqual([200, 429])
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("refuses a test that is not the page's own", () =>
    Effect.gen(function* () {
      const { port, running, meterControl } = yield* startGateway([])
      const body = { text: configText(port, [meter]), device: 0 }
      for (const headers of [{}, { origin: "http://evil.example", [EDIT_HEADER]: EDIT_HEADER_VALUE }]) {
        for (const path of [
          "/api/test/read",
          "/api/test/broker",
          "/api/import/check",
          "/api/import/apply",
          "/api/discover/devices",
          "/api/discover/objects"
        ]) {
          const reply = yield* whileTimePasses(() => request(port, "POST", path, body, headers))
          expect(reply.status).toBe(403)
        }
      }
      expect(meterControl.accepted).toBe(0)
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("finding BACnet devices from the status page", () => {
  it.effect("finds a device by broadcast and at its address, with its name", () =>
    Effect.gen(function* () {
      const { port, running } = yield* startGateway([])
      const broadcast = yield* post(port, "/api/discover/devices", { seconds: 1 })
      expect(broadcast.status).toBe(200)
      expect(broadcast.body).toMatchObject({
        devices: [{ instance: 2001, address: HEAT_PUMP, name: "Heat pump", conflicts: [] }],
        more: false
      })
      yield* settle(4)
      const asked = yield* post(port, "/api/discover/devices", { address: `${HEAT_PUMP}:47808`, seconds: 1 })
      expect(asked.body).toMatchObject({ asked: HEAT_PUMP, devices: [{ instance: 2001, name: "Heat pump" }] })
      yield* settle(4)
      const nobody = yield* post(port, "/api/discover/devices", { address: "10.0.0.99", seconds: 1 })
      expect(nobody.body).toMatchObject({ devices: [] })
      expect(String(nobody.body["note"])).toContain("No device answered at 10.0.0.99")
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("reads a device's objects as points to pick: ids, names, units and the values now", () =>
    Effect.gen(function* () {
      const { port, running } = yield* startGateway([])
      const reply = yield* post(port, "/api/discover/objects", { instance: 2001, address: HEAT_PUMP })
      expect(reply.status).toBe(200)
      expect(reply.body).toMatchObject({
        instance: 2001,
        address: HEAT_PUMP,
        name: "Heat pump",
        id: "heat-pump",
        listed: 4,
        objects: [
          {
            objectType: "analog-input",
            instance: 1,
            name: "Flow",
            id: "flow",
            unit: "unit:DEG_C",
            value: 41.5,
            configured: false
          },
          {
            objectType: "binary-input",
            instance: 2,
            name: "Compressor fault",
            id: "compressor-fault",
            value: true
          },
          { objectType: "analog-output", instance: 3, id: "setpoint", value: 45 }
        ]
      })
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("marks objects the running config reads already, and refuses an address that is not one", () =>
    Effect.gen(function* () {
      const { port, running } = yield* startGateway([heatPump])
      const reply = yield* post(port, "/api/discover/objects", { instance: 2001, address: `${HEAT_PUMP}:47808` })
      expect(reply.status).toBe(200)
      const objects = reply.body["objects"]
      expect(objects).toMatchObject([{ id: "flow", configured: true }, { configured: false }, { configured: false }])
      // The running config has a device called heat-pump: the new one's id does not take it.
      expect(reply.body["id"]).not.toBe("heat-pump")
      yield* settle(4)
      const devices = yield* post(port, "/api/discover/devices", { address: HEAT_PUMP, seconds: 1 })
      expect(devices.body).toMatchObject({ devices: [{ instance: 2001, configured: "heat-pump" }] })
      const bad = yield* post(port, "/api/discover/objects", { instance: 2001, address: "not an address" })
      expect(bad.status).toBe(400)
      expect(bad.body).toMatchObject({ _tag: "TestInvalid" })
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("says when the device does not answer, within its deadline", () =>
    Effect.gen(function* () {
      const { port, running } = yield* startGateway([])
      const reply = yield* post(port, "/api/discover/objects", { instance: 2001, address: "10.0.0.99" })
      expect(reply.status).toBe(502)
      expect(reply.body).toMatchObject({ _tag: "DiscoveryFailed" })
      expect(String(reply.body["message"])).toContain("did not answer at 10.0.0.99")
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("testing the broker from the status page", () => {
  it.effect("connects with the unsaved settings and sends a message through it and back", () =>
    Effect.gen(function* () {
      const { port, running, broker } = yield* startGateway([])
      const reply = yield* post(port, "/api/test/broker", { text: configText(port, []) })
      expect(reply.body).toMatchObject({ ok: true, broker: `mqtt://${BROKER}:1883`, protocolVersion: "5" })
      expect(broker.connects.some((connect) => connect.clientId.startsWith("ot-gateway-check-"))).toBe(true)
      const elsewhere = configText(port, []).replace(`mqtt://${BROKER}:1883`, "mqtt://10.0.0.9:1883")
      const away = yield* post(port, "/api/test/broker", { text: elsewhere })
      expect(away.body).toMatchObject({ ok: false, broker: "mqtt://10.0.0.9:1883" })
      expect(String(away.body["error"])).toContain("10.0.0.9")
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

const pointsList = [
  "device,point,unit,host,register,table,type",
  `Main meter,Active power,kW,${METER},100,holding,float32`,
  `Main meter,Energy,kWh,${METER},0,input,uint32`,
  `Sub meter,Power,kW,${METER},5,holding,`,
  `Third meter,Power,kW,${METER},70000,holding,uint16`
].join("\n")

describe("adding a points list from the status page", () => {
  it.effect("checks it device by device, adds the ones without a mistake and applies them", () =>
    Effect.gen(function* () {
      const { fs, path, port, running } = yield* startGateway([])
      const checked = yield* post(port, "/api/import/check", { text: pointsList, name: "points.csv" })
      expect(checked.status).toBe(200)
      expect(checked.body).toMatchObject({
        format: "points-list",
        devices: [
          { name: "Main meter", id: "main-meter", protocol: "modbus-tcp", lines: [2, 3], points: 2 },
          { name: "Sub meter", lines: [4] },
          { name: "Third meter", id: "third-meter", lines: [5] }
        ],
        adds: { devices: 1, points: 2 }
      })
      const devices = checked.body["devices"]
      expect(Array.isArray(devices) && String(devices[1]?.error)).toContain("line 4")
      expect(Array.isArray(devices) && String(devices[2]?.error)).toContain("address")
      const file = yield* whileTimePasses(() => request(port, "GET", "/api/config/file", undefined, {}))
      const applied = yield* post(port, "/api/import/apply", {
        text: pointsList,
        name: "points.csv",
        etag: file.body["etag"]
      })
      expect(applied.status).toBe(200)
      expect(applied.body).toMatchObject({ devices: 1, points: 2, skipped: 2 })
      const config = yield* parseConfig(yield* fs.readFileString(path))
      expect(config.devices.map((device) => device.id)).toEqual(["main-meter"])
      // Again: its devices are in the config now, so nothing is added twice.
      const again = yield* post(port, "/api/import/apply", { text: pointsList, etag: file.body["etag"] })
      expect(again.body).toMatchObject({ _tag: "ImportInvalid" })
      // A list with a new device but the old ETag: the file changed since, nothing is written.
      const stale = yield* post(port, "/api/import/apply", {
        text: pointsList.replaceAll("Main meter", "Fourth meter"),
        etag: file.body["etag"]
      })
      expect(stale.status).toBe(409)
      // Checked again, the device is in the config already.
      const repeat = yield* post(port, "/api/import/check", { text: pointsList })
      expect(repeat.body).toMatchObject({ adds: { devices: 0 } })
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("names a mistake in the whole file, and refuses a file too large to be a points list", () =>
    Effect.gen(function* () {
      const { port, running } = yield* startGateway([])
      const headless = yield* post(port, "/api/import/check", { text: "name,value\nx,1" })
      expect(headless.body).toMatchObject({ adds: { devices: 0 }, devices: [] })
      expect(String(headless.body["error"])).toContain('"device" column')
      const profileFile = yield* post(port, "/api/import/check", {
        text: `device,point,host,profile\nm,*,${METER},../secret.json`
      })
      expect(String(profileFile.body["error"])).toContain("library")
      const huge = yield* post(port, "/api/import/check", { text: "x".repeat(MAX_IMPORT_BYTES + 1) })
      expect(huge.status).toBeGreaterThanOrEqual(400)
      const nothing = yield* post(port, "/api/import/apply", { text: "name,value\nx,1", etag: "x" })
      expect(nothing.body).toMatchObject({ _tag: "ImportInvalid" })
      yield* Fiber.interrupt(running)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
