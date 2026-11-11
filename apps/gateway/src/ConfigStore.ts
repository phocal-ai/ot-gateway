/**
 * The config file, for the status page's editor: read it with its ETag, check a candidate with `parseConfig` (the
 * same check as `ot-gateway check`, every issue with its path), and save one.
 *
 * A save is refused when the file changed since the page read it (the ETag is a hash of the text, so a hand edit, a
 * `git pull` or another browser is noticed), keeps the previous version as `<file>.bak`, and replaces the file
 * atomically: the new text goes to `<file>.tmp`, is synced to disk and renamed over the file, so a power cut leaves
 * the old config or the new one, never half of each. That needs the file's folder to be writable: a single file
 * bind-mounted into a container cannot be replaced by a rename (EBUSY), which is why compose.yaml mounts the folder.
 * `editability` says whether saving can work here, and if not, why and what to change.
 */
import { type ConfigIssue, ConfigConflict, ConfigInvalid, ConfigUnreadable, ConfigWriteFailed } from "@ot-gateway/api"
import { type GatewayConfig, parseConfig } from "@ot-gateway/core"
import { Context, Effect, FileSystem, Layer, Path, Predicate, Result, SchemaIssue, Semaphore } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { createHash } from "node:crypto"

/** The file's text and its ETag. */
export interface ConfigText {
  readonly text: string
  readonly etag: string
}

/** A save that went through: the new ETag, the text it replaced, and the config it holds now. */
export interface SavedConfig {
  readonly etag: string
  readonly previous: string
  readonly config: GatewayConfig
}

/** Whether a save can work here; when not, why and the change that makes it work. */
export type Editability =
  | { readonly writable: true }
  | { readonly writable: false; readonly reason: string; readonly fix: string }

/** A hash of the text: equal texts, equal tags; any change to the file, another tag. */
export const etagOf = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 27)

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/** Every issue of a failed `parseConfig`, each with its path (`["mqtt", "url"]`), as `ot-gateway check` lists them. */
export const configIssues = (issue: SchemaIssue.Issue): ReadonlyArray<ConfigIssue> =>
  formatIssues(issue).issues.map((each) => ({
    path: (each.path ?? []).map((segment) => {
      const key = Predicate.isObject(segment) && "key" in segment ? segment.key : segment
      return typeof key === "number" ? key : String(key)
    }),
    message: each.message
  }))

/** The candidate parsed, or every issue it has. */
export const checkConfigText = (text: string) =>
  parseConfig(text).pipe(
    Effect.map((config) => Result.succeed(config)),
    Effect.catchTag("SchemaError", (error) => Effect.succeed(Result.fail(configIssues(error.issue))))
  )

/** One issue per line, `mqtt.url: must start with mqtts:// or mqtt://`, for a message. */
export const describeIssues = (issues: ReadonlyArray<ConfigIssue>) =>
  issues.map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`))

/** The errno code of a failed file operation (`EROFS`, `EACCES`), when the platform gave one. */
const errnoOf = (error: PlatformError): string | undefined => {
  const cause = error.reason.cause
  return Predicate.hasProperty(cause, "code") && typeof cause.code === "string" ? cause.code : undefined
}

const writeFailed = (what: string) => (error: PlatformError) =>
  new ConfigWriteFailed({ message: `could not write ${what}: ${error.message}` })

/** The image's config folder: a path there means the gateway runs in the container, set up by compose.yaml. */
const containerFolder = "/etc/ot-gateway"

/** What makes the config editable under Docker Compose: the folder mounted, not the file. */
export const composeFix =
  "In compose.yaml, mount the gateway's folder instead of the file: replace the ot-gateway.json volume with " +
  "`- .:/etc/ot-gateway` and add `command: [/etc/ot-gateway/ot-gateway.json]` to the gateway service, then run " +
  "docker compose up -d (docs/operations.md, “Editing in the status page”)."

/**
 * Why the file at `path` cannot be saved here, if it cannot: a read-only mount, a file or folder the gateway's user
 * may not write. The folder matters as much as the file: the new text and the backup are written next to it.
 */
export const checkEditability = Effect.fn("ConfigStore.editability")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const folder = paths.dirname(path)
  const inContainer = folder === containerFolder
  const fileAccess = yield* Effect.result(fs.access(path, { writable: true }))
  if (Result.isFailure(fileAccess)) {
    const code = errnoOf(fileAccess.failure)
    if (code === "EROFS")
      return {
        writable: false,
        reason: `The config file ${path} is mounted read-only, so the gateway cannot save it.`,
        fix: inContainer ? composeFix : `Mount ${folder} writable, or edit ${path} by hand and restart the gateway.`
      } satisfies Editability
    return {
      writable: false,
      reason: `The gateway's user may not write the config file ${path}${code === undefined ? "" : ` (${code})`}.`,
      fix: inContainer
        ? composeFix
        : `Give the user the gateway runs as write access to ${path}, or edit it by hand and restart the gateway.`
    } satisfies Editability
  }
  const folderAccess = yield* Effect.result(fs.access(folder, { writable: true }))
  if (Result.isFailure(folderAccess))
    return {
      writable: false,
      reason: `The gateway may not write in ${folder}, where it saves the new config and keeps the previous one as a backup.`,
      fix: inContainer
        ? composeFix
        : `Give the user the gateway runs as write access to ${folder} (on a Raspberry Pi: sudo chown 1000 ${folder}).`
    } satisfies Editability
  return { writable: true } satisfies Editability
})

