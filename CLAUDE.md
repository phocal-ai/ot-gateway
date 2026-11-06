# CLAUDE.md

Guidance for AI coding assistants (and humans) working in this repo. Read [docs/VISION.md](docs/VISION.md) for the why; this file is the how.

## What OT Gateway is

An Effect-native edge gateway for buildings: Modbus TCP and BACnet/IP in, MQTT 5 out, safe commands back. It runs unattended on a Raspberry Pi, so reliability beats features.

## Commands

```bash
pnpm install
pnpm check            # format:check + lint, then turbo: typecheck + test in every package
pnpm format           # oxfmt --write .
pnpm lint             # oxlint, type-aware (lint:fix to autofix)
pnpm typecheck
pnpm test
pnpm demo             # the gateway, a test broker and simulated devices in one process (status page on :8080)
pnpm gateway          # build the status page (cached), then run apps/gateway with examples/gateway.json (with pnpm bench)
pnpm ot-gateway init                       # questions in, ot-gateway.json out (the CLI: apps/gateway/src/Cli.ts)
pnpm ot-gateway check ot-gateway.json      # validate a config without connecting
pnpm ot-gateway discover ot-gateway.json   # find BACnet devices, print a draft of their config
pnpm ot-gateway import points.csv          # add a points list's devices to ot-gateway.json (examples/points.csv)
pnpm ot-gateway watch ot-gateway.json      # print what arrives at the config's broker
pnpm ot-gateway status                     # the running gateway's devices, one line each
pnpm --filter @ot-gateway/core test   # one package
pnpm --filter @ot-gateway/gateway sim   # the whole gateway on an in-memory network under virtual time (SIM_SEEDS, SIM_HOURS)
SOAK_SPEED=60 scripts/soak.sh 30m   # accelerated soak with broker, device and disk faults (see the script header)
scripts/interop.sh [mqtt|bacnet|modbus]   # against Mosquitto, EMQX, the BACnet Stack server and pymodbus (Docker, Python)
scripts/build-package.sh   # the ot-gateway npm package (the CLI bundled, with the status page) in dist/
```

Turborepo caches `typecheck` and `test` locally and in a remote cache on Vercel (team `wimluks-projects`; `pnpm exec turbo login` and `turbo link` once per machine, `TURBO_TOKEN` in CI). A cached task is replayed only when none of its declared inputs changed, so **a test that reads a file outside its package must list that file in the package's `turbo.json` inputs**, as `packages/core` does for `docs/configuration.md`. Otherwise a change to that file replays a stale pass. Before changing Turborepo config, read `AGENTS.md`: turbo keeps a block there that points at the docs bundled with the installed version.

There is no build step. Node runs `.ts` files directly through type stripping (Node >= 22.18), and packages export `./src/index.ts`.

`tsc` is TypeScript 7 (the Go-native compiler), patched by `@effect/tsgo` on `pnpm install` (the root `prepare` script) so that `pnpm typecheck` also reports Effect language-service diagnostics. Their severities are set in `tsconfig.base.json`; the ones set to `error` fail the build. If typecheck stops reporting Effect diagnostics, run `pnpm exec effect-tsgo patch`.

Linting is oxlint (`.oxlintrc.json`, type-aware through `oxlint-tsgolint`) and formatting is oxfmt (`.oxfmtrc.json`: no semicolons, double quotes, 120 columns, no trailing commas). There is no ESLint or Prettier; don't add them. Both skip `repos/`, and oxlint needs `--disable-nested-config` so it does not load `repos/effect/.oxlintrc.json`.

## Repo layout

- `packages/core`: point model, `GatewayConfig` schema, `Driver` interface, `Publisher` service, normalization, topics, `runDevice` pipeline
- `packages/simulator`: simulated devices
- `packages/modbus`, `packages/mqtt`, `packages/bacnet`: in-house protocol stacks
- `packages/buffer`: SQLite store-and-forward, a `Publisher` that wraps the MQTT one
- `packages/history`: SQLite history of every read (a day raw, `retentionDays` per minute) behind `/api/history`
- `packages/api`: the local HTTP API's contract (`HttpApi`), shared by the gateway and the status page
- `apps/gateway`: the runnable gateway
- `apps/web`: the status page, Next.js and shadcn/ui as a static export (`pnpm --filter @ot-gateway/web build`) that the gateway serves; no Next server at runtime
- `apps/site`: the project and docs site, Fumadocs as a static export hosted on Vercel. Its docs pages are generated from `docs/*.md` and the README at build time, so edit those, never `apps/site/content/`
- `examples/`: sample configs
- `packaging/`: `compose.yaml` (the recommended install), the systemd unit and `install.sh`; the container image is the root `Dockerfile`
- `docs/`: vision, the configuration reference (`configuration.md`, kept in step with the schema by `packages/core/test/ConfigDocs.test.ts`), operations and troubleshooting
- `observability/`: Grafana dashboards as code and the telemetry setup for the gateway and for Claude Code (see `observability/README.md`)
- `repos/`: read-only reference subtrees (see below)

## Branches

Work happens on `dev`: branch off it and open pull requests against it. `main` is for releases only and is updated by merging `dev` (see CONTRIBUTING.md). Never commit straight to `main`.

## Non-negotiable rules

