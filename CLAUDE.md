# CLAUDE.md

Guidance for AI coding assistants (and humans) working in this repo. Read [docs/VISION.md](docs/VISION.md) for the why; this file is the how.

## What Plenum is

An Effect-native edge gateway for buildings: Modbus TCP and BACnet/IP in, MQTT 5 out, safe commands back. It runs unattended on a Raspberry Pi, so reliability beats features.

## Commands

```bash
pnpm install
pnpm check            # format:check + lint, then turbo: typecheck + test in every package
pnpm format           # oxfmt --write .
pnpm lint             # oxlint, type-aware (lint:fix to autofix)
pnpm typecheck
pnpm test
pnpm gateway          # run apps/gateway with examples/gateway.json
pnpm --filter @plenum/core test   # one package
```

There is no build step. Node runs `.ts` files directly through type stripping (Node >= 22.18), and packages export `./src/index.ts`.

`tsc` is TypeScript 7 (the Go-native compiler), patched by `@effect/tsgo` on `pnpm install` (the root `prepare` script) so that `pnpm typecheck` also reports Effect language-service diagnostics. Their severities are set in `tsconfig.base.json`; the ones set to `error` fail the build. If typecheck stops reporting Effect diagnostics, run `pnpm exec effect-tsgo patch`.

Linting is oxlint (`.oxlintrc.json`, type-aware through `oxlint-tsgolint`) and formatting is oxfmt (`.oxfmtrc.json`: no semicolons, double quotes, 120 columns, no trailing commas). There is no ESLint or Prettier; don't add them. Both skip `repos/`, and oxlint needs `--disable-nested-config` so it does not load `repos/effect/.oxlintrc.json`.

## Repo layout

- `packages/core`: point model, `GatewayConfig` schema, `Driver` interface, `Publisher` service, normalization, topics, `runDevice` pipeline
- `packages/simulator`: simulated devices
- `packages/modbus`, `packages/mqtt`, `packages/bacnet`: in-house protocol stacks
- `apps/gateway`: the runnable gateway
- `examples/`: sample configs
- `docs/`: vision and design notes
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

| Ref    | Path            | Pinned to                                                                                    |
| ------ | --------------- | -------------------------------------------------------------------------------------------- |
| Effect | `repos/effect/` | tag `effect@4.1.2` of `https://github.com/Effect-TS/effect.git`, the version in our lockfile |

Keep the subtree on the same version as the installed `effect` package. After bumping it in the lockfile:

```bash
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@<version> --squash
```

**Before writing Effect code**, read the reference in this order:

1. `repos/effect/LLMS.md`: how to write Effect code (generators, `Effect.fn`, services and layers, errors, Schema).
2. `repos/effect/ai-docs/src/`: worked examples by topic (streams, observability, testing, SQL, HTTP, CLI).
3. `repos/effect/MIGRATION.md` and `repos/effect/migration/`: v3 → v4 guides; `migration/v3-to-v4.md` maps every import and API rename.
4. `repos/effect/packages/*/src`: the implementation, when the docs are not enough. `effect/socket` and `effect/sql` live under `packages/effect/src/`.

## Effect 4 conventions

- Services: `class X extends Context.Service<X, Shape>()("@plenum/pkg/X") {}`; provide them with `Layer.succeed` or `Layer.effect`.
- Errors: `class E extends Schema.TaggedError<E>()("E", { ...fields }) {}`; inside a generator, fail with `return yield* new E({...})`.
- Named, traced functions: `Effect.fn("name")(function*(...) { ... })`.
- Retries: `Effect.retry({ schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered), times: 4 })`.
- Tests: `@effect/vitest` with `it.effect`; control time with `TestClock` from `effect/testing`.
- Modules that used to live in `effect/unstable/*` in the betas are now top-level subpaths such as `effect/socket/Socket` and `effect/sql/SqlClient`. When unsure, check `repos/effect/` (above) rather than examples online, which are often Effect 3 and wrong for 4.
- `.claude/rules/effect.md` (loaded when you touch `packages/` or `apps/`) covers type evidence, tagged-error translation, `gen` vs `pipe`, v4 spellings and the v4 traps. `/review-effect` reviews a change against it.

## TypeScript style

- Strict mode, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (so no enums or namespaces; use `as const` objects).
- Relative imports use the `.ts` extension.
- Keep codecs pure and well tested against spec examples; cite the spec section in a comment.

## Before you finish a change

Run `pnpm check`. Add or update tests for new behaviour. Update `README.md` or `docs/` when behaviour or config changes.
