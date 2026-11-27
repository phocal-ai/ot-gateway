/** The daily "Update available" line: when it is wanted, and the saved answer that keeps it to one question a day. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { TestConsole } from "effect/testing"
import { realpathSync } from "node:fs"
import {
  CHECK_INTERVAL_MS,
  isNewer,
  noticeLine,
  updateCommand,
  updateNoticeWanted,
  withUpdateNotice
} from "../src/UpdateNotice.ts"

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
    expect(updateNoticeWanted(["events", "--follow"], {}, true)).toBe(false)
    expect(updateNoticeWanted(["watch"], {}, true)).toBe(false)
    expect(updateNoticeWanted(["status"], {}, true, "/home/u/.npm/_npx/1a2b/node_modules/ot-gateway/main.mjs")).toBe(
      false
    )
    expect(
      updateNoticeWanted(["status"], {}, true, "/home/u/.cache/pnpm/dlx/abc/19a-1/node_modules/ot-gateway/main.mjs")
    ).toBe(false)
    expect(
      updateNoticeWanted(["status"], {}, true, "/Users/u/Library/Caches/pnpm/dlx/abc/node_modules/ot-gateway/main.mjs")
    ).toBe(false)
    expect(updateNoticeWanted(["status"], {}, true, "/home/u/.bun/install/cache/ot-gateway@0.17.0/main.mjs")).toBe(
      false
    )
    expect(updateNoticeWanted(["status"], {}, true, "/tmp/xfs-1a2b/dlx-4242/node_modules/ot-gateway/main.mjs")).toBe(
      false
    )
  })
})

describe("updateCommand", () => {
  it("names the package manager whose global folder holds the CLI, and npm otherwise", () => {
    const npm = "npm i -g ot-gateway@latest"
    const pnpm = "pnpm add -g ot-gateway@latest"
    expect(updateCommand("/usr/local/lib/node_modules/ot-gateway/main.mjs")).toBe(npm)
    expect(updateCommand("")).toBe(npm)
    expect(updateCommand("/home/u/.local/share/pnpm/global/5/node_modules/ot-gateway/main.mjs")).toBe(pnpm)
    expect(
      updateCommand("/Users/u/Library/pnpm/global/5/.pnpm/ot-gateway@0.17.0/node_modules/ot-gateway/main.mjs")
    ).toBe(pnpm)
    expect(updateCommand("C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\node_modules\\ot-gateway\\main.mjs")).toBe(
      pnpm
    )
    // A project's own pnpm install is not the global one.
    expect(updateCommand("/srv/app/node_modules/.pnpm/ot-gateway@0.17.0/node_modules/ot-gateway/main.mjs")).toBe(npm)
    expect(updateCommand("/home/u/.config/yarn/global/node_modules/ot-gateway/main.mjs")).toBe(
      "yarn global add ot-gateway@latest"
    )
    expect(updateCommand("C:\\Users\\u\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\ot-gateway\\main.mjs")).toBe(
      "yarn global add ot-gateway@latest"
    )
    expect(updateCommand("/home/u/.bun/install/global/node_modules/ot-gateway/main.mjs")).toBe(
      "bun add -g ot-gateway@latest"
    )
    expect(noticeLine("v0.16.3", "0.17.0", pnpm)).toBe(
      "Update available: v0.16.3 → v0.17.0. Run pnpm add -g ot-gateway@latest"
    )
  })

  it.effect("finds a global install through the symlink in a bin folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const target = `${root}/.bun/install/global/node_modules/ot-gateway`
      yield* fs.makeDirectory(target, { recursive: true })
      yield* fs.writeFileString(`${target}/main.mjs`, "")
      yield* fs.makeDirectory(`${root}/.bun/bin`, { recursive: true })
      yield* fs.symlink(`${target}/main.mjs`, `${root}/.bun/bin/ot-gateway`)
      expect(updateCommand(`${root}/.bun/bin/ot-gateway`)).toBe("npm i -g ot-gateway@latest")
      expect(updateCommand(realpathSync(`${root}/.bun/bin/ot-gateway`))).toBe("bun add -g ot-gateway@latest")
    }).pipe(Effect.provide(NodeServices.layer))
  )
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

  it.effect("stays quiet when the registry cannot be asked, and asks again only a day later", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      const now = Date.UTC(2026, 10, 27)
      let asked = 0
      const offline = Effect.suspend(() => {
        asked += 1
        return Effect.fail("offline")
      })
      yield* Effect.void.pipe(withUpdateNotice({ current: "v0.16.3", folder, now, latest: offline }))
      yield* Effect.void.pipe(withUpdateNotice({ current: "v0.16.3", folder, now: now + 1000, latest: offline }))
      expect(asked).toBe(1)
      // A defect in the question does not reach the command either.
      const result = yield* Effect.succeed(7).pipe(
        withUpdateNotice({ current: "v0.16.3", folder, now: now + CHECK_INTERVAL_MS, latest: Effect.die("boom") })
      )
      expect(result).toBe(7)
      expect(yield* errors).toEqual([])
    }).pipe(Effect.provide([NodeServices.layer, TestConsole.layer]))
  )

  it.effect("does nothing for a build that is not a release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      yield* Effect.void.pipe(withUpdateNotice({ current: "dev", folder, now: 0, latest: Effect.succeed("9.0.0") }))
      expect(yield* errors).toEqual([])
      expect(yield* fs.exists(`${folder}/update-check.json`)).toBe(false)
    }).pipe(Effect.provide([NodeServices.layer, TestConsole.layer]))
  )
})
