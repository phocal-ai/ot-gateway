# CLAUDE.md

Guidance for AI coding assistants (and humans) working in this repo. Read [docs/VISION.md](docs/VISION.md) for the why; this file is the how.

## What OT Gateway is

An Effect-native OT gateway for buildings and industrial sites: Modbus TCP and BACnet/IP in, standard MQTT out, safe commands back. It runs unattended in Docker on small hardware (a Raspberry Pi, an industrial PC), set up and debugged with an AI agent, so reliability and a clear experience for people and agents beat features. Public copy names no controller or router brands and no customer.

## Commands

```bash
pnpm install
pnpm check            # format:check, then turbo: lint, and typecheck + test in every package, side by side
pnpm format           # oxfmt --write .
pnpm lint             # oxlint, type-aware (lint:fix to autofix)
pnpm typecheck
pnpm test
pnpm demo             # the gateway, a test broker and simulated devices in one process (status page on :8080)
pnpm gateway          # build the status page (cached), then run apps/gateway with examples/gateway.json (with pnpm bench)
pnpm ot-gateway init .                     # questions in (init <folder> makes a folder, as create-next-app does), ot-gateway.json, ot-gateway.env and, on Linux, compose.yaml out (the CLI: apps/gateway/src/Cli.ts)
pnpm ot-gateway init . --yes --site s --broker mqtt://host:1883 --points points.csv   # the same without questions
pnpm ot-gateway check ot-gateway.json      # validate a config without connecting
pnpm ot-gateway doctor ot-gateway.json     # every check in order (config, broker, gateway, devices, BACnet port, disk, clock), one line each and the next command (--json: findings with code, hint, next; exit 1 when one fails)
pnpm ot-gateway up                         # the folder's gateway under Docker Compose (compose.yaml written when missing), until every point has a value (down, restart; exit 1 with code, hint, next)
pnpm ot-gateway upgrade --check            # is a newer release out (upgrade: pull, check the config with it, switch compose.yaml's tag, wait for values, roll back when they do not come)
pnpm ot-gateway start                      # the folder's gateway in the background on this machine (macOS: Docker Desktop reaches no LAN device), until every point has a value; stop stops it (.ot-gateway.pid; apps/gateway/src/Background.ts)
pnpm ot-gateway discover ot-gateway.json   # find devices; in a terminal choose BACnet/IP or a Modbus scan, pick points, see the diff, save into the config, then the commands to read once or start, otherwise (--json, a pipe, no config yet) print an overview (found) and a draft; --save all|<ids> saves without asking (--points-list points.csv writes a list to trim, --append adds to one)
pnpm ot-gateway discover modbus 192.168.1.0/24   # find Modbus TCP devices and unit ids on a range, read-only and rate-limited (--unit-ids 1-247 behind a gateway, --points-list writes draft rows)
pnpm ot-gateway import points.csv          # add a points list's devices to ot-gateway.json (examples/points.csv)
pnpm ot-gateway points schema              # the points list's columns (--json; --brief --json in short); points template prints a list to fill in (--protocol modbus|bacnet: only that protocol's columns)
pnpm ot-gateway points from-ede examples/building.ede.csv   # a BACnet EDE file as a points list (import reads EDE directly too)
pnpm ot-gateway points export > points.csv   # the config's devices as a points list again, for import (--format json; what a list cannot carry is named on stderr)
pnpm ot-gateway points allow-commands heat-pump/setpoint --min=15 --max=25   # one point takes commands on its $set topic: writable and limits into the config, checked first (points read-only undoes it; --dry-run, --json; apps/gateway/src/PointCommands.ts)
pnpm ot-gateway config set devices.heat-pump.pollIntervalMs 10000   # one key of the config by its path, devices and points by id, checked before it is written (config get|unset, config remove <device[/point]>, config undo: the .bak back; --dry-run, --json; never makes a point writable; apps/gateway/src/ConfigEdit.ts)
pnpm ot-gateway secret set broker-password   # the broker password into ot-gateway.env: asked without echo, or read from stdin, never an argument and never printed (secret set edit-token --generate; secret list: which are set, by name; apps/gateway/src/Secret.ts)
pnpm ot-gateway diff                       # what ./ot-gateway.json changes on the broker against the running gateway: topics new, silent, moved, writable, stale $meta (--against <old.json>, --json)
pnpm ot-gateway contract                   # the MQTT contract: topics and each message's fields (--json: the JSON Schemas; contract value --json: one)
pnpm ot-gateway watch ot-gateway.json      # print what arrives at the config's broker (--check: only what is off the contract)
pnpm ot-gateway broker ot-gateway.json     # the broker's MQTT version and limits, and a round trip
pnpm ot-gateway read                       # every point of ./ot-gateway.json read once, without a running gateway or broker (read <device>[/<point>], --json, --publish also sends them to the broker once; exit 1 when one fails)
pnpm ot-gateway probe 127.0.0.1:5020 100   # read Modbus registers once (read-only): every type and byte order they read as, a points list row
pnpm ot-gateway simulate bacnet            # a simulated BACnet/IP device on the LAN (a room: temperature, writable setpoint, heating) to try from another machine (docs/try-bacnet.md)
pnpm ot-gateway publish <topic> [payload]  # one message (--retain with no payload clears a retained topic)
pnpm ot-gateway write <device/point> <value>   # a guarded command on the point's $set topic and its result (exit 1 with code and hint when not written)
pnpm ot-gateway gateways list --broker mqtt://host:1883   # every gateway the broker keeps health of, from any machine (gateways status|points <site/building/id>; no config needed)
pnpm ot-gateway status                     # the running gateway of ./ot-gateway.json (or a config named): its devices, one line each, what to check (exit 1 when one fails)
pnpm ot-gateway events --since 1h          # what broke, since when and why, and when it came back (/api/events; --follow for what comes)
pnpm ot-gateway history meter/power        # a point's last 10 minutes from the gateway's history: min, max, average per minute, gaps (on/off and switch times for a bool)
pnpm ot-gateway messages                   # messages per topic since the gateway started, and how many reached the broker
pnpm ot-gateway logs --level warn          # the running gateway's recent log lines from memory, without docker logs (/api/logs; --follow, --json)
pnpm ot-gateway explain broker-unreachable # what a code means, what to do, the next command (no code: all of them; --json; the table is apps/gateway/src/Codes.ts, docs/troubleshooting.md's "Codes" is checked against it)
pnpm ot-gateway support                    # one redacted file for an issue report: versions, host, config, status, a day of events, the logs (--output -, --json)
pnpm ot-gateway mcp                        # the commands as MCP tools over stdio, each result the command's --json (the tools: apps/gateway/src/McpTools.ts)
OT_GATEWAY_JSON=1 pnpm ot-gateway status    # --json on every command that takes it; a terminal gets the short view, a pipe the full text, --all expands (docs/operations.md, "People and agents")
pnpm --filter @ot-gateway/core test   # one package
pnpm --filter @ot-gateway/gateway sim   # the whole gateway on an in-memory network under virtual time (SIM_SEEDS, SIM_HOURS)
SOAK_SPEED=60 scripts/soak.sh 30m   # accelerated soak with broker, device and disk faults (see the script header)
scripts/interop.sh [mqtt|bacnet|modbus]   # against Mosquitto, EMQX, the BACnet Stack server and pymodbus (Docker, Python)
scripts/build-package.sh   # the ot-gateway npm package (the CLI bundled, with the status page) in dist/
```

