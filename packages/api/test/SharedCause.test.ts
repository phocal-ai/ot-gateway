import { describe, expect, it } from "vitest"
import { roughDuration, SHARED_CAUSE_WINDOW_MS, sharedCauses } from "../src/SharedCause.ts"

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
})

describe("roughDuration", () => {
  it("is as coarse as a glance needs", () => {
    expect(roughDuration(6_400)).toBe("6 s")
    expect(roughDuration(4 * 60_000)).toBe("4 min")
    expect(roughDuration(3 * 3_600_000)).toBe("3 h")
    expect(roughDuration(3 * 86_400_000)).toBe("3 d")
  })
})
