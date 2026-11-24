/**
 * What to check for a failing device: the hint follows the failure class, the driver's words and the protocol.
 */
import { describe, expect, it } from "@effect/vitest"
import { fallbackHint, flappingAlarmHint, hintRules, whatToCheck } from "../src/Hints.ts"

const mentions = (checks: ReadonlyArray<string>, word: RegExp) => checks.some((check) => word.test(check))

describe("whatToCheck", () => {
  it("asks whether the device is on, the port right and a firewall in between when the connection is refused", () => {
    const hint = whatToCheck("modbus-tcp", "connection", "could not connect: connection refused by 127.0.0.1:5999")
    expect(hint.meaning).toMatch(/nothing accepts a connection/)
    expect(mentions(hint.checks, /switched on/)).toBe(true)
    expect(mentions(hint.checks, /port/)).toBe(true)
    expect(mentions(hint.checks, /firewall/)).toBe(true)
  })

  it("tells a host name that does not resolve and an address nothing answers at apart", () => {
    expect(
      whatToCheck("modbus-tcp", "connection", "could not connect: host name meter.local not found").meaning
    ).toMatch(/does not resolve/)
    expect(whatToCheck("modbus-tcp", "connection", "could not connect: host 10.0.0.9 unreachable").meaning).toMatch(
      /Nothing answers/
    )
    expect(whatToCheck("modbus-tcp", "connection", undefined).meaning).toMatch(/cannot connect/)
  })

  it("points a Modbus timeout at the unit id and a busy device", () => {
    const hint = whatToCheck("modbus-tcp", "timeout", "no response to 4 item(s) within 3s")
    expect(hint.meaning).toMatch(/reachable/)
    expect(mentions(hint.checks, /unit id/)).toBe(true)
    expect(mentions(hint.checks, /busy/)).toBe(true)
  })

  it("points a BACnet timeout at the device instance, and an unanswered Who-Is at broadcasts across subnets", () => {
    expect(
      mentions(whatToCheck("bacnet-ip", "timeout", "no answer from 10.0.0.5:47808").checks, /device instance/)
    ).toBe(true)
    const whoIs = whatToCheck("bacnet-ip", "timeout", "device 2001 did not answer Who-Is; asking again in 30 s")
    expect(whoIs.meaning).toMatch(/Who-Is/)
    expect(mentions(whoIs.checks, /subnet/)).toBe(true)
  })

  it("points a refusal or a bad reply at the register map, data type and word order", () => {
    const refused = whatToCheck("modbus-tcp", "protocol", "device refused every read (illegal_data_address)")
    expect(mentions(refused.checks, /register map/)).toBe(true)
    expect(mentions(refused.checks, /data type/)).toBe(true)
    const bad = whatToCheck("modbus-tcp", "invalid-response", "short frame")
    expect(mentions(bad.checks, /word order/)).toBe(true)
    expect(mentions(whatToCheck("bacnet-ip", "protocol", "unknown-object").checks, /object/)).toBe(true)
  })

  it("leads with power, switch, cable and a restart for a device that answered before, config checks last", () => {
    const never = whatToCheck("bacnet-ip", "timeout", "no answer from 10.0.0.5:47808")
    expect(never.checks[0]).toMatch(/device instance in the config/)
    const worked = whatToCheck("bacnet-ip", "timeout", "no answer from 10.0.0.5:47808", { answeredBefore: true })
    expect(worked.checks[0]).toMatch(/answered earlier in this run/)
    expect(worked.checks[0]).toMatch(/power/)
    expect(worked.checks.at(-1)).toMatch(/in the config/)
    // The same checks, reordered: nothing is lost.
    expect(worked.checks.slice(1).toSorted()).toEqual(never.checks.toSorted())
  })

  it("leads with what the devices share in a shared outage, and never with the config", () => {
    const hint = whatToCheck("modbus-tcp", "connection", "could not connect: connection refused", {
      sharedCause: true,
      answeredBefore: true
    })
    expect(hint.checks[0]).toMatch(/Others failed with it/)
    expect(hint.checks[1]).toMatch(/answered earlier/)
    expect(hint.checks.findIndex((check) => /in the config/.test(check))).toBeGreaterThan(2)
  })

  it("gives a BACnet device that cannot be reached BACnet's checks, not Modbus's", () => {
    const notFound = whatToCheck("bacnet-ip", "connection", "device 2001 has not been found")
    expect(notFound.meaning).toMatch(/I-Am/)
    const unreachable = whatToCheck("bacnet-ip", "connection", "could not connect: host 10.0.0.9 unreachable")
    for (const hint of [notFound, unreachable]) {
      expect(mentions(hint.checks, /Modbus|unit id|port 502/)).toBe(false)
      expect(mentions(hint.checks, /47808/)).toBe(true)
      expect(mentions(hint.checks, /BBMD/)).toBe(true)
    }
    // An unanswered Who-Is and a timed-out request name the instance, UDP 47808, broadcasts and BACnet routers.
    const timeout = whatToCheck("bacnet-ip", "timeout", "no answer from 10.0.0.5:47808")
    for (const word of [/device instance/, /UDP 47808/, /BBMD/, /BACnet router/]) {
      expect(mentions(timeout.checks, word)).toBe(true)
    }
  })

  it("names the host that devices failing together share, as the first thing to check", () => {
    const hint = whatToCheck("modbus-tcp", "timeout", "no response", {
      sharedCause: true,
      sharedHost: "10.0.1.20"
    })
    expect(hint.checks[0]).toBe(
      "Others on 10.0.1.20 failed with it: check the host itself, its power and its network link before its config."
    )
  })

  it("reads a flapping alarm's fixed rhythm as wiring or a cycling device first", () => {
    expect(flappingAlarmHint.checks[0]).toMatch(/wiring or contact/)
  })

  it("keeps the config first for a refusal, where the device answers, whatever it did before", () => {
    const refused = whatToCheck("modbus-tcp", "protocol", "illegal_data_address", { answeredBefore: true })
    expect(refused).toBe(whatToCheck("modbus-tcp", "protocol", "illegal_data_address"))
  })

  it("falls back to the gateway's log for a reason it has no hint for", () => {
    expect(whatToCheck("modbus-tcp", "crashed", "boom")).toBe(fallbackHint)
    expect(whatToCheck("simulator", "something-new", undefined)).toBe(fallbackHint)
  })

  it("has a hint for every failure class the gateway reports, on every protocol", () => {
    const reasons = [
      "connection",
      "timeout",
      "protocol",
      "invalid-response",
      "configuration",
      "not-implemented",
      "cycle-timeout"
    ]
    for (const protocol of ["modbus-tcp", "bacnet-ip", "simulator"] as const)
      for (const reason of reasons) expect(whatToCheck(protocol, reason, "")).not.toBe(fallbackHint)
    for (const rule of hintRules) expect(rule.hint.checks.length).toBeGreaterThan(0)
  })
})
