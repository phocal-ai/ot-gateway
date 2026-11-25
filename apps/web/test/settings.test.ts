import { describe, expect, it } from "@effect/vitest"
import {
  deviceAddress,
  duration,
  editAccessLine,
  fileName,
  formatSetting,
  sectionTitle,
  settingLabel,
  splitTuning
} from "../src/lib/settings.ts"

describe("formatSetting", () => {
  it("shows durations, yes and no, amounts and names as people read them", () => {
    expect(formatSetting("healthIntervalMs", 60_000)).toBe("1 min")
    expect(formatSetting("requestTimeoutMs", 250)).toBe("250 ms")
    expect(formatSetting("covLifetimeSeconds", 300)).toBe("5 min")
    expect(formatSetting("cov", true)).toBe("yes")
    expect(formatSetting("maxRows", 1_000_000)).toBe("1,000,000 messages")
    expect(formatSetting("retentionDays", 7)).toBe("7 days per minute")
    expect(formatSetting("port", 47808)).toBe("47808")
    expect(formatSetting("deviceInstance", 1234)).toBe("1234")
    expect(formatSetting("version", "auto")).toBe("5, or 3.1.1 if the broker needs it")
    expect(formatSetting("url", "mqtt://broker:1883")).toBe("mqtt://broker:1883")
  })

  it("spells out nested settings", () => {
    expect(formatSetting("thresholds", { lowMs: 1000, enabled: true })).toBe("low ms 1 s · enabled yes")
    expect(formatSetting("addresses", ["a", "b"])).toBe("a, b")
  })
})

describe("labels", () => {
  it("names known settings and sections, and puts unknown keys in words", () => {
    expect(settingLabel("pollIntervalMs")).toBe("Read every")
    expect(settingLabel("someNewSetting")).toBe("Some new setting")
    expect(sectionTitle("mqtt")).toBe("Broker")
    expect(sectionTitle("newBlock")).toBe("New block")
  })
})

describe("deviceAddress", () => {
  it("says where each kind of device is reached", () => {
    expect(
      deviceAddress("modbus-tcp", [
        { key: "host", value: "10.0.1.1" },
        { key: "port", value: 502 },
        { key: "unitId", value: 1 }
      ])
    ).toBe("10.0.1.1:502 · unit 1")
    expect(deviceAddress("bacnet-ip", [{ key: "deviceInstance", value: 1234 }])).toBe("device 1234, found by broadcast")
    expect(
      deviceAddress("bacnet-ip", [
        { key: "deviceInstance", value: 1234 },
        { key: "address", value: "10.0.0.9:47808" }
      ])
    ).toBe("device 1234 at 10.0.0.9:47808")
    expect(deviceAddress("simulator", [])).toBe("on this gateway")
  })
})

describe("duration", () => {
  it("picks the unit", () => {
    expect(duration(1500)).toBe("1.5 s")
    expect(duration(5_400_000)).toBe("1.5 h")
  })
})

describe("splitTuning", () => {
  it("puts request pacing, sizes and retries under Advanced and keeps the rest in order", () => {
    const entries = [{ key: "host" }, { key: "requestGapMs" }, { key: "unitId" }, { key: "maxRegistersPerRead" }]
    expect(splitTuning(entries)).toEqual({
      main: [{ key: "host" }, { key: "unitId" }],
      advanced: [{ key: "requestGapMs" }, { key: "maxRegistersPerRead" }]
    })
  })
})

describe("fileName", () => {
  it("shows a path by its last part, with either slash and a trailing one", () => {
    expect(fileName("/var/lib/ot-gateway/buffer.db")).toBe("buffer.db")
    expect(fileName("C:\\data\\history.db")).toBe("history.db")
    expect(fileName("/srv/web/")).toBe("web")
    expect(fileName("plain.db")).toBe("plain.db")
  })
})

describe("editAccessLine", () => {
  it("says why editing is allowed: a token on the network, or loopback only", () => {
    expect(editAccessLine({ enabled: true, auth: "token" })).toContain("OT_GATEWAY_EDIT_TOKEN")
    expect(editAccessLine({ enabled: true, auth: "none" })).toContain("127.0.0.1")
  })

  it("says nothing while editing is off: the reason and the fix say it then", () => {
    expect(editAccessLine({ enabled: false, auth: "none" })).toBeUndefined()
  })
})
