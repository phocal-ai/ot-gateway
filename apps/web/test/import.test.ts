/**
 * The upload panel's logic: changes to an uploaded list's devices as the gateway takes them, the gateway's words
 * put in the page's, and the template as a download.
 */
import { describe, expect, it } from "@effect/vitest"
import { columnNotes, pageError, renamesOf, templateHref } from "../src/lib/import.ts"

describe("renamesOf", () => {
  const devices = [
    { name: "Main meter", protocol: "modbus-tcp" as const },
    { name: "AHU 1", protocol: "bacnet-ip" as const },
    { name: "Untouched", protocol: "modbus-tcp" as const }
  ]

  it("sends a host for Modbus TCP and an address for BACnet/IP, trimmed", () => {
    expect(
      renamesOf(
        { "Main meter": { id: " main-meter-2 ", where: "10.0.0.9" }, "AHU 1": { id: "", where: "10.0.0.40:47808" } },
        devices
      )
    ).toEqual([
      { name: "Main meter", id: "main-meter-2", host: "10.0.0.9" },
      { name: "AHU 1", address: "10.0.0.40:47808" }
    ])
  })

  it("leaves out devices with nothing typed, so the file's values stay", () => {
    expect(renamesOf({ Untouched: { id: "  ", where: "" } }, devices)).toEqual([])
    expect(renamesOf({}, devices)).toEqual([])
  })
})

describe("pageError", () => {
  it("puts a clashing id in the page's words, with the way to fix it", () => {
    expect(pageError('device id "meter" is already in the config')).toBe(
      'A device with the id "meter" is already on this gateway: give this one another id with Change id or host.'
    )
  })

  it("keeps any other message as the gateway wrote it", () => {
    expect(pageError("row 3: register is missing")).toBe("row 3: register is missing")
  })
})

describe("templateHref", () => {
  it("is a CSV data URL that reads back as the template", () => {
    const template = "device,point,name\nmeter,power,Active power\n"
    const href = templateHref(template)
    expect(href.startsWith("data:text/csv;charset=utf-8,")).toBe(true)
    expect(decodeURIComponent(href.slice(href.indexOf(",") + 1))).toBe(template)
  })
})

describe("columnNotes", () => {
  it("lists required, the default and the values, and nothing a column does not have", () => {
    expect(
      columnNotes({
        name: "table",
        scope: "modbus-tcp",
        required: false,
        description: "The register table.",
        default: "holding",
        values: ["holding", "input"]
      })
    ).toEqual(["default holding", "holding, input"])
    expect(columnNotes({ name: "device", scope: "any", required: true, description: "The device." })).toEqual([
      "required"
    ])
  })
})
