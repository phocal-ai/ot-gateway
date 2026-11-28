/**
 * `devices export`, `topics export` and `gateways export`: one row per device, per MQTT topic and per gateway, with
 * no live values, as CSV or JSON like `points export`.
 */
import { describe, expect, it } from "@effect/vitest"
import { contractMessageOf, parseConfig } from "@ot-gateway/core"
import { Effect } from "effect"
import { exportDevices, exportGateways, exportTopics } from "../src/Exports.ts"
import type { FleetGateway } from "../src/Fleet.ts"
import { exportCsv } from "../src/PointsExport.ts"

const config = Effect.runSync(
  parseConfig(
    JSON.stringify({
      site: "plant",
      building: "hall",
      id: "edge",
      mqtt: { url: "mqtt://broker" },
      devices: [
        {
          protocol: "modbus-tcp",
          id: "meter",
          host: "10.0.1.20",
          unitId: 3,
          pollIntervalMs: 10_000,
          points: [
            { id: "power", name: "Power", unit: "unit:KiloW", table: "holding", address: 0, dataType: "float32" },
            { id: "relay", name: "Relay", table: "coil", address: 1, dataType: "bool", writable: true }
          ]
        },
        {
          protocol: "bacnet-ip",
          id: "ahu",
          deviceInstance: 2001,
          address: "10.0.1.30",
          publish: { mode: "aggregate", intervalMs: 900_000 },
          points: [
            { id: "fan", name: "Fan", objectType: "binary-output", instance: 1 },
            {
              id: "setpoint",
              name: "Setpoint",
              unit: "unit:DEG_C",
              objectType: "analog-value",
              instance: 2,
              writable: true,
              limits: { min: 15, max: 25 },
              deadband: 0.5
            }
          ]
        },
        {
          protocol: "simulator",
          id: "sim",
          points: [{ id: "wave", name: "Wave", waveform: "sine", min: 0, max: 1 }]
        }
      ]
    })
  )
)

describe("devices export", () => {
  it("lists each device with where it is, its points and how many take commands", () => {
    const list = exportDevices(config)
    expect(list.rows).toEqual([
      {
        device: "meter",
        protocol: "modbus-tcp",
        host: "10.0.1.20",
        port: 502,
        unit_id: 3,
        interval_s: 10,
        publish: "sample",
        points: 2,
        writable: 1,
        topics: "plant/hall/meter/+"
      },
      {
        device: "ahu",
        protocol: "bacnet-ip",
        device_instance: 2001,
        address: "10.0.1.30",
        cov: "yes",
        interval_s: 5,
        publish: "aggregate",
        points: 2,
        writable: 1,
        topics: "plant/hall/ahu/+"
      },
      {
        device: "sim",
        protocol: "simulator",
        interval_s: 5,
        publish: "sample",
        points: 1,
        writable: 0,
        topics: "plant/hall/sim/+"
      }
    ])
    expect(exportCsv(list).split("\n")[0]).toBe(
      "device,protocol,host,port,unit_id,device_instance,address,cov,interval_s,publish,points,writable,topics"
    )
  })

  it("keeps the device and protocol columns of a config without devices", () => {
    expect(exportDevices({ ...config, devices: [] })).toEqual({ columns: ["device", "protocol"], rows: [] })
  })
})

describe("topics export", () => {
  const list = exportTopics(config)
  const of = (topic: string) => list.rows.find((row) => row["topic"] === topic)

  it("maps the health topic and each point's value and $meta, and $set and $set/result only of a writable point", () => {
    expect(list.rows.map((row) => `${row["message"]} ${row["topic"]}`)).toEqual([
      "health plant/hall/$gateway/edge/health",
      "value plant/hall/meter/power",
      "meta plant/hall/meter/power/$meta",
      "value plant/hall/meter/relay",
      "meta plant/hall/meter/relay/$meta",
      "command plant/hall/meter/relay/$set",
      "command-result plant/hall/meter/relay/$set/result",
      "value plant/hall/ahu/fan",
      "meta plant/hall/ahu/fan/$meta",
      "value plant/hall/ahu/setpoint",
      "meta plant/hall/ahu/setpoint/$meta",
      "command plant/hall/ahu/setpoint/$set",
      "command-result plant/hall/ahu/setpoint/$set/result",
      "value plant/hall/sim/wave",
      "meta plant/hall/sim/wave/$meta"
    ])
  })

  it("names the contract message each topic carries, as the contract reads the topic", () => {
    for (const row of list.rows) expect(contractMessageOf(String(row["topic"]))).toBe(row["message"])
  })

  it("says for a point's topics its unit, whether the value is a number or a boolean, and how it publishes", () => {
    expect(of("plant/hall/meter/relay/$set")).toEqual({
      topic: "plant/hall/meter/relay/$set",
      message: "command",
      direction: "subscribe",
      retained: "no",
      qos: 1,
      device: "meter",
      point: "relay",
      name: "Relay",
      value: "boolean",
      writable: "yes",
      publish: "sample"
    })
    expect(of("plant/hall/ahu/fan")).toMatchObject({ value: "boolean", writable: "no", publish: "aggregate" })
    expect(of("plant/hall/ahu/setpoint/$meta")).toMatchObject({
      retained: "yes",
      unit: "unit:DEG_C",
      value: "number",
      publish: "change"
    })
    expect(of("plant/hall/meter/power")).toMatchObject({ value: "number", unit: "unit:KiloW", retained: "no" })
  })
})

describe("gateways export", () => {
  const online: FleetGateway = {
    site: "plant",
    building: "hall",
    id: "edge",
    name: "plant/hall/edge",
    status: "online",
    contract: "1.0",
    since: Date.UTC(2026, 10, 28, 7, 0),
    ts: Date.UTC(2026, 10, 28, 8, 0),
    devices: [
      { id: "ahu", status: "ok" },
      { id: "meter", status: "failing", reason: "timeout", failingSince: Date.UTC(2026, 10, 28, 7, 30) }
    ]
  }
  const offline: FleetGateway = {
    site: "plant",
    building: "office",
    id: "main",
    name: "plant/office/main",
    status: "offline",
    reason: "connection-lost",
    devices: []
  }

  it("lists each gateway with its status, times in UTC and its devices by status", () => {
    const list = exportGateways([online, offline])
    expect(list.rows).toEqual([
      {
        gateway: "plant/hall/edge",
        site: "plant",
        building: "hall",
        id: "edge",
        status: "online",
        contract: "1.0",
        since: "2026-11-28T07:00:00.000Z",
        heartbeat: "2026-11-28T08:00:00.000Z",
        devices: 2,
        ok: 1,
        failing: 1,
        starting: 0,
        health_topic: "plant/hall/$gateway/edge/health"
      },
      {
        gateway: "plant/office/main",
        site: "plant",
        building: "office",
        id: "main",
        status: "offline",
        reason: "connection-lost",
        health_topic: "plant/office/$gateway/main/health"
      }
    ])
    expect(exportCsv(list).split("\n")[2]).toBe(
      "plant/office/main,plant,office,main,offline,connection-lost,,,,,,,,plant/office/$gateway/main/health"
    )
  })
})
