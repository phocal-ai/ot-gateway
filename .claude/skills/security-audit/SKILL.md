---
name: security-audit
description: Security audit of OT Gateway with Cloudflare's security-audit workflow (vendored, pinned). Use for "/security-audit", "security audit", "find vulnerabilities", "pen-test the code", a full or scoped security review, or a security question about the gateway. Runs source-only; findings stay outside the repository.
---

The workflow is Cloudflare's [security-audit-skill](https://github.com/cloudflare/security-audit-skill), vendored as a read-only subtree in `repos/security-audit-skill/` (see CLAUDE.md, "Reference repos"). Read `repos/security-audit-skill/skills/security-audit/SKILL.md` in full and follow it. Its **skill directory** is that file's absolute directory: its companion files, `report-schema.json` and the two validators (`node <skill dir>/validate-coverage-ledger.cjs`, `node <skill dir>/validate-findings.cjs`) live there. Never edit the vendored files.

What follows is specific to OT Gateway and wins where it is stricter than the workflow.

## Disclosure

The repository is public, and so is everything the `Health` workflow writes. Until the user decides otherwise:

- The output directory is outside the repository: `~/security-audit-skill/ot-gateway/run-<N>`. Never write audit files into the checkout.
- Findings go to the user in chat and in the output directory only: never into an issue, a PR description, a commit message, a code comment, a Grafana annotation or any other public place.
- A fix lands as an ordinary PR whose description says what changes, not how to exploit what it fixes.

## Execution

- No OS-enforced sandbox is set up here, so the run is **source-only**: never build, test or run the target for a finding. Leads that need execution stay `needs_validation`, with the exact fact that is missing.
- Never connect to the Raspberry Pi (`ot-gateway`), a broker, Grafana or any field device, and never write to a device. The deployed gateway is out of scope; the source is the target.

## Budget

The stack runs on a Claude subscription with a weekly usage limit (it was hit on 2026-11-03), so every run has an agent budget in `run-metadata.json`. Without other instructions, propose the `quick` profile with a budget of 25 agent invocations, and say what that leaves uncovered. Count every reconnaissance agent, hunter, critic and verifier.

## Where to look first

Use these as reconnaissance input, not as a limit on coverage:

- **Field writes:** MQTT commands → the command guard → Modbus and BACnet writes (`packages/core`, `apps/gateway/src/Commands.ts`). CLAUDE.md rule 7 says writes are guarded: only `writable: true` points, only within `limits`, always logged.
- **Untrusted bytes:** the Modbus, BACnet/IP and MQTT 5 codecs and transports (`packages/modbus`, `packages/bacnet`, `packages/mqtt`). `.claude/rules/edge.md`, "Peers that misbehave", lists what devices and LANs really send.
- **Local surfaces:** the HTTP API and status page (`packages/api`, `apps/gateway/src/Status.ts`, `apps/web`), bound to 127.0.0.1 by default; the SQLite outbox (`packages/buffer`); config and env handling (`packages/core/src/Config.ts`, `apps/gateway/src/main.ts`).
- **Deployment and supply chain:** `Dockerfile`, `packaging/` (compose, systemd unit, `install.sh`), `.github/workflows/` (including `health.yml`, where an agent reads Grafana and GitHub and writes public issues; see the workflow's `AI-AND-LLM.md`).

Companion files that usually apply: `PROTOCOLS-RPC-AND-MESSAGING.md`, `RESOURCE-EXHAUSTION-AND-AVAILABILITY.md`, `SUPPLY-CHAIN-AND-RELEASE.md`, `CLOUD-AND-DEPLOYMENT.md`, `WEB-PROTOCOL-AND-AUTH.md` and `AI-AND-LLM.md`.
