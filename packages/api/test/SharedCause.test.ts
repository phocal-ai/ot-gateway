import { describe, expect, it } from "vitest"
import { commonHost, preciseDuration, roughDuration, SHARED_CAUSE_WINDOW_MS, sharedCauses } from "../src/SharedCause.ts"

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
