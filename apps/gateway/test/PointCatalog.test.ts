/**
 * The points page's catalog: every configured point with its topic, where it
 * is read and how its values go out, in the config's own words.
 */
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { Effect } from "effect"
import { pointCatalog, publishLabel } from "../src/PointCatalog.ts"

const config = parseConfig(
  JSON.stringify({
    site: "s",
    building: "b",
    mqtt: { url: "mqtt://broker" },
    devices: [
      {
        protocol: "modbus-tcp",
        id: "meter",
        host: "10.0.1.1",
        publish: { mode: "aggregate", intervalMs: 900_000 },
        points: [
          {
            id: "power",
            name: "Power",
            unit: "unit:KiloW",
            table: "holding",
            address: 40,
            dataType: "float32",
            byteOrder: "CDAB",
            scaling: { factor: 0.1 },
            semantics: { brick: "Electric_Power_Sensor", haystack: ["elec", "power", "sensor"] }
          },
          {
            id: "alarm",
            name: "Alarm",
            table: "input",
            address: 7,
            dataType: "bool",
            bit: 3,
            deadband: 0,
            alarmWhen: "off"
          },
          { id: "pump", name: "Pump", table: "coil", address: 1, dataType: "bool", writable: true }
        ]
      },
      {
        protocol: "bacnet-ip",
        id: "ahu",
        deviceInstance: 1001,
        address: "192.168.1.20",
        points: [
          {
            id: "setpoint",
            name: "Setpoint",
            objectType: "analog-value",
            instance: 3,
            writable: true,
            limits: { min: 16, max: 26 },
            publish: { mode: "change", deadband: 0.5, maxSilenceMs: 600_000 }
          }
        ]
      },
      {
        protocol: "simulator",
        id: "sim",
        points: [{ id: "temp", name: "Temp", waveform: "sine", min: 18, max: 24, periodSeconds: 120 }]
      }
    ]
  })
)

describe("point catalog", () => {
  it.effect("lists every point in config order with its topic, source, publish mode and semantics", () =>
    Effect.gen(function* () {
      const { points } = pointCatalog(yield* config)
      expect(points.map((point) => `${point.device}/${point.id}`)).toEqual([
        "meter/power",
        "meter/alarm",
        "meter/pump",
        "ahu/setpoint",
        "sim/temp"
      ])
      expect(points[0]).toEqual({
        device: "meter",
        id: "power",
        name: "Power",
        unit: "unit:KiloW",
        writable: false,
        topic: "s/b/meter/power",
        source: "holding 40 · float32 CDAB",
        read: "polled every 5 s",
        cov: false,
        publish: "aggregate every 15 min",
        scaling: { factor: 0.1, offset: 0 },
        brick: "Electric_Power_Sensor",
        haystack: ["elec", "power", "sensor"]
      })
      expect(points.map((point) => point.source)).toEqual([
        "holding 40 · float32 CDAB",
        "input 7 bit 3 · bool ABCD",
        "coil 1 · bool",
        "analog-value 3 · present-value · priority 8",
        "sine 18 to 24 · 2 min"
      ])
      // A BACnet present value is asked for by change of value (`cov` is on by default); the poll is its fallback.
      expect(points.map((point) => point.read)).toEqual([
        "polled every 5 s",
        "polled every 5 s",
        "polled every 5 s",
        "on change of value where the device supports it, polled every 5 s otherwise",
        "polled every 5 s"
      ])
      expect(points.map((point) => point.cov)).toEqual([false, false, false, true, false])
      // An alarm point says when it is active, as its config does.
      expect(points.map((point) => point.alarmWhen)).toEqual([undefined, "off", undefined, undefined, undefined])
      // A point's own deadband or publish wins over its device's.
      expect(points.map((point) => point.publish)).toEqual([
        "aggregate every 15 min",
        "on change",
        "aggregate every 15 min",
        "on change ≥ 0.5, at least every 10 min",
        "every read"
      ])
      expect(points[3]?.limits).toEqual({ min: 16, max: 26 })
    })
  )

  it("says a sample interval in whole units", () => {
    expect(publishLabel({ mode: "sample" })).toBe("every read")
    expect(publishLabel({ mode: "sample", intervalMs: 60_000 })).toBe("latest, every 1 min")
    expect(publishLabel({ mode: "sample", intervalMs: 3_600_000 })).toBe("latest, every 1 h")
    expect(publishLabel({ mode: "sample", intervalMs: 5_000 })).toBe("latest, every 5 s")
  })

  it("says a point read on change of value sends each change, not every poll", () => {
    expect(publishLabel({ mode: "sample" }, true)).toBe("on change of value (COV)")
    expect(publishLabel({ mode: "sample", intervalMs: 60_000 }, true)).toBe("latest, every 1 min")
    expect(publishLabel({ mode: "change", deadband: 0.5 }, true)).toBe("on change ≥ 0.5")
  })
})
