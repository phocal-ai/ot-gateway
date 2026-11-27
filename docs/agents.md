# Set it up with any agent

OT Gateway is set up and debugged with an AI agent, and it does not care which one. Everything an agent needs ships with the `ot-gateway` command itself, so any agent gets the same steps and the same safety rules, at the version you run:

- **The MCP server**, `ot-gateway mcp`: every command as a tool, and the setup guide as the `setup` prompt and the `setup_guide` tool ([As MCP tools](headless.md#as-mcp-tools)). Claude, Cursor, VS Code, Codex, Gemini CLI and most other agents speak MCP.
- **The setup guide**: the steps from nothing to values on your broker. It is one text, and every way below reads it: the MCP server serves it, `ot-gateway guide setup` prints it, the docs site has it as the [Setup guide](../.claude/skills/setup/SKILL.md) (and as Markdown at `https://ot-gateway.vercel.app/docs/setup-guide.md`), and it is an [Agent Skill](https://agentskills.io) in the repository.

The packages for each agent below are a few lines each that point at those two. Nothing in them holds steps of its own, so a copied prompt or an old plugin does not go stale.

## The prompt

Install the MCP server for your agent (below), then say what you want and what you know about the site:

```text
Set up OT Gateway for my site with the ot-gateway MCP server: follow its setup guide.
My devices: BACnet/IP on this network. Broker: mqtts://broker.example:8883, user gateway.
```

Without the MCP server, any agent that can run commands and read the web does the same from the guide's address:

```text
Set up OT Gateway for my site: follow https://ot-gateway.vercel.app/docs/setup-guide.md
My devices: BACnet/IP on this network. Broker: mqtts://broker.example:8883, user gateway.
```

Put what you know on the second line (the devices and how they are reached, the broker, the site and building names, a points list or EDE file and where it is, "on my Mac"): the guide asks only for what is missing. It discovers BACnet devices by broadcast and asks which ones you want, never makes a point writable unless you name it with its limits, and keeps the broker password out of the config and out of the chat (you type it into `ot-gateway secret set broker-password` yourself).

## Install for your agent

Each of these starts the same server, `npx -y ot-gateway mcp` (Node.js 22.18 or newer). With `ot-gateway` installed globally (`npm i -g ot-gateway` or `pnpm add -g ot-gateway`), use `ot-gateway mcp` instead: it starts faster and works without the network.

### Claude Code

The plugin brings the MCP server and a `setup` skill that reads the server's guide:

```text
/plugin marketplace add phocal-ai/ot-gateway
/plugin install ot-gateway@ot-gateway
```

Then `/ot-gateway:setup`, or the prompt above. Without the plugin, the server alone:

```bash
claude mcp add ot-gateway -- npx -y ot-gateway mcp
```

### Cursor

[Add the ot-gateway MCP server to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=ot-gateway&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm90LWdhdGV3YXkiLCJtY3AiXX0=) (a link that opens Cursor; GitHub does not show it as one), or add it to `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "ot-gateway": { "command": "npx", "args": ["-y", "ot-gateway", "mcp"] }
  }
}
```

### VS Code

```bash
code --add-mcp '{"name":"ot-gateway","type":"stdio","command":"npx","args":["-y","ot-gateway","mcp"]}'
```

Or in `.vscode/mcp.json`:

```json
{
  "servers": {
    "ot-gateway": { "type": "stdio", "command": "npx", "args": ["-y", "ot-gateway", "mcp"] }
  }
}
```

### Codex, Gemini CLI and others

```bash
codex mcp add ot-gateway -- npx -y ot-gateway mcp
gemini mcp add ot-gateway npx -y ot-gateway mcp
```

Any other client takes the command `npx` with the arguments `-y ot-gateway mcp`, usually under `mcpServers` in its JSON settings. A client that offers MCP prompts shows the guide as `setup`; in one that does not, ask for the `setup_guide` tool.

### As a skill

The guide is also an [Agent Skill](https://agentskills.io) (`.claude/skills/setup/SKILL.md`), the open format that Claude, Codex, Cursor and others load from a skills folder. The [skills CLI](https://github.com/vercel-labs/skills) copies it into your agent's:

```bash
npx skills add phocal-ai/ot-gateway --skill setup
```

A copied skill stays at the version you copied. The MCP server's guide always matches the `ot-gateway` it runs, so prefer the server when your agent has MCP.

## Where the agent works

The MCP server runs in whatever folder your agent starts it in, and finds `ot-gateway.json` there as the CLI does. The guide it serves tells the agent to give `init` the gateway's folder and every tool after it that folder's config as an absolute path, so it works from any folder.

On a Raspberry Pi or another Linux box without Node.js, the guide uses the Docker wrapper instead of `npx` ([The CLI](../.claude/skills/setup/SKILL.md)). Run the agent on that machine, or over SSH from it, so it reaches the devices on the building network.

## For your agent's instructions

So an agent reaches for the CLI on its own in later sessions, add one line to its instructions (`AGENTS.md`, `CLAUDE.md`, Cursor rules):

```text
For OT Gateway configs, points lists and folders, use `npx ot-gateway` (or its MCP server, `ot-gateway mcp`); start with `npx ot-gateway --help`.
```
