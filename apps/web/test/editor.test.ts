/**
 * The Settings tab's editor, without a browser: values read from the config file's text, written back without
 * touching anything else, issues put under their field, and the headers every write carries.
 */
import { describe, expect, it } from "@effect/vitest"
import { isChanged, issuesByField, savedMessage, valuesFrom, withValues } from "../src/lib/editor.ts"
import { writeHeaders } from "../src/lib/editor-api.ts"

const file = `${JSON.stringify(
  {
    site: "s",
    building: "b",
    mqtt: { url: "mqtt://localhost:1883", clientId: "gw", passwordEnv: "MQTT_PASSWORD" },
    devices: [{ protocol: "simulator", id: "meter", points: [] }]
  },
  null,
  2
)}\n`

describe("valuesFrom", () => {
  it("reads a card's fields from the file, empty for what it leaves out", () => {
    expect(valuesFrom(file, "gateway")).toEqual({ site: "s", building: "b", id: "", healthIntervalMs: "" })
    expect(valuesFrom(file, "mqtt")).toEqual({
      url: "mqtt://localhost:1883",
      username: "",
      clientId: "gw",
      version: ""
    })
    expect(valuesFrom("{ broken", "gateway")).toBeUndefined()
    expect(valuesFrom("[]", "gateway")).toBeUndefined()
  })
})

describe("withValues", () => {
  it("writes the fields in, keeps everything else and its order, and drops an emptied optional one", () => {
    const next = withValues(file, "mqtt", {
      url: " mqtts://broker:8883 ",
      username: "gw-user",
      clientId: "",
      version: "5"
    })
    expect(next).toBe(
      `${JSON.stringify(
        {
          site: "s",
          building: "b",
          mqtt: { url: "mqtts://broker:8883", passwordEnv: "MQTT_PASSWORD", username: "gw-user", version: "5" },
          devices: [{ protocol: "simulator", id: "meter", points: [] }]
        },
        null,
        2
      )}\n`
    )
  })

  it("writes a number field as a number, and leaves text that is not one for the check to name", () => {
    const values = { site: "t", building: "b", id: "second", healthIntervalMs: "30000" }
    expect(JSON.parse(withValues(file, "gateway", values) ?? "")).toMatchObject({
      site: "t",
      id: "second",
      healthIntervalMs: 30_000
    })
    expect(JSON.parse(withValues(file, "gateway", { ...values, healthIntervalMs: "soon" }) ?? "")).toMatchObject({
      healthIntervalMs: "soon"
    })
    // A required field emptied stays in the file, empty, so the check says it is required.
    expect(JSON.parse(withValues(file, "gateway", { ...values, site: "" }) ?? "")).toMatchObject({ site: "" })
  })

  it("knows when the form differs from the file", () => {
    expect(isChanged(file, "gateway", { site: "s", building: "b", id: "", healthIntervalMs: "" })).toBe(false)
    expect(isChanged(file, "gateway", { site: "s ", building: "b", id: "", healthIntervalMs: "" })).toBe(false)
    expect(isChanged(file, "gateway", { site: "t", building: "b", id: "", healthIntervalMs: "" })).toBe(true)
  })
})

describe("issuesByField", () => {
  it("puts each issue under its field, and the rest of the file's issues apart", () => {
    const issues = [
      { path: ["mqtt", "url"], message: "must start with mqtts:// or mqtt://" },
      { path: ["site"], message: "must be a slug" },
      { path: ["devices", 0, "points"], message: "must not be empty" },
      { path: [], message: "is not valid JSON" }
    ]
    expect(issuesByField(issues, "mqtt")).toEqual({
      byField: { url: ["must start with mqtts:// or mqtt://"] },
      elsewhere: ["site: must be a slug", "devices.0.points: must not be empty", "is not valid JSON"]
    })
    expect(issuesByField(issues, "gateway").byField).toEqual({ site: ["must be a slug"] })
  })
})

describe("writes", () => {
  it("carry the page's header, and the token when there is one", () => {
    expect(writeHeaders(undefined)).toEqual({ "x-ot-gateway": "1" })
    expect(writeHeaders("")).toEqual({ "x-ot-gateway": "1" })
    expect(writeHeaders("abc")).toEqual({ "x-ot-gateway": "1", authorization: "Bearer abc" })
  })

  it("say what a save applied", () => {
    expect(savedMessage({ summary: "gateway: site", changes: ["gateway: site"], restartNeeded: [] })).toBe(
      "Saved and applied: gateway: site."
    )
    expect(savedMessage({ summary: "nothing to apply", changes: [], restartNeeded: [] })).toBe(
      "Saved. Nothing changed, so nothing had to be applied."
    )
  })
})
