---
name: improve
description: Audit OT Gateway and write self-contained implementation plans for cheaper models to execute, with shadcn's improve workflow (vendored, pinned). Use for "/improve", "/improve quick|deep|branch|next|security|perf|tests", "/improve plan <description>", "/improve review-plan <file>", "/improve execute <plan>", "/improve reconcile", "audit the codebase", "find improvements", "what should we build next", "write a plan for another agent". Read-only on source; plans stay local.
---

The workflow is shadcn's [improve](https://github.com/shadcn/improve), vendored as a read-only subtree in `repos/improve-skill/` (see CLAUDE.md, "Reference repos"). Read `repos/improve-skill/skills/improve/SKILL.md` in full and follow it. Its **skill directory** is that file's absolute directory: `references/audit-playbook.md`, `references/plan-template.md` and `references/closing-the-loop.md` live there, and subagent prompts get their absolute paths. Never edit the vendored files.

What follows is specific to OT Gateway and wins where it is stricter than the workflow.

## Plans stay local

The repository is public. Plans go in `plans/` at the repo root, which `.gitignore` keeps out of git: never commit, push or paste a plan into a PR. For `execute`, the executor's worktree does not contain `plans/`, so the dispatch prompt carries the plan's full text (or its absolute path in this checkout).

`--issues` publishes to public GitHub issues. Only with the explicit flag, never for a security or availability finding, and confirm the list with the user first. Security findings follow `/security-audit`'s disclosure rules (`.claude/skills/security-audit/SKILL.md`, "Disclosure"): they go to the user in chat; a plan for one says what to change, not how to exploit it. For a real security review, point the user at `/security-audit`.

## Recon facts

Give these to every subagent so they do not re-discover them:

- Read `CLAUDE.md`, `docs/VISION.md`, `.claude/rules/effect.md` and `.claude/rules/edge.md` (the Raspberry Pi checklist). The verification gate is `pnpm check`; one package is `pnpm --filter <pkg> test`.
- Skip `repos/` (read-only reference subtrees), `node_modules/`, `apps/site/content/` (generated from `docs/`) and build output.
- **Decided, not findings:** the non-negotiable rules in CLAUDE.md. In-house Modbus, BACnet/IP and MQTT stacks instead of libraries; Effect 4 for everything, no non-Effect runtime dependencies; no ESLint or Prettier (oxlint, oxfmt); no build step (Node type stripping) with an esbuild bundle for what ships; soak and simulation runs nightly, not on PRs; public copy names no brands or customers.
- **Risk hints:** untrusted bytes from devices and the LAN in the codecs and transports; guarded writes to field devices (rule 7); unattended runs on small hardware (memory, SD-card storage, clock jumps); telemetry on the Grafana Cloud free plan, so a plan that adds metrics, dashboards or CI estimates its cost (see "Free-plan budget" in `observability/README.md`).

## Execute

- The executor is a cheaper model (`model: "sonnet"`) in an isolated worktree branched off `dev`. Its plan must follow CLAUDE.md, including tests for new behaviour, docs for changed behaviour, and a metric or span for new failure modes (rule 9).
- The review re-runs `pnpm check` in the worktree. Never merge, push or open a PR; the user decides, and `main` is for releases only.

## Budget

The stack runs on a Claude subscription with a weekly usage limit. Without other instructions, propose `quick` or a focused audit before `standard`, and say how many subagents the run will start. `deep` runs only when the user asks for it.
