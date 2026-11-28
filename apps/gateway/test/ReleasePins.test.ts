/**
 * A release moves its tag (scripts/release-pins.sh) in compose.yaml, the packaging/ot-gateway wrapper, the docs and the
 * Claude Code plugin. The compose pin is the reference: every other pin must carry the same tag, so a missed one fails
 * here instead of on a user's machine.
 */
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repoFile = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url))
const read = (path: string) => readFileSync(repoFile(path), "utf8")

const tagShape = String.raw`v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`
const composePin = new RegExp(String.raw`OT_GATEWAY_TAG:-(${tagShape})`)
const wrapperPin = new RegExp(String.raw`^release=(${tagShape})\s*$`, "m")
const docPins = [
  new RegExp(String.raw`ghcr\.io/phocal-ai/ot-gateway:(${tagShape})`, "g"),
  new RegExp(String.raw`phocal-ai/ot-gateway/(${tagShape})/`, "g"),
  new RegExp(String.raw`git checkout (${tagShape})`, "g"),
  new RegExp(String.raw`OT_GATEWAY_TAG:-(${tagShape})`, "g")
]
const docs = ["docs/operations.md", "docs/raspberry-pi-testing.md"]

const McpJson = Schema.Struct({
  mcpServers: Schema.Record(Schema.String, Schema.Struct({ args: Schema.Array(Schema.String) }))
})
const Plugin = Schema.Struct({ version: Schema.optional(Schema.String) })
const Marketplace = Schema.Struct({ plugins: Schema.Array(Schema.Struct({ version: Schema.optional(Schema.String) })) })
const decodeMcpJson = Schema.decodeUnknownSync(Schema.fromJsonString(McpJson))
const decodePlugin = Schema.decodeUnknownSync(Schema.fromJsonString(Plugin))
const decodeMarketplace = Schema.decodeUnknownSync(Schema.fromJsonString(Marketplace))

interface Pin {
  readonly location: string
  readonly tag: string
}

const pinsIn = (path: string): ReadonlyArray<Pin> =>
  read(path)
    .split("\n")
    .flatMap((line, index) =>
      docPins.flatMap((shape) =>
        [...line.matchAll(shape)].map((match) => ({ location: `${path}:${index + 1}`, tag: match[1] ?? "" }))
      )
    )

const releaseTag = (() => {
  const tag = composePin.exec(read("packaging/compose.yaml"))?.[1]
  if (tag === undefined) throw new Error("packaging/compose.yaml has no OT_GATEWAY_TAG:-vX.Y.Z default")
  return tag
})()

describe("release pins", () => {
  it("packaging/ot-gateway runs the image compose.yaml pins", () => {
    const lines = read("packaging/ot-gateway").split("\n")
    const index = lines.findIndex((line) => wrapperPin.test(line))
    const tag = wrapperPin.exec(lines[index] ?? "")?.[1]
    const found = tag === undefined ? "no release=vX.Y.Z line" : `packaging/ot-gateway:${index + 1}: ${tag}`
    expect(tag, `${found}, compose.yaml pins ${releaseTag}`).toBe(releaseTag)
  })

  it("the Claude Code plugin runs the npm release compose.yaml pins, and carries its version", () => {
    const version = releaseTag.slice(1)
    const mcp = decodeMcpJson(read("plugins/ot-gateway/.mcp.json"))
    // An exact version: a bare `ot-gateway` (or `@latest`) lets npx run an older release it has cached.
    expect(mcp.mcpServers["ot-gateway"]?.args, "plugins/ot-gateway/.mcp.json").toEqual([
      "-y",
      `ot-gateway@${version}`,
      "mcp"
    ])
    const plugin = decodePlugin(read("plugins/ot-gateway/.claude-plugin/plugin.json"))
    expect(plugin.version, "plugins/ot-gateway/.claude-plugin/plugin.json").toBe(version)
    // The version lives in plugin.json only: a second one in the marketplace entry would be one more pin to miss.
    const marketplace = decodeMarketplace(read(".claude-plugin/marketplace.json"))
    expect(marketplace.plugins.map((entry) => entry.version)).toEqual(marketplace.plugins.map(() => undefined))
  })

  it.each(docs)("%s pins the tag compose.yaml pins, everywhere", (path) => {
    const pins = pinsIn(path)
    expect(pins.length, `${path} holds no release pin`).toBeGreaterThan(0)
    const stale = pins.filter((pin) => pin.tag !== releaseTag).map((pin) => `${pin.location}: ${pin.tag}`)
    expect(stale, `pins other than ${releaseTag} (compose.yaml)`).toEqual([])
  })

  it("scripts/release-pins.sh moves every pin above, and only the pins", () => {
    const files = [
      "packaging/compose.yaml",
      "packaging/ot-gateway",
      ...docs,
      "plugins/ot-gateway/.mcp.json",
      "plugins/ot-gateway/.claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json"
    ]
    const copy = mkdtempSync(join(tmpdir(), "release-pins-"))
    try {
      for (const file of ["scripts/release-pins.sh", ...files]) cpSync(repoFile(file), join(copy, file))
      execFileSync("bash", [join(copy, "scripts/release-pins.sh"), "v99.0.0"], { stdio: "pipe" })
      const moved = (file: string) => readFileSync(join(copy, file), "utf8")
      for (const file of files) {
        expect(moved(file).includes(releaseTag), `${file} still names ${releaseTag}`).toBe(false)
        // Nothing but the tag changes: put the old tag back and the file is what it was.
        expect(moved(file).replaceAll("v99.0.0", releaseTag).replaceAll("99.0.0", releaseTag.slice(1))).toBe(read(file))
      }
      expect(moved("plugins/ot-gateway/.mcp.json")).toContain(`"ot-gateway@99.0.0"`)
      expect(moved("plugins/ot-gateway/.claude-plugin/plugin.json")).toContain(`"version": "99.0.0"`)
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
})
