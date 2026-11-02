---
description: Type evidence, tagged-error translation, Effect.gen vs pipe, and Effect 4 spellings and traps
paths:
  - "packages/**/*.ts"
  - "apps/**/*.ts"
---

Plenum is on Effect 4 (`effect@4.1.2`). The source of truth is `repos/effect/` (see CLAUDE.md, "Reference repos"); v3 → v4 renames are in `repos/effect/migration/v3-to-v4.md`. This adds detail to CLAUDE.md's "Effect 4 conventions"; it does not repeat them. Apply it to new and changed code, and fix a violation in existing code when you are already editing that function.

`pnpm typecheck` runs the Effect language service (`@effect/tsgo`, configured in `tsconfig.base.json`), so many of these rules fail the build. The rest are on you and on `/review-effect`.

## Types are evidence

A type records where a value came from and what has been checked about it. Keep the strongest type you have.

**Parse once, at the boundary.** Untrusted input is decoded from `unknown` by the adapter that owns that boundary, with `Schema.decodeUnknownEffect` (`decodeUnknownSync` / `decodeUnknownExit` outside an Effect). In Plenum the boundaries are: the gateway config file, env, MQTT payloads (including commands), Modbus and BACnet frames off the wire, and SQLite rows. Everything inward receives the parsed type and does not re-check it. Binary codecs are the exception to "use Schema": they decode bytes by hand, but they still return a typed value or a tagged error, never `unknown`.

- **Never widen a known value** to `unknown`, `object` or `Record<string, unknown>` because a broad type is easier to implement against.
- **Never erase a type and assert it back** (`x as unknown as T`, `as any as T`). An assertion parses nothing. Redesign the boundary instead: use the owning schema, a typed constructor or a brand.
- A single `as` is allowed only where TypeScript cannot express an invariant that holds at runtime. It needs a `// SAFETY:` comment saying why the invariant holds, and a `// Verified by:` line naming the test that fails if it breaks.
- No plain `any`, no non-null `!` (branch on the value, or use `Option` / `Array.head`). `pnpm lint` fails on both.

## Translate tagged errors by tag

When the failure channel holds tagged errors, translate with `Effect.catchTag` / `Effect.catchTags` and name every source tag:

```ts
readRegisters(request).pipe(
  Effect.catchTags({
    ModbusException: (error) =>
      Effect.fail(new PointReadFailed({ pointId, reason: "DeviceException", code: error.code })),
    ModbusFrameError: () => Effect.fail(new PointReadFailed({ pointId, reason: "BadFrame" }))
  })
)
```

- Don't branch on `instanceof` or `error._tag` inside `Effect.mapError`, `Effect.catch` or `Effect.catchCause` to tell tagged failures apart.
- Don't add a catch-all that silently classifies future tags. An unhandled tag left in the channel is the point: a new failure becomes a type error until someone decides its translation.
- `Effect.mapError` is right when the whole channel has one meaning, for example wrapping one `UnknownError` from `Effect.tryPromise`.

## `Effect.gen` for decisions, `pipe` for policy

Logic goes in a generator: yielding services, dependent steps, branches, loops, early returns. Cross-cutting policy wraps it from outside: error translation, retry, timeout, spans, log annotations, `Effect.provide`.

| The code does…                                    | Use                                              |
| ------------------------------------------------- | ------------------------------------------------ |
| Yields services, runs dependent steps, branches   | `Effect.gen` or `Effect.fn("Name")(function* …)` |
| Error translation, retry, timeout, tracing        | `.pipe(...)`, or trailing `Effect.fn` arguments  |
| One pure transform of a result                    | `.pipe(Effect.map(...))`                         |
| Two or more dependent `flatMap` / `andThen` steps | Rewrite as a generator                           |

```ts
const pollPoint = Effect.fn("Device.pollPoint")(
  function* (point: PointConfig) {
    const driver = yield* Driver
    const raw = yield* driver.read(point)
    return normalize(point, raw)
  },
  Effect.timeout("2 seconds"),
  Effect.retry({ schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered), times: 4 })
)
```

Pass a pipeable combinator straight to `Effect.fn`; don't wrap it in `(effect) => effect.pipe(...)`.

## Effect v4 spellings

| v3                                                | v4                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Context.Tag`, `Effect.Tag`, `Effect.Service`     | `class X extends Context.Service<X, Shape>()("id")`, wired with `Layer.effect`          |
| `FiberRef` with a default                         | `Context.Reference`                                                                     |
| `Effect.catchAll` / `catchAllCause` / `catchSome` | `Effect.catch` / `Effect.catchCause` / `Effect.catchFilter`                             |
| `Either`, `Effect.either`                         | `Result`, `Effect.result` (`Result.isSuccess` / `isFailure`, `.success` / `.failure`)   |
| `Effect.dieMessage(m)`                            | `Effect.die(new Error(m))`                                                              |
| `Layer.scoped`                                    | `Layer.effect` (it provides the layer `Scope`)                                          |
| `Schema.decodeUnknown`, `Schema.decode`           | `Schema.decodeUnknownEffect`, `Schema.decodeEffect`                                     |
| `Schema.optionalWith`                             | `Schema.optional` / `Schema.optionalKey`, plus `withDecodingDefaultKey` for defaults    |
| `Schema.Literal("a", "b")`, `Schema.Union(a, b)`  | `Schema.Literals(["a", "b"])`, `Schema.Union([a, b])`                                   |
| `ParseError` in the error channel                 | `SchemaError` (its issue is a `SchemaIssue`)                                            |
| `@effect/platform`, `@effect/cli`                 | `effect/socket`, `effect/FileSystem`, `effect/cli`, …; `@effect/platform-node` for Node |

## Effect v4 traps

The compiler catches none of these.

- **Empty env strings.** v4's env `ConfigProvider` drops `""`: `Config.withDefault` takes the default and `Config.option` reads `None`. An entrypoint that reads env provides `ConfigProvider.fromEnv({ preserveEmptyStrings: true })`.
- **`Queue.takeAll` waits** for at least one item on an empty queue. Never use it in a drain or shutdown path (the MQTT outbox, for one); use `Queue.clear` or a bounded poll.
- **Layers built inside a running program share its memo map.** A per-device layer built with `Layer.build` / `buildWithScope` gets the parent's already-built services unless you wrap it in `Layer.fresh`.
- **`Effect.runFork` starts and interrupts synchronously.** Code after the call already sees the fiber's synchronous steps.
- **Tagged classes have no static `_tag`.** `MyError._tag` is `undefined`; read it from an instance or write the literal.
- **`Cause` is flat.** `exit.cause._tag === "Fail"` and `exit.cause.error` read `undefined` and make a test pass or fail for the wrong reason. Assert on `Exit` with `Effect.flip`, `Effect.exit` plus `Exit.findErrorOption`, or `Cause` helpers from `repos/effect/packages/effect/src/Cause.ts`.
- **`Effect.runPromise` rejects with the bare error**, not a `FiberFailure` wrapper.
- **`Schema.NumberFromString` coerces like `Number(s)`:** `"abc"` decodes to `NaN` and `""` to `0`. Don't use it on an MQTT command payload or any other wire value without a finiteness check.
