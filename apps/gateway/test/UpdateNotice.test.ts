/** The daily "Update available" line: when it is wanted, and the saved answer that keeps it to one question a day. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { TestConsole } from "effect/testing"
import { CHECK_INTERVAL_MS, isNewer, noticeLine, updateNoticeWanted, withUpdateNotice } from "../src/UpdateNotice.ts"

describe("updateNoticeWanted", () => {
  it("is on for a command in a terminal, and off for --json, mcp, long-running commands, CI and the opt-out", () => {
    expect(updateNoticeWanted(["gateways", "list"], {}, true)).toBe(true)
    expect(updateNoticeWanted(["gateways", "list"], {}, false)).toBe(false)
    expect(updateNoticeWanted(["status", "--json"], {}, true)).toBe(false)
    for (const command of ["run", "demo", "simulate", "mcp"])
      expect(updateNoticeWanted([command], {}, true)).toBe(false)
    expect(updateNoticeWanted(["status"], { CI: "true" }, true)).toBe(false)
    expect(updateNoticeWanted(["status"], { OT_GATEWAY_NO_UPDATE_CHECK: "1" }, true)).toBe(false)
    expect(updateNoticeWanted(["status"], { OT_GATEWAY_NO_UPDATE_CHECK: "0" }, true)).toBe(true)
  })
})

describe("isNewer", () => {
  it("compares releases, and never calls a build that is not one outdated", () => {
    expect(isNewer("0.17.0", "v0.16.3")).toBe(true)
    expect(isNewer("0.16.3", "v0.16.3")).toBe(false)
    expect(isNewer("0.16.2", "v0.16.3")).toBe(false)
    expect(isNewer("1.0.0", "dev")).toBe(false)
    expect(noticeLine("v0.16.3", "0.17.0")).toBe("Update available: v0.16.3 → v0.17.0. Run npm i -g ot-gateway@latest")
  })
})

const errors = Effect.map(TestConsole.errorLines, (lines) => lines.map(String))

describe("withUpdateNotice", () => {
  it.effect("asks once a day, prints the notice after the command, and keeps the command's result", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      let asked = 0
      const latest = Effect.sync(() => {
        asked += 1
        return "0.17.0"
      })
      const now = Date.UTC(2026, 10, 27)
      const first = yield* Effect.succeed("done").pipe(withUpdateNotice({ current: "v0.16.3", folder, now, latest }))
      expect(first).toBe("done")
      expect(yield* errors).toEqual(["Update available: v0.16.3 → v0.17.0. Run npm i -g ot-gateway@latest"])
      // Within the day the saved answer serves: no second question, the same line.
      yield* Effect.void.pipe(withUpdateNotice({ current: "v0.16.3", folder, now: now + 1000, latest }))
      expect(asked).toBe(1)
      expect(yield* errors).toHaveLength(2)
      // A day later it asks again; an up-to-date CLI prints nothing.
      yield* Effect.void.pipe(withUpdateNotice({ current: "v0.17.0", folder, now: now + CHECK_INTERVAL_MS, latest }))
      expect(asked).toBe(2)
      expect(yield* errors).toHaveLength(2)
    }).pipe(Effect.provide([NodeServices.layer, TestConsole.layer]))
  )

  it.effect("stays quiet when the registry cannot be asked, and for a build that is not a release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      const now = Date.UTC(2026, 10, 27)
      yield* Effect.void.pipe(withUpdateNotice({ current: "v0.16.3", folder, now, latest: Effect.fail("offline") }))
      yield* Effect.void.pipe(withUpdateNotice({ current: "dev", folder, now, latest: Effect.succeed("9.0.0") }))
      expect(yield* errors).toEqual([])
      expect(yield* fs.exists(`${folder}/update-check.json`)).toBe(false)
    }).pipe(Effect.provide([NodeServices.layer, TestConsole.layer]))
  )
})
