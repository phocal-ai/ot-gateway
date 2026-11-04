---
name: review-effect
description: Critical review of recent Effect code for Effect 4-native patterns (services, layers, typed errors, resources), checked against the vendored repos/effect source. Use for "review the Effect code", "Effect review".
disable-model-invocation: true
---

Review the recent work in this conversation (or the diff against `dev` if there is none) and give an honest, critical assessment as a senior engineer, focused on **Effect-native design**.

Effect's source is vendored read-only under `repos/effect/` at the version in our lockfile (`effect@4.1.2`; see CLAUDE.md, "Reference repos"). Check the code against it, not against memory or online examples, which are often Effect 3:

- **v4 spellings only.** `Context.Service` classes wired by an explicit `Layer.effect`; `Context.Reference` for defaulted values; `Result` / `Effect.result`; `Schema.decodeUnknownEffect`, `Schema.Literals`, `Schema.optionalKey`. `repos/effect/migration/v3-to-v4.md` maps every rename.
- **Services and layers.** Idiomatic construction; `Effect.fn("Name")` for named, traced functions.
- **Error channel.** Expected failures are `Schema.TaggedError`s in `E`, never thrown, translated by tag with `catchTag` / `catchTags`, not by branching on `_tag` in `Effect.catch` / `catchCause`. Nothing swallowed silently.
- **The v4 traps** in `.claude/rules/effect.md`: empty env strings, `Queue.takeAll` in a shutdown path, a per-device layer without `Layer.fresh`, a static `_tag` read, a test reading `exit.cause.error`, `Schema.NumberFromString` on a wire value.
- **Resources.** Sockets and files acquired with `acquireRelease` or a scoped layer; release runs on every exit path, including interruption mid-reconnect.
- **OT Gateway's rules (CLAUDE.md).** Codecs stay pure; one scoped transport per protocol; config fields only in `Config.ts` / `Point.ts`; writes only through the command guard and always logged; every driver has a simulator-backed test.
- **The Raspberry Pi checklist** in `.claude/rules/edge.md`: monotonic time, deadlines on every wait, misbehaving peers, retries that multiply across layers, per-device isolation, poison messages, SQLite on a full or locked SD card, and logging transitions instead of states.
- **No raw Promises** mixed into Effect code, and no non-Effect runtime dependency.
- Right combinator for the job; `Effect.gen` where it reads clearer.

Run `pnpm typecheck` first: the Effect language service (`@effect/tsgo`) already reports many of these, and anything it flags is a finding.

When docs are not enough, search the implementation: start with `repos/effect/LLMS.md` and `repos/effect/ai-docs/src/`, then `repos/effect/packages/effect/src/` (`effect/socket` and `effect/sql` live there).

**Output: blocking problems only.**

- List only problems you would block the merge for. For each: `file:line`, why it is wrong, and how to show it fails (an input, a test, or a command).
- Check each finding against the code before listing it; drop anything you cannot point at. Mark anything you could not confirm and say where you looked.
- Non-blocking suggestions go in one short trailing list of at most five items. If nothing blocks, say so in one line.