Turborepo caches `lint` (one task for the whole repository; any change but Markdown reruns it), `typecheck` and `test` locally and in a remote cache on Vercel (team `wimluks-projects`; `pnpm exec turbo login` and `turbo link` once per machine, `TURBO_TOKEN` in CI). A cached task is replayed only when none of its declared inputs changed, so **a test that reads a file outside its package must list that file in the package's `turbo.json` inputs**, as `packages/core` does for `docs/configuration.md`. Otherwise a change to that file replays a stale pass. Tests do not wait for a typecheck; the `sources` task (no script) only carries a change in a package to the tests of the packages that depend on it. Before changing Turborepo config, read `AGENTS.md`: turbo keeps a block there that points at the docs bundled with the installed version.

There is no build step. Node runs `.ts` files directly through type stripping (Node >= 22.18), and packages export `./src/index.ts`. What ships is a bundle: the npm package and the container image's entrypoint run `apps/gateway/src/main.mjs`, built by `scripts/bundle.sh` (esbuild), because one file starts about three times faster on a Pi and a running gateway keeps a third less heap. Code that finds a file through `import.meta.url` must work from that bundle too (the image smoke test checks the profiles and the version).

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
7. **Writes are guarded.** Only points with `writable: true`, only through the command guard, always logged. The status page's config editor writes only through the edit guard (`apps/gateway/src/EditGuard.ts`: same origin, the `X-OT-Gateway` header, loopback or `OT_GATEWAY_EDIT_TOKEN`) and never sees a secret.
8. **Every driver has a simulator**, and tests run without hardware.
9. **Observable by default.** New behaviour that can fail or stall gets a metric in `packages/core/src/Telemetry.ts` (with a `unit` attribute when it is not a count) or a span, and the dashboard script is updated. Telemetry config is the standard `OTEL_*` env vars only.

