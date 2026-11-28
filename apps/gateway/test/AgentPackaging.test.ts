/**
 * The packages that give an agent the gateway (the Claude Code plugin, the MCP install lines in docs/agents.md, the
 * skills) are thin: each starts the same MCP server or points at the same setup guide. These checks keep them so,
 * and keep each skill within the Agent Skills format (https://agentskills.io/specification), which other agents load.
 */
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { mcpTools } from "../src/McpTools.ts"

const root = join(import.meta.dirname, "..", "..", "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

const Marketplace = Schema.Struct({
  name: Schema.String,
  owner: Schema.Struct({ name: Schema.String }),
  plugins: Schema.Array(Schema.Struct({ name: Schema.String, source: Schema.String }))
})
const Plugin = Schema.Struct({ name: Schema.String })
const Server = Schema.Struct({ command: Schema.String, args: Schema.Array(Schema.String) })
const McpJson = Schema.Struct({ mcpServers: Schema.Record(Schema.String, Server) })
const decodeMarketplace = Schema.decodeUnknownSync(Schema.fromJsonString(Marketplace))
const decodePlugin = Schema.decodeUnknownSync(Schema.fromJsonString(Plugin))
const decodeMcpJson = Schema.decodeUnknownSync(Schema.fromJsonString(McpJson))

/** What every package starts: the server of the published CLI. */
const serverArgs = ["-y", "ot-gateway", "mcp"]

/** A skill's frontmatter fields, one `key: value` per line (the skills here keep to that). */
const frontmatterOf = (text: string): ReadonlyMap<string, string> => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1]
  expect(block).toBeDefined()
  return new Map(
    (block ?? "").split("\n").flatMap((line) => {
      const match = /^([a-z-]+): (.+)$/.exec(line)
      return match?.[1] === undefined || match[2] === undefined ? [] : [[match[1], match[2]] as const]
    })
  )
}

describe("the agent packages", () => {
  it("the marketplace lists the plugin from a folder that holds it, under the same name", () => {
    const marketplace = decodeMarketplace(read(".claude-plugin/marketplace.json"))
    expect(marketplace.plugins.length).toBeGreaterThan(0)
    for (const entry of marketplace.plugins) {
      expect(entry.source.startsWith("./")).toBe(true)
      expect(decodePlugin(read(join(entry.source, ".claude-plugin", "plugin.json"))).name).toBe(entry.name)
    }
  })

  it("the plugin starts the published CLI's MCP server, and docs/agents.md gives every client the same command", () => {
    // The plugin pins the release it ships with (ReleasePins.test.ts checks which); the install lines take the latest.
    const server = decodeMcpJson(read("plugins/ot-gateway/.mcp.json")).mcpServers["ot-gateway"]
    expect(server?.command).toBe("npx")
    expect(server?.args.map((arg) => arg.replace(/^ot-gateway@.+$/, "ot-gateway"))).toEqual(serverArgs)
    const agents = read("docs/agents.md")
    expect(agents).toContain(`"args": ["-y", "ot-gateway", "mcp"]`)
    expect(agents).toContain("claude mcp add ot-gateway -- npx -y ot-gateway mcp")
    expect(agents).toContain("codex mcp add ot-gateway -- npx -y ot-gateway mcp")
    // The Cursor link carries the same server, base64-encoded as Cursor's install links take it.
    const config = /mcp\/install\?name=ot-gateway&config=([A-Za-z0-9+/=]+)/.exec(agents)?.[1] ?? ""
    expect(JSON.parse(Buffer.from(config, "base64").toString("utf8"))).toEqual({ command: "npx", args: serverArgs })
  })

  it("the plugin's skill holds no steps: it sends the agent to the server's guide, a tool the server has", () => {
    const skill = read("plugins/ot-gateway/skills/setup/SKILL.md")
    expect(skill).toContain("`setup_guide`")
    expect(mcpTools.map((tool) => tool.name)).toContain("setup_guide")
    expect(skill).toContain("npx -y ot-gateway guide setup")
    expect(skill.split("\n").length).toBeLessThan(25)
  })

  it.each([".claude/skills/setup", "plugins/ot-gateway/skills/setup"])("%s is an Agent Skill", (folder) => {
    const fields = frontmatterOf(read(join(folder, "SKILL.md")))
    const name = fields.get("name") ?? ""
    expect(name).toBe(folder.split("/").at(-1))
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(name.length).toBeLessThanOrEqual(64)
    const description = fields.get("description") ?? ""
    expect(description.length).toBeGreaterThan(0)
    expect(description.length).toBeLessThanOrEqual(1024)
  })

  it("AGENTS.md sends an agent to the guide and to the contributor guide", () => {
    const agents = read("AGENTS.md")
    expect(agents).toContain(".claude/skills/setup/SKILL.md")
    expect(agents).toContain("CLAUDE.md")
  })
})
