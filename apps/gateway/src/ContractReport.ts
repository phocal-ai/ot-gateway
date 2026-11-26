/**
 * `ot-gateway contract`: the MQTT contract (`@ot-gateway/core/Contract`), printed. Without a message it is the topic
 * table and each message in short; with one (`contract value`), that message's fields. `--json` prints everything
 * for agents (`{ok, version, url, topics, schemas}`), or with a message that message's JSON Schema alone, the same
 * document as `docs/mqtt-contract/v1/<message>.schema.json`, so it can be saved and handed to a validator.
 *
 * Everything here is read from the contract's schemas: the descriptions are their annotations and the fields come
 * from the generated JSON Schemas, so the CLI cannot say something the contract does not. It needs no config and no
 * broker.
 */
import {
  contractJsonSchemas,
  type ContractMessage,
  contractSchemaBaseUrl,
  contractTopics,
  contractVersion
} from "@ot-gateway/core"
import { Predicate } from "effect"

/** The message names, in the contract's order: what `contract <message>` takes. */
export const contractMessageNames: ReadonlyArray<ContractMessage> = [
  ...new Set(contractTopics.map((topic) => topic.message))
]

/** Where the published JSON Schemas of this major version are. */
export const contractSchemaFolder = `${contractSchemaBaseUrl}/v${contractVersion.split(".")[0]}/`

const direction = (topic: (typeof contractTopics)[number]) =>
  topic.direction === "publish" ? "gateway publishes" : "gateway subscribes"

/** What `contract --json` prints: the version, the topic table and every message's JSON Schema. */
export const contractJson = () => ({
  ok: true as const,
  version: contractVersion,
  url: contractSchemaFolder,
  topics: contractTopics.map((topic) => ({ ...topic, schema: `${contractSchemaFolder}${topic.message}.schema.json` })),
  schemas: contractJsonSchemas()
})

/** A JSON Schema node, as far as the printing needs one. */
type Node = Readonly<Record<string, unknown>>

const isNode = (value: unknown): value is Node => Predicate.isObject(value) && !Array.isArray(value)

const text = (node: Node, key: string) => {
  const value = node[key]
  return typeof value === "string" ? value : undefined
}

/** A field's type in a few characters: `number | boolean`, `integer`, `"online"`, `"shutdown" | "connection-lost"`. */
export const typeLabel = (node: Node): string => {
  const values = node["enum"]
  if (Array.isArray(values)) return values.map((value) => JSON.stringify(value)).join(" | ")
  if ("const" in node) return JSON.stringify(node["const"])
  const anyOf = node["anyOf"]
  if (Array.isArray(anyOf)) return [...new Set(anyOf.filter(isNode).map(typeLabel))].join(" | ")
  const type = node["type"]
  if (type === "array") {
    const items = node["items"]
    return `${isNode(items) ? typeLabel(items) : "any"}[]`
  }
  if (type === "object" && isNode(node["additionalProperties"]) && node["properties"] === undefined) {
    return `{ [id]: ${typeLabel(node["additionalProperties"])} }`
  }
  return typeof type === "string" ? type : "any"
}

/** One field per line: name, type, optional or not, and what it is. */
const fieldLines = (node: Node, indent: string): ReadonlyArray<string> => {
  const properties = isNode(node["properties"]) ? node["properties"] : {}
  const required = new Set(Array.isArray(node["required"]) ? node["required"] : [])
  const entries = Object.entries(properties).filter((entry): entry is [string, Node] => isNode(entry[1]))
  const width = Math.max(0, ...entries.map(([name]) => name.length)) + 2
  return entries.flatMap(([name, field]) => {
    const description = text(field, "description")
    const label = `${typeLabel(field)}${required.has(name) ? "" : ", optional"}`
    // An object's own fields below it: the health message's devices and host.
    const values = field["additionalProperties"]
    const nested = isNode(field["properties"])
      ? field
      : isNode(values) && isNode(values["properties"])
        ? values
        : undefined
    return [
      `${indent}${name.padEnd(width)}${label}${description === undefined ? "" : `. ${description}`}`,
      ...(nested === undefined ? [] : fieldLines(nested, `${indent}  `))
    ]
  })
}

/** Each form of a message (the members of its `anyOf`, or the message itself) with its title and fields. */
const formLines = (schema: Node): ReadonlyArray<string> => {
  const anyOf = schema["anyOf"]
  const forms = Array.isArray(anyOf) ? anyOf.filter(isNode) : [schema]
  return forms.flatMap((form) => {
    const title = text(form, "title")
    const description = text(form, "description")
    const head =
      forms.length === 1 ? [] : [`  ${title ?? "form"}${description === undefined ? "" : `: ${description}`}`]
    return [...head, ...fieldLines(form, forms.length === 1 ? "  " : "    "), ...(forms.length === 1 ? [] : [""])]
  })
}

/** `contract <message>`, for people: its topic, direction, retain and QoS, then every field of every form. */
export const describeContractMessage = (message: ContractMessage) => {
  const schema = contractJsonSchemas()[message]
  const topics = contractTopics.filter((topic) => topic.message === message)
  const description = text(schema, "description")
  const lines = formLines(schema)
  return [
    `${message}: ${text(schema, "title") ?? message} (MQTT contract ${contractVersion})`,
    ...topics.map(
      (topic) =>
        `  ${topic.pattern}, ${direction(topic)}, QoS ${topic.qos}${topic.retained ? ", retained" : ", not retained"}`
    ),
    ...(description === undefined ? [] : ["", description]),
    "",
    message === "command"
      ? "Fields (nothing else is accepted):"
      : "Fields (a consumer ignores fields it does not know: a later 1.x may add some):",
    ...(lines.at(-1) === "" ? lines.slice(0, -1) : lines),
    "",
    `JSON Schema: ot-gateway contract ${message} --json, or ${contractSchemaFolder}${message}.schema.json`
  ].join("\n")
}

/** The width of a column of the topic table: its longest entry and two spaces. */
const columnWidth = (pick: (topic: (typeof contractTopics)[number]) => string) =>
  Math.max(...contractTopics.map((topic) => pick(topic).length)) + 2

/** `contract`, for people: the version, the topic table, each message's description, and where to read more. */
export const describeContract = () => {
  const schemas = contractJsonSchemas()
  const messageWidth = columnWidth((topic) => topic.message)
  const patternWidth = columnWidth((topic) => topic.pattern)
  return [
    `MQTT contract ${contractVersion}: every topic the gateway publishes or listens on, and its payload`,
    "",
    ...contractTopics.map(
      (topic) =>
        `  ${topic.message.padEnd(messageWidth)}${topic.pattern.padEnd(patternWidth)}${direction(topic)}, QoS ${topic.qos}${topic.retained ? ", retained" : ""}`
    ),
    "",
    ...contractMessageNames.flatMap((message) => {
      const description = text(schemas[message], "description")
      return description === undefined ? [] : [`${message}: ${description}`]
    }),
    "",
    "Every variable level is a slug from the config. All times are Unix milliseconds. The online health message names the version a gateway speaks (contract).",
    `ot-gateway contract <message> lists a message's fields (${contractMessageNames.join(", ")}); --json prints the JSON Schemas (also at ${contractSchemaFolder}); ot-gateway watch --check checks a broker's messages against them.`
  ].join("\n")
}
