# OT Gateway plugin for Claude Code

The ot-gateway MCP server of the release the plugin comes with (`npx -y ot-gateway@<version> mcp`, moved by each release) and a `setup` skill that follows the setup guide the server ships with. It holds no steps of its own, so it never drifts from the CLI: the guide is `.claude/skills/setup/SKILL.md`, which the npm package carries.

```text
/plugin marketplace add phocal-ai/ot-gateway
/plugin install ot-gateway@ot-gateway
/ot-gateway:setup
```

Other agents: [Set it up with any agent](../../docs/agents.md).
