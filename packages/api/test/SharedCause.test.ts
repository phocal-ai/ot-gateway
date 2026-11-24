import { describe, expect, it } from "vitest"
import {
  brokerHostOf,
  commonHost,
  isLoopback,
  preciseDuration,
  roughDuration,
  sameHost,
  SHARED_CAUSE_WINDOW_MS,
  sharedCauses
} from "../src/SharedCause.ts"

/** Every device on this machine, as a bench or a demo runs them. */
const onLoopback = () => "127.0.0.1"

describe("sharedCauses", () => {
  it("groups two devices that failed within the window, with one line for both", () => {
    const found = sharedCauses([
      { id: 1, device: "meter", at: 1_000 },
      { id: 2, device: "boiler", at: 7_000 },
      { id: 3, device: "pump", at: 7_000 + SHARED_CAUSE_WINDOW_MS }
    ])
    expect(found).toEqual([
      {
        ids: [1, 2],
        devices: ["meter", "boiler"],
        line: "2 devices (meter, boiler) stopped answering within 6 s of each other: likely a shared cause (power, a switch, the gateway's own network)"
      }
    ])
  })

  it("finds none for one device that failed twice, or for failures far apart", () => {
    expect(
      sharedCauses([
        { id: 1, device: "meter", at: 0 },
        { id: 2, device: "meter", at: 2_000 }
      ])
    ).toEqual([])
    expect(
      sharedCauses([
        { id: 1, device: "meter", at: 0 },
        { id: 2, device: "boiler", at: SHARED_CAUSE_WINDOW_MS + 1 }
      ])
    ).toEqual([])
    expect(sharedCauses([])).toEqual([])
  })

  it("names the one host a group's devices sit on: the host, its power or its link is the likelier cause", () => {
    const hosts = new Map([
      ["meter-a", "10.0.1.20"],
      ["meter-b", "10.0.1.20"],
      ["boiler", "10.0.2.5"]
    ])
    const [onOne] = sharedCauses(
      [
        { id: 1, device: "meter-a", at: 0 },
        { id: 2, device: "meter-b", at: 2_000 }
      ],
      (device) => hosts.get(device)
    )
    expect(onOne).toEqual({
      ids: [1, 2],
      devices: ["meter-a", "meter-b"],
      host: "10.0.1.20",
      line: "2 devices (meter-a, meter-b) stopped answering within 2 s of each other, both on 10.0.1.20: likely the host itself, its power or its network link"
    })
    const [apart] = sharedCauses(
      [
        { id: 1, device: "meter-a", at: 0 },
        { id: 2, device: "boiler", at: 2_000 }
      ],
      (device) => hosts.get(device)
    )
    expect(apart).not.toHaveProperty("host")
    expect(commonHost(["meter-a", "nowhere"], (device) => hosts.get(device))).toBeUndefined()
  })

  it("adds a broker on the devices' host that went away with them, loopback in any spelling", () => {
    const failures = [
      { id: 2, device: "energy-meter", at: 3_000 },
      { id: 3, device: "heat-pump", at: 6_000 }
    ]
    const [withBroker] = sharedCauses(failures, onLoopback, {
      host: brokerHostOf("mqtt://localhost:1883"),
      disconnects: [{ id: 1, at: 0 }]
    })
    expect(withBroker).toEqual({
      ids: [2, 3],
      devices: ["energy-meter", "heat-pump"],
      host: "127.0.0.1",
      broker: 1,
      line: "2 devices (energy-meter, heat-pump) and the broker stopped answering within 6 s of each other, all on 127.0.0.1: likely the host itself, its power or its network link"
    })
    // A broker elsewhere, or one lost long before, is no part of it.
    for (const broker of [
      { host: brokerHostOf("mqtt://10.0.0.9:1883"), disconnects: [{ id: 1, at: 0 }] },
      { host: "localhost", disconnects: [{ id: 1, at: 3_000 - SHARED_CAUSE_WINDOW_MS - 1 }] }
    ]) {
      const [without] = sharedCauses(failures, onLoopback, broker)
      expect(without).not.toHaveProperty("broker")
      expect(without?.line).toMatch(/^2 devices \(energy-meter, heat-pump\) stopped answering within 3 s/)
    }
    // Without one host for the devices, the broker is not said to share it.
    expect(
      sharedCauses(failures, () => undefined, { host: "localhost", disconnects: [{ id: 1, at: 0 }] })[0]
    ).not.toHaveProperty("broker")
  })
})

describe("sameHost", () => {
  it("takes every loopback spelling for this machine, and other hosts by name", () => {
    expect(sameHost("localhost", "127.0.0.1")).toBe(true)
    expect(sameHost("::1", "127.0.0.1")).toBe(true)
    expect(sameHost("[::1]", "LOCALHOST")).toBe(true)
    expect(sameHost("127.0.1.1", "localhost")).toBe(true)
    expect(sameHost("10.0.0.5", "10.0.0.5")).toBe(true)
    expect(sameHost("10.0.0.5", "127.0.0.1")).toBe(false)
    expect(isLoopback("broker.local")).toBe(false)
  })

  it("reads the broker's host from its URL", () => {
    expect(brokerHostOf("mqtt://localhost:1883")).toBe("localhost")
    expect(brokerHostOf("mqtts://[::1]:8883")).toBe("::1")
    expect(brokerHostOf("not a url")).toBeUndefined()
  })
})

describe("roughDuration", () => {
  it("is as coarse as a glance needs", () => {
    expect(roughDuration(6_400)).toBe("6 s")
    expect(roughDuration(4 * 60_000)).toBe("4 min")
    expect(roughDuration(3 * 3_600_000)).toBe("3 h")
    expect(roughDuration(3 * 86_400_000)).toBe("3 d")
  })
})

describe("preciseDuration", () => {
  it("says minutes and seconds under 10 minutes, then as roughly as roughDuration", () => {
    expect(preciseDuration(45_400)).toBe("45 s")
    expect(preciseDuration(125_000)).toBe("2 min 5 s")
    expect(preciseDuration(120_000)).toBe("2 min")
    expect(preciseDuration(599_000)).toBe("9 min 59 s")
    expect(preciseDuration(12 * 60_000 + 20_000)).toBe("12 min")
  })
})
