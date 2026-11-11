/**
 * Who may change the gateway through its status page: only the page itself (same Origin as Host, the custom
 * header), and on a page bound to the LAN only with the edit token.
 */
import { describe, expect, it } from "@effect/vitest"
import { Option, Redacted, Schema } from "effect"
import { describeConfigChange } from "../src/ConfigChange.ts"
import { editAccess, isReadOnlyMethod, isSameOrigin, writeRefusal } from "../src/EditGuard.ts"
import { GatewayConfig } from "@ot-gateway/core"

const parseConfigSync = Schema.decodeUnknownSync(GatewayConfig)
const simulated = (id: string, max = 1) => ({
  protocol: "simulator",
  id,
  points: [{ id: "p", name: "P", waveform: "sine", min: 0, max, periodSeconds: 60 }]
})
const noToken = Option.none<Redacted.Redacted>()
const token = Option.some(Redacted.make("s3cret-token"))
const fromPage = { host: "127.0.0.1:8080", origin: "http://127.0.0.1:8080", "x-ot-gateway": "1" }

describe("editAccess", () => {
  it("allows editing on loopback without a token, and on the LAN only with one", () => {
    expect(editAccess("127.0.0.1", noToken)).toEqual({ allowed: true, auth: "none" })
    expect(editAccess("::1", noToken)).toEqual({ allowed: true, auth: "none" })
    expect(editAccess("localhost", noToken)).toEqual({ allowed: true, auth: "none" })
    expect(editAccess("0.0.0.0", noToken)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("0.0.0.0"),
      fix: expect.stringContaining("OT_GATEWAY_EDIT_TOKEN")
    })
    expect(editAccess("0.0.0.0", token)).toEqual({ allowed: true, auth: "token" })
    expect(editAccess("127.0.0.1", token)).toEqual({ allowed: true, auth: "token" })
  })
})

describe("writeRefusal", () => {
  const loopback = editAccess("127.0.0.1", noToken)

  it("lets the page's own write through", () => {
    expect(writeRefusal(fromPage, loopback, noToken)).toBeUndefined()
    expect(isSameOrigin("https://gw.local:8443", "gw.local:8443")).toBe(true)
    expect(isSameOrigin("http://localhost:8080", "localhost")).toBe(false)
  })

  it("refuses a write without Origin, from another origin, or without the custom header", () => {
    expect(writeRefusal({ ...fromPage, origin: undefined }, loopback, noToken)).toContain("no Origin header")
    expect(writeRefusal({ ...fromPage, origin: "http://evil.example" }, loopback, noToken)).toContain("another site")
    expect(writeRefusal({ ...fromPage, origin: "http://127.0.0.1:9999" }, loopback, noToken)).toContain("another site")
    expect(writeRefusal({ ...fromPage, origin: "null" }, loopback, noToken)).toContain("another site")
    expect(writeRefusal({ ...fromPage, "x-ot-gateway": undefined }, loopback, noToken)).toContain(
      "X-OT-Gateway".toLowerCase()
    )
  })

  it("refuses every write on a LAN page without a token, and asks for the token when one is set", () => {
    const lanPage = { host: "192.168.1.20:8080", origin: "http://192.168.1.20:8080", "x-ot-gateway": "1" }
    expect(writeRefusal(lanPage, editAccess("0.0.0.0", noToken), noToken)).toContain("OT_GATEWAY_EDIT_TOKEN")
    const withToken = editAccess("0.0.0.0", token)
    expect(writeRefusal(lanPage, withToken, token)).toContain("Authorization: Bearer")
    expect(writeRefusal({ ...lanPage, authorization: "Bearer wrong" }, withToken, token)).toContain(
      "Authorization: Bearer"
    )
    expect(writeRefusal({ ...lanPage, authorization: "s3cret-token" }, withToken, token)).toContain(
      "Authorization: Bearer"
    )
    expect(writeRefusal({ ...lanPage, authorization: "Bearer s3cret-token" }, withToken, token)).toBeUndefined()
    // A token never makes a foreign origin acceptable.
    expect(
      writeRefusal(
        { ...lanPage, origin: "http://evil.example", authorization: "Bearer s3cret-token" },
        withToken,
        token
      )
    ).toContain("another site")
  })

  it("only GET and HEAD skip the rules", () => {
    expect(["GET", "HEAD"].every(isReadOnlyMethod)).toBe(true)
    expect(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"].some(isReadOnlyMethod)).toBe(false)
  })
})

describe("describeConfigChange", () => {
  const base = {
    site: "s",
    building: "b",
    mqtt: { url: "mqtt://localhost:1883", clientId: "a" },
    devices: [simulated("d1"), simulated("d2")]
  }

  it("names the gateway and broker settings, and the devices, that changed", () => {
    const after = {
      ...base,
      site: "t",
      mqtt: { url: "mqtt://localhost:1883", clientId: "b" },
      devices: [simulated("d1", 2), simulated("d3")]
    }
    const change = describeConfigChange(parseConfigSync(base), parseConfigSync(after))
    expect(change.changes).toEqual([
      "gateway: site",
      "broker: clientId",
      "device d3 added",
      "device d2 removed",
      "device d1 changed"
    ])
    expect(change.restartNeeded).toEqual([])
    expect(change.summary).toBe(
      "gateway: site; broker: clientId; device d3 added; device d2 removed; device d1 changed"
    )
  })

  /** A meter with a setpoint and a relay, each with `points`' extra fields. */
  const meter = (points: ReadonlyArray<Record<string, unknown>>) => ({
    ...base,
    devices: [
      {
        protocol: "modbus-tcp",
        id: "meter",
        host: "10.0.0.3",
        points: [
          { id: "setpoint", name: "Setpoint", table: "holding", address: 1, dataType: "float32", ...points[0] },
          { id: "relay", name: "Relay", table: "coil", address: 2, dataType: "bool", ...points[1] }
        ]
      }
    ]
  })

  it("names every point that takes commands now, with its limits, and every one that no longer does", () => {
    const before = parseConfigSync(meter([{}, { writable: true }]))
    const after = parseConfigSync(meter([{ writable: true, limits: { min: 10, max: 30 } }, {}]))
    expect(describeConfigChange(before, after).changes).toEqual([
      "device meter changed",
      "writes allowed: meter/setpoint (10 to 30)",
      "writes turned off: meter/relay"
    ])
    const narrower = parseConfigSync(meter([{ writable: true, limits: { min: 15, max: 25 } }, {}]))
    expect(describeConfigChange(after, narrower).changes).toContain("write limits changed: meter/setpoint (15 to 25)")
  })

  it("says what waits for a restart, and when nothing changed", () => {
    const same = parseConfigSync(base)
    expect(describeConfigChange(same, same)).toEqual({ summary: "nothing to apply", changes: [], restartNeeded: [] })
    const change = describeConfigChange(same, parseConfigSync({ ...base, status: { port: 9090 } }))
    expect(change.restartNeeded).toEqual(["status page"])
    expect(change.summary).toBe("status page added (status page: after a restart)")
  })
})