## Reference repos

External sources live under `repos/` as squashed git subtrees, so they are always available without extra clones. They are read-only: never edit them and never import from `repos/` in our code.

| Ref            | Path                          | Pinned to                                                                                    |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| Effect         | `repos/effect/`               | tag `effect@4.1.2` of `https://github.com/Effect-TS/effect.git`, the version in our lockfile |
| Security audit | `repos/security-audit-skill/` | commit `c1c8a8c14710` of `https://github.com/cloudflare/security-audit-skill.git` (MIT)      |
| Improve        | `repos/improve-skill/`        | commit `cac56e1ebd3c` of `https://github.com/shadcn/improve.git` (MIT)                       |

Keep the subtree on the same version as the installed `effect` package. After bumping it in the lockfile:

```bash
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@<version> --squash
```

`repos/security-audit-skill/` is the workflow behind `/security-audit` (`.claude/skills/security-audit/SKILL.md`, which adds this repo's rules: findings stay out of the public repo, source-only, an agent budget). Update it after reading the upstream diff:

```bash
git subtree pull --prefix=repos/security-audit-skill https://github.com/cloudflare/security-audit-skill.git main --squash
```

`repos/improve-skill/` is the workflow behind `/improve` (`.claude/skills/improve/SKILL.md`, which adds this repo's rules: plans stay in the git-ignored `plans/`, decided trade-offs, a cheaper executor that never merges). It audits and writes plans; it never edits source itself. Update it after reading the upstream diff:

```bash
git subtree pull --prefix=repos/improve-skill https://github.com/shadcn/improve.git main --squash
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
- Tests: `@effect/vitest` with `it.effect`; control time with `TestClock` from `effect/testing`. Vitest runs files side by side and the tests of one file in turn, so a slow suite is split over files (the simulation: one seed per file). Each file gets a fresh process, which the metrics registry and the simulation's reproducible seeds rely on; only `apps/web`, pure functions over data, shares workers (`--no-isolate`).
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
- `npm` and `yarn` commands are denied (`permissions.deny`, not a hook: a `PreToolUse` hook on Bash stops `/ship` and `/steward` from watching a pull request); use pnpm.

## Pull requests

- `/code-review` before pushing. `REVIEW.md` holds the review rules for Code Review and PR Steward; local `/code-review` reads only this file, so keep the two in step.
- `/steward` watches an open pull request (failing checks, conflicts, review comments) until it is merged or closed. `.claude/skills/steward/SKILL.md` says how pull requests here are kept. `/ship` does not commit in a public repository, so commit and open the pull request yourself, then run `/steward` from a separate worktree.
- `.claude/skills/verify/SKILL.md` runs the demo and checks a change end to end.
- A pattern becomes a rule in one of these files after it shows up on two pull requests, committed by hand.

## Quickstart

`/setup` (`.claude/skills/setup/SKILL.md`) takes a user from nothing to a running gateway through the CLI (`npx ot-gateway`, or `pnpm ot-gateway` in a checkout): `init` writes the folder, everything else becomes the standard points list, Docker Compose runs it. The README's "Set it up with AI" prompt points other agents at the same file, so keep the skill agent-neutral, and update it when config or commands change.

## Health and budget

`/health` checks the gateway, Claude Code sessions in this repo and the Grafana Cloud free-plan quotas through the Grafana MCP. The stack is on the free plan: before adding telemetry, dashboards, CI or scheduled agents, estimate what they add (see "Free-plan budget" in `observability/README.md`). If the projection gets close to a quota, optimize first. The `Health` workflow (`.github/workflows/health.yml`, prompt in `.github/prompts/health.md`) runs the budget and gateway checks daily and tracks findings as `health` issues. Everything it writes is public.