export interface ConfigStoreShape {
  /** The file's absolute path. */
  readonly path: string
  readonly read: Effect.Effect<ConfigText, ConfigUnreadable>
  /** The candidate parsed, or every issue with its path. */
  readonly check: (text: string) => Effect.Effect<Result.Result<GatewayConfig, ReadonlyArray<ConfigIssue>>>
  /**
   * Write `text` if the file still has `etag` and `text` is a valid config: the previous text to `<file>.bak`, then
   * the new one atomically. Nothing is written when any check fails.
   */
  readonly save: (
    text: string,
    etag: string
  ) => Effect.Effect<SavedConfig, ConfigConflict | ConfigInvalid | ConfigUnreadable | ConfigWriteFailed>
  /** Put `previous` back, after a saved config did not start: the file holds what runs. */
  readonly restore: (previous: string) => Effect.Effect<void, ConfigWriteFailed>
  readonly editability: Effect.Effect<Editability>
}

export class ConfigStore extends Context.Service<ConfigStore, ConfigStoreShape>()("@ot-gateway/gateway/ConfigStore") {
  /** The store for the config file at `path`. */
  static readonly layer = (path: string) => Layer.effect(ConfigStore, makeConfigStore(path))
}

export const makeConfigStore = Effect.fn("makeConfigStore")(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const path = paths.resolve(configPath)
  // One save at a time: two browsers saving at once cannot both pass the ETag check.
  const writing = yield* Semaphore.make(1)

  const unreadable = (error: PlatformError) =>
    new ConfigUnreadable({ message: `could not read ${path}: ${error.message}` })

  const read = fs.readFileString(path).pipe(
    Effect.map((text): ConfigText => ({ text, etag: etagOf(text) })),
    Effect.mapError(unreadable)
  )

  /** `text` into `target` through `<target>.tmp`: written, synced, given `mode`, renamed over the target. */
  const replaceFile = (target: string, text: string, mode: number) => {
    const temporary = `${target}.tmp`
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(temporary, { flag: "w", mode })
          yield* file.writeAll(new TextEncoder().encode(text))
          yield* file.sync
        })
      )
      // The mode of a file that was there already is not changed by open: set it.
      yield* fs.chmod(temporary, mode)
      yield* fs.rename(temporary, target)
    }).pipe(
      Effect.mapError(writeFailed(target)),
      // A temporary file left by a failed write is in the way of nothing, but is not left lying around either.
      Effect.tapError(() =>
        fs
          .remove(temporary)
          .pipe(
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound"
                ? Effect.void
                : Effect.logWarning("could not remove a temporary config file").pipe(
                    Effect.annotateLogs({ path: temporary, error: error.message })
                  )
            )
          )
      )
    )
  }

  /** The file's permission bits, so a config readable by its owner only stays that way. */
  const modeOf = fs.stat(path).pipe(
    Effect.map((info) => info.mode & 0o777),
    Effect.orElseSucceed(() => 0o644)
  )

  const save = Effect.fn("ConfigStore.save")(function* (text: string, etag: string) {
    const current = yield* read
    if (current.etag !== etag) {
      return yield* new ConfigConflict({
        message: `${path} changed since it was read (edited by hand or from another browser): load it again and redo the change`,
        etag: current.etag
      })
    }
    const checked = yield* checkConfigText(text)
    if (Result.isFailure(checked)) {
      return yield* new ConfigInvalid({
        message: `not a valid config:\n${describeIssues(checked.failure).join("\n")}`,
        issues: checked.failure
      })
    }
    const mode = yield* modeOf
    yield* replaceFile(`${path}.bak`, current.text, mode)
    yield* replaceFile(path, text, mode)
    return { etag: etagOf(text), previous: current.text, config: checked.success } satisfies SavedConfig
  }, Semaphore.withPermit(writing))

  const restore = Effect.fn("ConfigStore.restore")(function* (previous: string) {
    yield* replaceFile(path, previous, yield* modeOf)
  }, Semaphore.withPermit(writing))

  return ConfigStore.of({
    path,
    read,
    check: checkConfigText,
    save,
    restore,
    editability: checkEditability(path).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, paths)
    )
  })
})
