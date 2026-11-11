/**
 * The status page's config editor, behind `/api/config/edit`, `/api/config/file` and `/api/config/check`: the
 * store (ConfigStore.ts) for the file, the edit guard (EditGuard.ts) for who may write, and the gateway's apply
 * (Gateway.ts) for running a saved config without a restart.
 *
 * A save is checked, written, then applied. When the new config does not start, the gateway runs the previous one
 * again and the file gets the previous text back, so the file always says what runs.
 */
import {
  type ConfigChange,
  ConfigApplyFailed,
  type ConfigCheck,
  type ConfigConflict,
  type ConfigFile,
  type ConfigInvalid,
  type ConfigSaved,
  type ConfigUnreadable,
  type ConfigWriteFailed,
  EditingDisabled,
  type EditStatus
} from "@ot-gateway/api"
import type { GatewayConfig } from "@ot-gateway/core"
import { Config, Effect, Option, type Redacted, Result, Semaphore } from "effect"
import { makeConfigStore } from "./ConfigStore.ts"
import { type EditAccess, editAccess, editToken } from "./EditGuard.ts"

/** The file the running config came from, and how its relative paths were resolved at start. */
export interface ConfigFileSource {
  readonly path: string
  /** The config as the gateway runs it: `buffer.path` and `history.path` resolved as `loadConfig` does. */
  readonly resolve: (config: GatewayConfig) => GatewayConfig
}

export interface ConfigEditor {
  /** Whether the bind address lets the page edit, and with what proof; the edit guard enforces it on every write. */
  readonly access: EditAccess
  readonly token: Option.Option<Redacted.Redacted>
  readonly status: Effect.Effect<EditStatus>
  readonly file: Effect.Effect<ConfigFile, ConfigUnreadable>
  readonly check: (text: string) => Effect.Effect<ConfigCheck>
  readonly save: (
    text: string,
    etag: string
  ) => Effect.Effect<
    ConfigSaved,
    EditingDisabled | ConfigConflict | ConfigInvalid | ConfigUnreadable | ConfigWriteFailed | ConfigApplyFailed
  >
}

/**
 * How long a save waits for its config to be applied: stopping the old one, starting the new one and, when the
 * broker changed, its first connect (10 s at most). Inside the status server's 30 s request deadline.
 */
const APPLY_TIMEOUT = "25 seconds"

export const makeConfigEditor = Effect.fn("makeConfigEditor")(function* (deps: {
  readonly file: ConfigFileSource
  /** The status page's bind address: loopback, or the LAN with a token. */
  readonly bindAddress: string
  /** The config running now. */
  readonly running: () => GatewayConfig
  /** Run `config` in place of the running one; fails when it did not start, after the previous one runs again. */
  readonly apply: (config: GatewayConfig) => Effect.Effect<ConfigChange, ConfigApplyFailed>
}) {
  const store = yield* makeConfigStore(deps.file.path)
  const token = yield* editToken
  const access = editAccess(deps.bindAddress, token)
  // One save at a time, from the check of the ETag to the end of the apply.
  const saving = yield* Semaphore.make(1)

  /** The variable `mqtt.passwordEnv` names and whether it is set; never its value. */
  const password = Effect.gen(function* () {
    const variable = deps.running().mqtt.passwordEnv
    if (variable === undefined) return undefined
    const value = yield* Config.option(Config.String(variable)).pipe(
      Effect.catchTag("ConfigError", () => Effect.succeed(Option.none<string>()))
    )
    return { variable, set: Option.isSome(value) }
  })

  const status = Effect.gen(function* () {
    const named = yield* password
    const common = {
      auth: access.allowed ? access.auth : ("none" as const),
      path: store.path,
      ...(named === undefined ? {} : { password: named })
    }
    if (!access.allowed) return { enabled: false, reason: access.reason, fix: access.fix, ...common }
    const editable = yield* store.editability
    if (!editable.writable) return { enabled: false, reason: editable.reason, fix: editable.fix, ...common }
    return { enabled: true, ...common }
  })

  const check = (text: string) =>
    store
      .check(text)
      .pipe(
        Effect.map((result): ConfigCheck =>
          Result.isSuccess(result) ? { valid: true, issues: [] } : { valid: false, issues: result.failure }
        )
      )

  const save = Effect.fn("ConfigEditor.save")(function* (text: string, etag: string) {
    const editable = yield* store.editability
    if (!editable.writable) return yield* new EditingDisabled({ message: `${editable.reason} ${editable.fix}` })
    const saved = yield* store.save(text, etag)
    const applied = yield* deps
      .apply(deps.file.resolve(saved.config))
      .pipe(Effect.result, Effect.timeoutOption(APPLY_TIMEOUT))
    if (Option.isNone(applied)) {
      return yield* new ConfigApplyFailed({
        message: `The config is saved, and the gateway is still applying it after ${APPLY_TIMEOUT}. Reload the page in a minute: the events say whether it was applied.`
      })
    }
    if (Result.isSuccess(applied.value)) {
      const change = applied.value.success
      // Writes are a decision (VISION.md): the line says which points take commands now, and within what.
      const writes = change.changes.filter((line) => line.startsWith("write"))
      if (writes.length > 0) {
        yield* Effect.logWarning("writes changed from the status page").pipe(
          Effect.annotateLogs({ writes: writes.join("; ") })
        )
      }
      return { etag: saved.etag, applied: change }
    }
    const failed = applied.value.failure
    // The previous config runs again: so the file says what runs, it gets the previous text back.
    const restored = yield* Effect.result(store.restore(saved.previous))
    return yield* new ConfigApplyFailed({
      message: Result.isSuccess(restored)
        ? `${failed.message} Nothing changed: ${store.path} holds the previous config again.`
        : `${failed.message} Putting the previous config back into ${store.path} failed too (${restored.failure.message}); ${store.path}.bak has it.`
    })
  }, Semaphore.withPermit(saving))

  return {
    access,
    token,
    status,
    file: store.read,
    check,
    save
  } satisfies ConfigEditor
})
