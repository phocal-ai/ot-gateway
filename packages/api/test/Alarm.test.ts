/** The one rule for which points are alarms, shared by the gateway and the status page. */
import { describe, expect, it } from "@effect/vitest"
import { effectiveAlarmWhen, isAlarmActive } from "../src/Alarm.ts"

describe("effectiveAlarmWhen", () => {
  it("makes a point an alarm by its Brick class or its Haystack tag, active when on", () => {
    expect(effectiveAlarmWhen({ brick: "Alarm" })).toBe("on")
    expect(effectiveAlarmWhen({ brick: "Smoke_Detection_Alarm" })).toBe("on")
    expect(effectiveAlarmWhen({ brick: "Alarm_Delay_Parameter" })).toBeUndefined()
    expect(effectiveAlarmWhen({ haystack: ["elec", "breaker", "alarm"] })).toBe("on")
  })

  it("takes the config's alarmWhen over semantics", () => {
    expect(effectiveAlarmWhen({ alarmWhen: "off", brick: "Alarm", haystack: ["alarm"] })).toBe("off")
    expect(effectiveAlarmWhen({ alarmWhen: "on" })).toBe("on")
  })

  it("is no alarm with neither", () => {
    expect(effectiveAlarmWhen({})).toBeUndefined()
    expect(effectiveAlarmWhen({ brick: "Run_Status", haystack: ["compressor", "run", "sensor"] })).toBeUndefined()
    expect(effectiveAlarmWhen({ alarmWhen: undefined, brick: undefined, haystack: undefined })).toBeUndefined()
  })
})

describe("isAlarmActive", () => {
  it("is active on true or not 0 for on, on false or 0 for off", () => {
    expect([true, 1, -2, false, 0].map((value) => isAlarmActive("on", value))).toEqual([true, true, true, false, false])
    expect([true, 1, false, 0].map((value) => isAlarmActive("off", value))).toEqual([false, false, true, true])
  })
})
