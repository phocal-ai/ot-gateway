import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Schema } from "effect"
import { gatewayTeardown } from "../src/Shutdown.ts"

class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()("ConfigInvalid", { message: Schema.String }) {}

const exitCodeOf = (exit: Exit.Exit<unknown, unknown>) => {
  const codes: Array<number> = []
  gatewayTeardown(exit, (code) => codes.push(code))
  return codes
}

describe("gatewayTeardown", () => {
  it.effect("exits 0 when the gateway was stopped by a signal", () =>
    Effect.gen(function* () {
      // What a SIGTERM does to the main fiber: interrupt it.
      const fiber = yield* Effect.forkChild(Effect.never)
      yield* Effect.yieldNow
      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
      expect(exitCodeOf(exit)).toEqual([0])
    })
  )

  it("keeps a failing exit code for a failure or a defect", () => {
    expect(exitCodeOf(Exit.succeed(undefined))).toEqual([0])
    expect(exitCodeOf(Exit.fail(new ConfigInvalid({ message: "config" })))).toEqual([1])
    expect(exitCodeOf(Exit.die(new Error("bug")))).toEqual([1])
  })
})
