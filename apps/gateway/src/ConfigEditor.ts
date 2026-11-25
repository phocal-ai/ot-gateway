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
  ConfigInvalid,
  type ConfigIssue,
  type ConfigSaved,
  type ConfigUnreadable,
  type ConfigWriteFailed,
  EditingDisabled,
  type EditStatus
} from "@ot-gateway/api"
import type { GatewayConfig } from "@ot-gateway/core"
import { Config, Effect, Fiber, Option, type Redacted, Result, Semaphore } from "effect"
import { describeIssues, makeConfigStore } from "./ConfigStore.ts"
import { type EditAccess, editAccess, editToken } from "./EditGuard.ts"

/**
 * What the page may not change: the variable the broker password is read from. Variables are read when the gateway
 * starts, so another one needs ot-gateway.env and a restart anyway; from the page, keep it or remove it.
 */
export const pageIssues = (candidate: GatewayConfig, running: GatewayConfig): ReadonlyArray<ConfigIssue> =>
  candidate.mqtt.passwordEnv === undefined || candidate.mqtt.passwordEnv === running.mqtt.passwordEnv
    ? []
    : [
        {
          path: ["mqtt", "passwordEnv"],
          message: `the page keeps ${running.mqtt.passwordEnv === undefined ? "no password variable" : running.mqtt.passwordEnv} here: to read the password from another variable, set it in ot-gateway.env, edit ot-gateway.json by hand and restart the gateway`
        }
      ]

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
  // A save outlives the request that started it: the gateway's scope owns it, so a timeout or a closed tab cannot
  // stop it between the write and the restore.
  const scope = yield* Effect.scope

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
    store.check(text).pipe(
      Effect.map((result): ConfigCheck => {
        if (Result.isFailure(result)) return { valid: false, issues: result.failure }
        const issues = pageIssues(result.success, deps.running())
        return issues.length === 0 ? { valid: true, issues: [] } : { valid: false, issues }
      })
    )

  const saveAndApply = Effect.fn("ConfigEditor.saveAndApply")(function* (text: string, etag: string) {
    const editable = yield* store.editability
    if (!editable.writable) return yield* new EditingDisabled({ message: `${editable.reason} ${editable.fix}` })
    const candidate = yield* store.check(text)
    if (Result.isSuccess(candidate)) {
      const issues = pageIssues(candidate.success, deps.running())
      if (issues.length > 0) {
        return yield* new ConfigInvalid({
          message: `not a valid config:\n${describeIssues(issues).join("\n")}`,
          issues
        })
      }
    }
    const saved = yield* store.save(text, etag)
    const applied = yield* deps.apply(deps.file.resolve(saved.config)).pipe(Effect.result)
    if (Result.isSuccess(applied)) {
      const change = applied.success
      // Writes are a decision (VISION.md): the line says which points take commands now, and within what.
      const writes = change.changes.filter((line) => line.startsWith("write"))
      if (writes.length > 0) {
        yield* Effect.logWarning("writes changed from the status page").pipe(
          Effect.annotateLogs({ writes: writes.join("; ") })
        )
      }
      return { etag: saved.etag, applied: change }
    }
    const failed = applied.failure
    // The previous config runs again: so the file says what runs, it gets the previous text back.
    const restored = yield* Effect.result(store.restore(saved.previous))
    return yield* new ConfigApplyFailed({
      message: Result.isSuccess(restored)
        ? `${failed.message} Nothing changed: ${store.path} holds the previous config again.`
        : `${failed.message} Putting the previous config back into ${store.path} failed too (${restored.failure.message}); ${store.path}.bak has it.`
    })
  }, Semaphore.withPermit(saving))

  const save = Effect.fn("ConfigEditor.save")(function* (text: string, etag: string) {
    const running = yield* Effect.forkIn(saveAndApply(text, etag), scope)
    const outcome = yield* Fiber.await(running).pipe(Effect.timeoutOption(APPLY_TIMEOUT))
    if (Option.isNone(outcome)) {
      return yield* new ConfigApplyFailed({
        message: `The config is saved, and the gateway is still applying it after ${APPLY_TIMEOUT}. If it does not start, the previous config runs again and ${store.path} gets it back. Reload the page in a minute: the events say which.`
      })
    }
    return yield* outcome.value
  })

  return {
    access,
    token,
    status,
    file: store.read,
    check,
    save
  } satisfies ConfigEditor
})
