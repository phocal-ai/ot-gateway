/**
 * One change to the config file from the CLI (`points allow-commands`, `config set`, `config remove`, …): read
 * once, changed as the raw JSON object so every key stays, checked with the gateway's schema, then saved through
 * the config store (the previous file is the `.bak`, the write is atomic, and a file that changed meanwhile is
 * refused). The file is written as `init` and the status page write it: two spaces, one key per line.
 *
 * Nothing here talks to a running gateway: it reads the file when it restarts, which each command's `next` says.
 */
import { type GatewayConfig, parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem, Schema } from "effect"
import { describeConfigChange } from "./ConfigChange.ts"
import { configIssues, describeIssues, etagOf, makeConfigStore } from "./ConfigStore.ts"
import { defaultConfigPath } from "./Import.ts"
import { ConfigFileIssue, loadConfig } from "./LoadConfig.ts"
import { shellArgument } from "./Output.ts"

/** Why the config was not changed; nothing was written. */
export class ConfigEditFailed extends Schema.TaggedError<ConfigEditFailed>()("ConfigEditFailed", {
  message: Schema.String,
  code: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  issues: Schema.optionalKey(Schema.Array(ConfigFileIssue))
}) {}

/** The config file as it is, every key kept. */
export type RawConfig = Readonly<Record<string, unknown>>
const ConfigObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** The config file's text for a raw object, as `init` writes it. */
export const configText = (raw: RawConfig) => `${JSON.stringify(raw, null, 2)}\n`

/** ` <path>` for a command to run next, when the config is not the one a command finds itself. */
export const configArgument = (path: string) => (path === defaultConfigPath ? "" : ` ${shellArgument(path)}`)

export interface ConfigEdit<A> {
  /** The command as typed, to run again: `ot-gateway config set mqtt.url …`. */
  readonly again: string
  /** What the change is called in a refusal: `heat-pump/setpoint cannot take commands`. */
  readonly refused: string
  /**
   * The new raw object and what the command reports about the config it makes, or why not. The report is made
   * before anything is written, so a refusal there leaves the file as it was.
   */
  readonly change: (
    raw: RawConfig,
    current: GatewayConfig
  ) => { readonly raw: RawConfig; readonly report: (after: GatewayConfig) => A | ConfigEditFailed } | ConfigEditFailed
  /** A last word on the config the change makes, before it is written. */
  readonly allowed?: (before: GatewayConfig, after: GatewayConfig) => ConfigEditFailed | undefined
}

export interface ConfigEdited<A> {
  readonly report: A
  /** False when the file said so already: nothing was written. */
  readonly changed: boolean
  /** The previous file, when one was written. */
  readonly backup?: string
  readonly config: GatewayConfig
  /** What the change does, part by part, as the status page's save says it (ConfigChange.ts). */
  readonly changes: ReadonlyArray<string>
}

/** The config at `path` with `edit` applied; a dry run checks and reports without writing. */
export const editConfigFile = Effect.fn("editConfigFile")(function* <A>(
  path: string,
  edit: ConfigEdit<A>,
  options: { readonly dryRun: boolean; readonly command?: string | undefined }
) {
  const fs = yield* FileSystem.FileSystem
  const cli = options.command ?? "ot-gateway"
  // The config's own failures first, as every command reports them (no-config, invalid-config with its issues).
  yield* loadConfig(path)
  // Then one read: the text that is judged, changed and whose ETag the save checks, so a change in between is refused.
  const changedMeanwhile = new ConfigEditFailed({
    message: `${path} changed while this ran (saved from the status page, or edited): nothing was written`,
    code: "config-not-saved",
    hint: `run it again: ${edit.again}`
  })
  const fileText = yield* fs.readFileString(path).pipe(Effect.mapError(() => changedMeanwhile))
  const current = yield* parseConfig(fileText).pipe(Effect.mapError(() => changedMeanwhile))
  const raw = yield* Schema.decodeUnknownEffect(ConfigObject)(fileText).pipe(Effect.mapError(() => changedMeanwhile))
  const change = edit.change(raw, current)
  if (change instanceof ConfigEditFailed) return yield* change

  const text = configText(change.raw)
  const invalid = (
    issues: ReadonlyArray<{ readonly path: ReadonlyArray<string | number>; readonly message: string }>
  ) =>
    new ConfigEditFailed({
      message: `${edit.refused}${options.dryRun ? "" : ", so nothing was written"}:\n${describeIssues(issues).join("\n")}`,
      code: "invalid-config",
      hint: `fix what the message names, then run this again; ${cli} explain invalid-config`,
      issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    })
  const config = yield* parseConfig(text).pipe(
    Effect.catchTag("SchemaError", (error) => Effect.fail(invalid(configIssues(error.issue))))
  )
  const refusal = edit.allowed?.(current, config)
  if (refusal !== undefined) return yield* refusal
  const report = change.report(config)
  if (report instanceof ConfigEditFailed) return yield* report
  const changed = text !== configText(raw)
  const saved = changed && !options.dryRun
  if (saved) {
    const store = yield* makeConfigStore(path)
    yield* store.save(text, etagOf(fileText)).pipe(
      Effect.catchTags({
        ConfigConflict: () => Effect.fail(changedMeanwhile),
        ConfigInvalid: (error) => Effect.fail(invalid(error.issues)),
        ConfigUnreadable: (error) =>
          Effect.fail(new ConfigEditFailed({ message: error.message, code: "config-not-saved" })),
        ConfigWriteFailed: (error) =>
          Effect.fail(
            new ConfigEditFailed({
              message: `${error.message}; ${path} is as it was`,
              code: "config-not-saved",
              hint: `the user running this must be able to write ${path} and its folder`
            })
          )
      })
    )
  }
  return {
    report,
    changed,
    ...(saved ? { backup: `${path}.bak` } : {}),
    config,
    changes: describeConfigChange(current, config).changes
  } satisfies ConfigEdited<A>
})

/** After a saved change: what it does on the broker, and the restart that makes the running gateway read it. */
export const afterSave = (cli: string, path: string) => [
  {
    command: `${cli} diff${configArgument(path)}`,
    description: "What the saved config changes on the broker against the running gateway"
  },
  {
    command: `${cli} restart${configArgument(path)}`,
    description: "The running gateway reads the config again; under systemd, restart its service"
  }
]
