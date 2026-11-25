# Review instructions

OT Gateway runs unattended for months on a Raspberry Pi next to building and plant equipment. Review against that, not against a laptop. The full rules are in `CLAUDE.md`, `.claude/rules/effect.md` and `.claude/rules/edge.md`; this file says what matters most in a review and how loud to be.

## What Important means here

- A value published wrong, late without saying so, or lost: a wrong scale, byte order, unit or topic; a NaN or Infinity published; a row lost or resent between "sent" and "marked sent".
- A write to a device that skips the command guard, a point without `writable: true`, or a write that is not logged.
- A config editor path that skips the edit guard (`apps/gateway/src/EditGuard.ts`) or shows a secret.
- A failure that stalls without a deadline, a retry that multiplies across layers, or one device or one message that can block the others.
- A resource (socket, file, SQLite handle) not released on every exit path, including interruption.
- A thrown or swallowed expected failure instead of a `Schema.TaggedError` handled by tag.
- A non-Effect runtime dependency, or a third-party Modbus, BACnet or MQTT library.
- Anything that blocks a rollback: a config field that an older release would reject, or a migration of the buffer or history database with no way back.
- A controller or router brand, an employer or a customer named in public copy (README, docs, the site, the status page, log messages).

Style is Nit at most. Formatting and lint are enforced by `pnpm check`; don't comment on them.

## Always check

- Timers, timeouts and "heard from within N" use monotonic time (`monotonicMillis` or `Clock.monotonicTimeNanos`), never wall time.
- Every length read off the wire is bounded before it is allocated.
- Codecs stay pure, cite the spec section and have tests from spec examples or captured traffic. A new driver path has a simulator-backed test.
- A new config field lives in `packages/core/src/Config.ts` or `Point.ts`, has a default via `withDecodingDefaultKey`, and is documented in `docs/configuration.md`.
- A test that reads a file outside its package lists it in that package's `turbo.json` inputs.
- New behaviour that can fail or stall has a metric in `packages/core/src/Telemetry.ts` (with a `unit` when it is not a count) or a span, and the dashboard script is updated.
- Logs record transitions (failing, recovered), not states, at the coarsest level that is true.
- A behaviour or config change updates `README.md` or `docs/`, and `.claude/skills/setup/SKILL.md` when a command or config changes.

## Keep it quiet

- At most five Nits.
- Skip `pnpm-lock.yaml`, `repos/`, `apps/site/content/` (generated from `docs/`) and `apps/gateway/src/main.mjs` (a bundle).
- A claim about behaviour names a file and line.
- A pull request against `main` that is not a release or a hotfix is Important; one against `dev` is normal.
