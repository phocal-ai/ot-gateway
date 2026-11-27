# AGENTS.md

For any coding agent in this repository.

- **Setting up a gateway for a user** (their devices, their broker): follow the setup guide, [`.claude/skills/setup/SKILL.md`](.claude/skills/setup/SKILL.md). It is an [Agent Skill](https://agentskills.io) and the one text every way of setting up reads: the `ot-gateway mcp` server serves it as its `setup` prompt and `setup_guide` tool, `ot-gateway guide setup` prints it, and the docs site has it at `/docs/setup-guide`. In a checkout, run the CLI as `pnpm -s ot-gateway`. How each agent gets it: [docs/agents.md](docs/agents.md).
- **Working on OT Gateway itself:** [CLAUDE.md](CLAUDE.md) is the contributor guide for every agent, whatever its name: the commands, the repo layout, the non-negotiable rules and the Effect conventions. Read it before changing code, then [docs/VISION.md](docs/VISION.md) for the why.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": true` in the root `turbo.json` or `turbo.jsonc` to opt in; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
