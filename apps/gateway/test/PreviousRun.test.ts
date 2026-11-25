/**
 * How the previous run ended: a clean stop leaves `stopped` in the run file, a crash leaves only `started`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, FileSystem, Option, Path, Scope } from "effect"
import { TestClock } from "effect/testing"
import { RUN_FILE, RUN_FILE_DEADLINE, runFilePath, trackRun } from "../src/PreviousRun.ts"

describe("trackRun", () => {
  it.effect("tells a clean stop from one that never ran its shutdown, and a first run from both", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = path.join(yield* fs.makeTempDirectoryScoped(), RUN_FILE)

      // A first run knows nothing; a clean stop (an interruption, as SIGTERM is) records when it stopped.
      const first = yield* Scope.make()
      expect(yield* trackRun(file, 1000).pipe(Scope.provide(first))).toEqual(Option.none())
      yield* Scope.close(first, Exit.interrupt(1))
      const stopped = JSON.parse(yield* fs.readFileString(file))
      expect(stopped.started).toBe(1000)
      expect(typeof stopped.stopped).toBe("number")

      // The next run reads the clean stop; this one then dies without its finalizer (a crash, a power cut).
      expect(yield* trackRun(file, 2000).pipe(Effect.scoped)).toEqual(Option.some(stopped))
      // Closed without an interruption, as a fatal error ends it: not a clean stop either, so `stopped` stays out.
      const crashed = yield* Scope.make()
      yield* trackRun(file, 3000).pipe(Scope.provide(crashed))
      yield* Scope.close(crashed, Exit.die(new Error("boom")))
      expect(yield* trackRun(file, 4000).pipe(Effect.scoped)).toEqual(Option.some({ started: 3000 }))

      // A file that is not ours reads as unknown, never as a failure.
      yield* fs.writeFileString(file, "not json")
      expect(yield* trackRun(file, 5000).pipe(Effect.scoped)).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps the file next to the outbox, else the history, and nowhere without either", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      expect(runFilePath({ buffer: { path: "/data/outbox.sqlite" } }, path)).toBe("/data/ot-gateway-run.json")
      expect(runFilePath({ history: { path: "/h/history.sqlite" } }, path)).toBe("/h/ot-gateway-run.json")
      expect(runFilePath({}, path)).toBeUndefined()
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("gives up on a card that hangs, at start and at stop, instead of holding the gateway", () =>
    Effect.gen(function* () {
      const writes: Array<string> = []
      const hanging = FileSystem.makeNoop({
        readFileString: () => Effect.never,
        writeFileString: (_path, data) =>
          Effect.andThen(
            Effect.sync(() => writes.push(data)),
            Effect.never
          )
      })
      const scope = yield* Scope.make()
      const started = yield* trackRun("/card/ot-gateway-run.json", 1000).pipe(
        Scope.provide(scope),
        Effect.provideService(FileSystem.FileSystem, hanging),
        Effect.forkChild
      )
      // The read and the first write each wait out their deadline, and no longer.
      yield* TestClock.adjust(RUN_FILE_DEADLINE)
      expect(started.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(RUN_FILE_DEADLINE)
      expect(yield* Fiber.join(started)).toEqual(Option.none())
      // The stop's write is bounded too: closing the scope finishes once its deadline has passed.
      const stopping = yield* Scope.close(scope, Exit.interrupt(1)).pipe(Effect.forkChild)
      yield* TestClock.adjust(RUN_FILE_DEADLINE)
      yield* Fiber.join(stopping)
      expect(writes.map((data) => JSON.parse(data))).toEqual([
        { started: 1000 },
        { started: 1000, stopped: 5_000 + 5_000 }
      ])
    })
  )
})
