/**
 * The CLI for scripts and agents: with --json, stdout is one JSON document and nothing else, a usage mistake
 * included, and a usage mistake exits with 2 rather than the 1 of a failed run.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Console, Effect, Exit, Result } from "effect"
import { CliError } from "effect/cli"
import { TestConsole } from "effect/testing"
import { runCli, toCliArgs } from "../src/Cli.ts"
import { isUsageError, printJson, ResultConsole, stderrConsole, usageFailure } from "../src/Output.ts"
import { gatewayTeardown } from "../src/Shutdown.ts"
import { messageRecord } from "../src/Watch.ts"

const exitCodeOf = (exit: Exit.Exit<unknown, unknown>) => {
  const codes: Array<number> = []
  gatewayTeardown(exit, (code) => codes.push(code))
  return codes
}

const usageErrorOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return undefined
  const error = Cause.findError(exit.cause)
  return Result.isSuccess(error) && CliError.isCliError(error.success) && isUsageError(error.success)
    ? error.success
    : undefined
}

describe("usage mistakes", () => {
  it.effect("exit with 2, and --json describes them as JSON with a hint", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(runCli(["check", "--json", "--bogus"]))
      expect(exitCodeOf(exit)).toEqual([2])
      const usage = usageErrorOf(exit)
      expect(usage).toBeDefined()
      if (usage === undefined) return
      expect(usageFailure(usage)).toEqual({
        ok: false,
        code: "usage",
        error: "Unrecognized flag: --bogus in command ot-gateway check",
        hint: "ot-gateway check --help lists the commands and flags"
      })
    }).pipe(Effect.provide([TestConsole.layer, NodeServices.layer]))
  )

  it.effect("include a mistyped command, which is no longer taken for a config to run", () =>
    Effect.gen(function* () {
      expect(toCliArgs(["stauts"])).toEqual(["stauts"])
      expect(toCliArgs(["gateway.json"])).toEqual(["run", "gateway.json"])
      expect(toCliArgs(["./site"])).toEqual(["run", "./site"])
      const exit = yield* Effect.exit(runCli(["stauts"]))
      expect(exitCodeOf(exit)).toEqual([2])
      expect(
        usageErrorOf(exit)
          ?.errors.map((error) => error.message)
          .join()
      ).toContain("status")
    }).pipe(Effect.provide([TestConsole.layer, NodeServices.layer]))
  )

  it.effect("leave --help a success", () =>
    Effect.gen(function* () {
      expect(exitCodeOf(yield* Effect.exit(runCli(["check", "--help"])))).toEqual([0])
    }).pipe(Effect.provide([TestConsole.layer, NodeServices.layer]))
  )
})

describe("--json output", () => {
  it.effect("puts results on the result console and the rest on stderr", () =>
    Effect.gen(function* () {
      const results: Array<string> = []
      const resultConsole = { ...globalThis.console, log: (text: string) => results.push(text) }
      yield* Effect.gen(function* () {
        yield* Console.log("help text")
        yield* printJson({ ok: true })
      }).pipe(Effect.updateService(Console.Console, stderrConsole), Effect.provideService(ResultConsole, resultConsole))
      expect(results).toEqual(['{\n  "ok": true\n}'])
      expect(yield* TestConsole.logLines).toEqual([])
      expect(yield* TestConsole.errorLines).toEqual(["help text"])
    }).pipe(Effect.provide(TestConsole.layer))
  )

  it.effect("are Console lines without --json, as tests and the terminal see them", () =>
    Effect.gen(function* () {
      yield* printJson({ ok: true })
      expect(yield* TestConsole.logLines).toEqual(['{\n  "ok": true\n}'])
    }).pipe(Effect.provide(TestConsole.layer))
  )
})

describe("watch --json", () => {
  it("prints one JSON object per message, the payload parsed when it is JSON", () => {
    const at = new Date("2026-11-06T10:00:00.000Z")
    expect(
      JSON.parse(messageRecord({ topic: "s/b/ventilation-1/temp", payload: '{"value":21.5}', retain: false }, at))
    ).toEqual({
      at: "2026-11-06T10:00:00.000Z",
      topic: "s/b/ventilation-1/temp",
      retained: false,
      payload: { value: 21.5 }
    })
    expect(JSON.parse(messageRecord({ topic: "x", payload: "on", retain: true }, at)).payload).toBe("on")
  })
})
