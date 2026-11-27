/**
 * The config file behind the status page's editor: a save is refused when the file changed since it was read or
 * the candidate is invalid (every issue with its path), keeps the previous text as `.bak`, replaces the file whole
 * and keeps its permissions; and the store says when saving cannot work here, and why.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { chmodSync, statSync } from "node:fs"
import { checkEditability, etagOf, makeConfigStore } from "../src/ConfigStore.ts"

const valid = (site: string) =>
  `${JSON.stringify({ site, building: "b", mqtt: { url: "mqtt://localhost:1883" }, devices: [] }, null, 2)}\n`

/** A valid config with one simulated device: one that a save backs up. */
const withDevice = (site: string) =>
  `${JSON.stringify(
    {
      site,
      building: "b",
      mqtt: { url: "mqtt://localhost:1883" },
      devices: [
        {
          id: "sim",
          protocol: "simulator",
          points: [{ id: "p", name: "P", waveform: "sine", min: 0, max: 1, periodSeconds: 60 }]
        }
      ]
    },
    null,
    2
  )}\n`

/** A folder of its own with `ot-gateway.json` in it, and the store for that file. */
const folderWithConfig = (text: string, mode = 0o644) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const folder = yield* fs.makeTempDirectoryScoped()
    const path = `${folder}/ot-gateway.json`
    yield* fs.writeFileString(path, text, { mode })
    const store = yield* makeConfigStore(path)
    return { fs, folder, path, store }
  })

describe("ConfigStore", () => {
  it.effect("reads the file with an ETag that changes with its text", () =>
    Effect.gen(function* () {
      const { store } = yield* folderWithConfig(valid("s"))
      const file = yield* store.read
      expect(file).toEqual({ text: valid("s"), etag: etagOf(valid("s")) })
      expect(etagOf(valid("s"))).not.toBe(etagOf(valid("t")))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("saves a valid config atomically and keeps the previous one as .bak, with the file's permissions", () =>
    Effect.gen(function* () {
      const { fs, folder, path, store } = yield* folderWithConfig(withDevice("before"), 0o600)
      const { etag } = yield* store.read
      const saved = yield* store.save(withDevice("after"), etag)
      expect(saved.etag).toBe(etagOf(withDevice("after")))
      expect(saved.previous).toBe(withDevice("before"))
      expect(saved.config.site).toBe("after")
      expect(saved.backedUp).toBe(true)
      expect(yield* fs.readFileString(path)).toBe(withDevice("after"))
      expect(yield* fs.readFileString(`${path}.bak`)).toBe(withDevice("before"))
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600)
      // Nothing left behind but the config and its backup.
      expect((yield* fs.readDirectory(folder)).toSorted()).toEqual(["ot-gateway.json", "ot-gateway.json.bak"])
      // Put back after a failed apply.
      yield* store.restore(saved.previous)
      expect(yield* fs.readFileString(path)).toBe(withDevice("before"))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps no .bak of the empty config init wrote, the first time; every later save keeps one", () =>
    Effect.gen(function* () {
      const { fs, folder, path, store } = yield* folderWithConfig(valid("fresh"))
      const first = yield* store.save(withDevice("fresh"), (yield* store.read).etag)
      expect(first.backedUp).toBe(false)
      expect(yield* fs.readDirectory(folder)).toEqual(["ot-gateway.json"])
      const second = yield* store.save(withDevice("second"), (yield* store.read).etag)
      expect(second.backedUp).toBe(true)
      expect(yield* fs.readFileString(`${path}.bak`)).toBe(withDevice("fresh"))
      // With a .bak there, even an empty config is backed up: undo must not jump past it.
      yield* store.save(valid("empty"), (yield* store.read).etag)
      const fourth = yield* store.save(withDevice("again"), (yield* store.read).etag)
      expect(fourth.backedUp).toBe(true)
      expect(yield* fs.readFileString(`${path}.bak`)).toBe(valid("empty"))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("refuses a save when the file changed since it was read, and writes nothing", () =>
    Effect.gen(function* () {
      const { fs, path, store } = yield* folderWithConfig(valid("before"))
      const { etag } = yield* store.read
      // A hand edit meanwhile.
      yield* fs.writeFileString(path, valid("by-hand"))
      const conflict = yield* Effect.flip(store.save(valid("from-page"), etag))
      expect(conflict._tag).toBe("ConfigConflict")
      expect(conflict).toMatchObject({ etag: etagOf(valid("by-hand")) })
      expect(yield* fs.readFileString(path)).toBe(valid("by-hand"))
      expect(yield* fs.exists(`${path}.bak`)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("refuses an invalid config with every issue and its path, and writes nothing", () =>
    Effect.gen(function* () {
      const { fs, path, store } = yield* folderWithConfig(valid("before"))
      const { etag } = yield* store.read
      const candidate = JSON.stringify({ site: "Not A Slug", building: "b", mqtt: { url: "http://x" }, devices: [] })
      const invalid = yield* Effect.flip(store.save(candidate, etag))
      expect(invalid).toMatchObject({
        _tag: "ConfigInvalid",
        issues: [{ path: ["site"] }, { path: ["mqtt", "url"] }],
        message: expect.stringContaining("mqtt.url: must start with mqtts:// or mqtt://")
      })
      expect(yield* fs.readFileString(path)).toBe(valid("before"))
      // Broken JSON is one issue for the whole file.
      const checked = yield* store.check("{ nope")
      expect(checked).toMatchObject({ _tag: "Failure", failure: [{ path: [] }] })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("names the compose.yaml mount as the fix in the container (/etc/ot-gateway)", () =>
    Effect.gen(function* () {
      const inContainer = yield* checkEditability("/etc/ot-gateway/gateway.json")
      expect(inContainer).toMatchObject({ writable: false, fix: expect.stringContaining("- .:/etc/ot-gateway") })
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

// Not as root (a cloud container, Docker's default user): root may write whatever the mode bits say.
describe.skipIf(process.getuid?.() === 0)("ConfigStore, as a user the mode bits bind", () => {
  it.effect("says why saving cannot work: a file or a folder the gateway may not write", () =>
    Effect.gen(function* () {
      const { folder, path, store } = yield* folderWithConfig(valid("s"))
      expect(yield* store.editability).toEqual({ writable: true })
      chmodSync(path, 0o444)
      const readOnlyFile = yield* store.editability
      expect(readOnlyFile).toMatchObject({
        writable: false,
        reason: expect.stringContaining("may not write the config file")
      })
      chmodSync(path, 0o644)
      chmodSync(folder, 0o555)
      const readOnlyFolder = yield* store.editability
      chmodSync(folder, 0o755)
      expect(readOnlyFolder).toMatchObject({
        writable: false,
        reason: expect.stringContaining("keeps the previous one as a backup")
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
