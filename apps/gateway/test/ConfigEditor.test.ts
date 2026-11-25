/**
 * The config editor's save outlives the request that started it: a slow apply that fails still puts the previous
 * text back into the file, even when the request gave up or was interrupted.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigApplyFailed, type ConfigChange } from "@ot-gateway/api"
import { parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { etagOf } from "../src/ConfigStore.ts"
import { makeConfigEditor } from "../src/ConfigEditor.ts"

const configText = (site: string) =>
  `${JSON.stringify({ site, building: "b", mqtt: { url: "mqtt://127.0.0.1:1883" }, devices: [] }, null, 2)}\n`

const oldText = configText("old")
const newText = configText("new")

const change: ConfigChange = { summary: "gateway: site", changes: ["gateway: site"], restartNeeded: [] }

/** An editor on a temporary file holding `oldText`, whose apply sleeps a minute, then fails or succeeds. */
const setup = (outcome: "fail" | "succeed") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const path = `${directory}/ot-gateway.json`
    yield* fs.writeFileString(path, oldText)
    const runningConfig = yield* parseConfig(oldText)
    const editor = yield* makeConfigEditor({
      file: { path, resolve: (config) => config },
      bindAddress: "127.0.0.1",
      running: () => runningConfig,
      apply: () =>
        Effect.sleep("60 seconds").pipe(
          Effect.flatMap(() =>
            outcome === "fail"
              ? Effect.fail(new ConfigApplyFailed({ message: "did not start" }))
              : Effect.succeed(change)
          )
        )
    })
    const read = fs.readFileString(path)
    return { editor, read }
  })

/** The file system is real, so wait in real time (up to 5 s) until the file holds `expected`. */
const untilFileHolds = (read: Effect.Effect<string, unknown>, expected: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((yield* read) === expected) return
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 25)))
    }
    expect(yield* read).toBe(expected)
  })

describe("ConfigEditor.save", () => {
  it.effect("puts the previous text back when a slow apply fails after the request gave up", () =>
    Effect.gen(function* () {
      const { editor, read } = yield* setup("fail")
      const request = yield* Effect.forkChild(editor.save(newText, etagOf(oldText)))
      yield* untilFileHolds(read, newText)
      yield* TestClock.adjust("26 seconds")
      const error = yield* Fiber.join(request).pipe(Effect.flip)
      expect(error._tag).toBe("ConfigApplyFailed")
      expect(error.message).toContain("still applying")
      expect(yield* read).toBe(newText)
      yield* TestClock.adjust("40 seconds")
      yield* untilFileHolds(read, oldText)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("puts the previous text back when the request is interrupted", () =>
    Effect.gen(function* () {
      const { editor, read } = yield* setup("fail")
      const request = yield* Effect.forkChild(editor.save(newText, etagOf(oldText)))
      yield* untilFileHolds(read, newText)
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(request)
      yield* TestClock.adjust("70 seconds")
      yield* untilFileHolds(read, oldText)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps the new text when a slow apply succeeds", () =>
    Effect.gen(function* () {
      const { editor, read } = yield* setup("succeed")
      yield* Effect.forkChild(editor.save(newText, etagOf(oldText)))
      yield* untilFileHolds(read, newText)
      yield* TestClock.adjust("70 seconds")
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 200)))
      expect(yield* read).toBe(newText)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
