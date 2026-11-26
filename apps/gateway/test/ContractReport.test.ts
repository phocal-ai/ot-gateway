/** `contract`: what it prints, read from the contract's own schemas. */
import { describe, expect, it } from "@effect/vitest"
import { Predicate } from "effect"
import { contractJsonSchemas, contractMessages, contractTopics, contractVersion } from "@ot-gateway/core"
import {
  contractJson,
  contractMessageNames,
  describeContract,
  describeContractMessage,
  typeLabel
} from "../src/ContractReport.ts"

/** The field names of one form of a generated JSON Schema. */
const propertiesOf = (form: unknown) =>
  Predicate.isObject(form) && "properties" in form && Predicate.isObject(form.properties)
    ? Object.keys(form.properties)
    : []

describe("contract", () => {
  it("takes every message of the contract, in its order", () => {
    expect(contractMessageNames).toEqual(Object.keys(contractMessages))
  })

  it("lists every topic and every message for people, and where the JSON Schemas are", () => {
    const text = describeContract()
    expect(text).toContain(`MQTT contract ${contractVersion}`)
    for (const topic of contractTopics) expect(text).toContain(topic.pattern)
    for (const message of contractMessageNames) expect(text).toContain(`${message}: `)
    expect(text).toContain("https://ot-gateway.vercel.app/mqtt-contract/v1/")
  })

  it("lists every field of every form of a message, and which are optional", () => {
    const schemas = contractJsonSchemas()
    for (const message of contractMessageNames) {
      const text = describeContractMessage(message)
      const schema = schemas[message]
      const forms: ReadonlyArray<unknown> = Array.isArray(schema["anyOf"]) ? schema["anyOf"] : [schema]
      const names = forms.flatMap(propertiesOf)
      expect(names.length).toBeGreaterThan(0)
      for (const name of names) expect(text).toMatch(new RegExp(`^ +${name} +`, "m"))
    }
    const value = describeContractMessage("value")
    expect(value).toMatch(/^ {4}ts +integer\. When the device was read/m)
    expect(value).toMatch(/^ {4}unit +string, optional\./m)
    expect(describeContractMessage("health")).toMatch(/^ {6}failingSince +integer, optional\./m)
    expect(describeContractMessage("command")).toContain("nothing else is accepted")
    // $meta's publish has a form per mode, each listed by its mode.
    expect(describeContractMessage("meta")).toMatch(
      /^ {4}mode "aggregate":\n {6}mode +"aggregate"\n {6}intervalMs +integer$/m
    )
  })

  it("prints the JSON Schemas as the contract generates them, with the topic table", () => {
    const json = contractJson()
    expect(json).toMatchObject({ ok: true, version: contractVersion })
    expect(json.schemas).toEqual(contractJsonSchemas())
    expect(json.topics.map((topic) => topic.message)).toEqual(contractTopics.map((topic) => topic.message))
    expect(json.topics[0]?.schema).toBe("https://ot-gateway.vercel.app/mqtt-contract/v1/value.schema.json")
  })

  it("names a field's type in a few characters", () => {
    expect(typeLabel({ anyOf: [{ type: "number" }, { type: "boolean" }] })).toBe("number | boolean")
    expect(typeLabel({ type: "string", enum: ["on", "off"] })).toBe('"on" | "off"')
    expect(typeLabel({ type: "array", items: { type: "string" } })).toBe("string[]")
    expect(typeLabel({ type: "object", additionalProperties: { type: "object" } })).toBe("{ [id]: object }")
    expect(typeLabel({})).toBe("any")
  })
})