1. **Effect-native.** Use Effect 4 (`effect` and `@effect/*`) for everything it offers: sockets (`effect/socket`), SQL (`@effect/sql-sqlite-node`), Schema, Schedule, CLI, HTTP, observability. Do not add non-Effect runtime dependencies. If one seems unavoidable, ask first and wrap it in a Layer.
2. **No third-party protocol libraries.** Modbus, BACnet/IP and MQTT are implemented here. Structure each one as pure encode/decode codecs plus one scoped transport.
3. **Typed errors.** Expected failures are `Schema.TaggedError` classes, handled with `catchTag` or `catchTags`. Never throw for expected failures, and never swallow errors silently.
4. **Resources in Scope.** Sockets and files are acquired with `Effect.acquireRelease` or scoped layers.
5. **Config through Schema.** Every config field is defined in `packages/core/src/Config.ts` or `Point.ts`, with defaults set by `withDecodingDefaultKey`. IDs are slugs, so they are always valid topic segments.
6. **Topics:** `site/building/device/point`, metadata on the retained `.../$meta` topic, health on `site/building/$gateway/<id>/health`.
7. **Writes are guarded.** Only points with `writable: true`, only through the command guard, always logged.
8. **Every driver has a simulator**, and tests run without hardware.
9. **Observable by default.** New behaviour that can fail or stall gets a metric in `packages/core/src/Telemetry.ts` (with a `unit` attribute when it is not a count) or a span, and the dashboard script is updated. Telemetry config is the standard `OTEL_*` env vars only.

## Reference repos

External sources live under `repos/` as squashed git subtrees, so they are always available without extra clones. They are read-only: never edit them and never import from `repos/` in our code.

| Ref            | Path                          | Pinned to                                                                                    |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| Effect         | `repos/effect/`               | tag `effect@4.1.2` of `https://github.com/Effect-TS/effect.git`, the version in our lockfile |
| Security audit | `repos/security-audit-skill/` | commit `c1c8a8c14710` of `https://github.com/cloudflare/security-audit-skill.git` (MIT)      |

Keep the subtree on the same version as the installed `effect` package. After bumping it in the lockfile:

```bash
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@<version> --squash
```

`repos/security-audit-skill/` is the workflow behind `/security-audit` (`.claude/skills/security-audit/SKILL.md`, which adds this repo's rules: findings stay out of the public repo, source-only, an agent budget). Update it after reading the upstream diff:

```bash
git subtree pull --prefix=repos/security-audit-skill https://github.com/cloudflare/security-audit-skill.git main --squash
```

**Before writing Effect code**, read the reference in this order:

1. `repos/effect/LLMS.md`: how to write Effect code (generators, `Effect.fn`, services and layers, errors, Schema).
2. `repos/effect/ai-docs/src/`: worked examples by topic (streams, observability, testing, SQL, HTTP, CLI).
3. `repos/effect/MIGRATION.md` and `repos/effect/migration/`: v3 → v4 guides; `migration/v3-to-v4.md` maps every import and API rename.
4. `repos/effect/packages/*/src`: the implementation, when the docs are not enough. `effect/socket` and `effect/sql` live under `packages/effect/src/`.

## Effect 4 conventions

- Services: `class X extends Context.Service<X, Shape>()("@ot-gateway/pkg/X") {}`; provide them with `Layer.succeed` or `Layer.effect`.
- Errors: `class E extends Schema.TaggedError<E>()("E", { ...fields }) {}`; inside a generator, fail with `return yield* new E({...})`.
- Named, traced functions: `Effect.fn("name")(function*(...) { ... })`.
- Retries: `Effect.retry({ schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered), times: 4 })`.
- Tests: `@effect/vitest` with `it.effect`; control time with `TestClock` from `effect/testing`.
- Modules that used to live in `effect/unstable/*` in the betas are now top-level subpaths such as `effect/socket/Socket` and `effect/sql/SqlClient`. When unsure, check `repos/effect/` (above) rather than examples online, which are often Effect 3 and wrong for 4.
- `.claude/rules/effect.md` (loaded when you touch `packages/` or `apps/`) covers type evidence, tagged-error translation, `gen` vs `pipe`, v4 spellings and the v4 traps. `/review-effect` reviews a change against it. `.claude/rules/edge.md` is the Raspberry Pi checklist: monotonic time, deadlines, misbehaving peers, isolation, storage faults and log budget.

## TypeScript style

- Strict mode, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (so no enums or namespaces; use `as const` objects).
- Relative imports use the `.ts` extension.
- Keep codecs pure and well tested against spec examples; cite the spec section in a comment.

## Before you finish a change

Run `pnpm check`. Add or update tests for new behaviour. Update `README.md` or `docs/` when behaviour or config changes.

Project hooks in `.claude/settings.json` back this up:

- After every Write or Edit, oxfmt formats the file and oxlint's findings for it come back to you. Fix them while the file is still in view.
- At the end of a turn with uncommitted changes, `pnpm check` runs and blocks the stop if it fails.
- `npm` and `yarn` commands are denied; use pnpm.

## Quickstart

`/setup` (`.claude/skills/setup/SKILL.md`) takes a user from a fresh checkout to a running gateway: it writes `ot-gateway.json` (git-ignored, with secrets in `ot-gateway.env`). The README's "Set it up with AI" prompt points other agents at the same file, so keep the skill agent-neutral, and update it when config or commands change.

## Health and budget

`/health` checks the gateway, Claude Code sessions in this repo and the Grafana Cloud free-plan quotas through the Grafana MCP. The stack is on the free plan: before adding telemetry, dashboards, CI or scheduled agents, estimate what they add (see "Free-plan budget" in `observability/README.md`). If the projection gets close to a quota, optimize first. The `Health` workflow (`.github/workflows/health.yml`, prompt in `.github/prompts/health.md`) runs the budget and gateway checks daily and tracks findings as `health` issues. Everything it writes is public.
