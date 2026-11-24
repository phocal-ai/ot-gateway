/**
 * Editing the config from the status page: whether the gateway lets this page edit, the config file as it is on
 * disk with its ETag, a check of a candidate (the same `parseConfig` as `ot-gateway check`) and a save that applies
 * the config without a restart. The file stays the source of truth: a save writes it, keeps the previous version
 * next to it and is refused when the file changed since it was read.
 *
 * Every request that is not a GET (check and save) must come from the page itself: an `Origin` that matches the
 * `Host`, the `X-OT-Gateway: 1` header and, when `OT_GATEWAY_EDIT_TOKEN` is set, `Authorization: Bearer <token>`.
 * The broker password is never part of this: the page sees only whether the variable the config names is set.
 */
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

/** The header every write must carry: a cross-site page cannot send it without a CORS preflight, never granted. */
export const EDIT_HEADER = "x-ot-gateway"
export const EDIT_HEADER_VALUE = "1"

/** One problem in a candidate config: where (`["mqtt", "url"]`, `[]` for the whole file) and what to change. */
export const ConfigIssue = Schema.Struct({
  path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
  message: Schema.String
})
export type ConfigIssue = typeof ConfigIssue.Type

/**
 * Whether this page may edit the config, and if not why, in plain words, with what to change (`fix`). `auth` is
 * `token` when `OT_GATEWAY_EDIT_TOKEN` guards edits: the page then asks for it once.
 */
export const EditStatus = Schema.Struct({
  enabled: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
  fix: Schema.optionalKey(Schema.String),
  auth: Schema.Literals(["none", "token"]),
  /** The config file the gateway runs from and saves to. */
  path: Schema.String,
  /** The variable `mqtt.passwordEnv` names, and whether it is set; its value never leaves the gateway. */
  password: Schema.optionalKey(Schema.Struct({ variable: Schema.String, set: Schema.Boolean }))
})
export type EditStatus = typeof EditStatus.Type

/** The config file's text as it is on disk, and its ETag (a hash of the text) for the save. */
export const ConfigFile = Schema.Struct({ text: Schema.String, etag: Schema.String })
export type ConfigFile = typeof ConfigFile.Type

/** What the check found: `valid` with no issues, or every issue at once. */
export const ConfigCheck = Schema.Struct({ valid: Schema.Boolean, issues: Schema.Array(ConfigIssue) })
export type ConfigCheck = typeof ConfigCheck.Type

/** What a save changed, in short (`summary`), part by part (`changes`), and what only a restart applies. */
export const ConfigChange = Schema.Struct({
  summary: Schema.String,
  changes: Schema.Array(Schema.String),
  /** Sections saved but not applied until the gateway restarts (the status page's own address, the history). */
  restartNeeded: Schema.Array(Schema.String)
})
export type ConfigChange = typeof ConfigChange.Type

/** Saved and applied: the file's new ETag and what changed. */
export const ConfigSaved = Schema.Struct({ etag: Schema.String, applied: ConfigChange })
export type ConfigSaved = typeof ConfigSaved.Type

/** This page may not edit: the reason and the fix are in the message (and in `GET /api/config/edit`). */
export class EditingDisabled extends Schema.TaggedError<EditingDisabled>()(
  "EditingDisabled",
  { message: Schema.String },
  { httpApiStatus: 403 }
) {}

/** The file changed since the page read it (a hand edit, another browser): nothing was written. */
export class ConfigConflict extends Schema.TaggedError<ConfigConflict>()(
  "ConfigConflict",
  { message: Schema.String, etag: Schema.String },
  { httpApiStatus: 409 }
) {}

/** The candidate is not a valid config: nothing was written. */
export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()(
  "ConfigInvalid",
  { message: Schema.String, issues: Schema.Array(ConfigIssue) },
  { httpApiStatus: 400 }
) {}

/** The config file could not be read (deleted, or its permissions changed under the gateway). */
export class ConfigUnreadable extends Schema.TaggedError<ConfigUnreadable>()(
  "ConfigUnreadable",
  { message: Schema.String },
  { httpApiStatus: 500 }
) {}

/** The file or its backup could not be written: nothing changed. */
export class ConfigWriteFailed extends Schema.TaggedError<ConfigWriteFailed>()(
  "ConfigWriteFailed",
  { message: Schema.String },
  { httpApiStatus: 500 }
) {}

/**
 * The config was valid but did not start (the buffer's file cannot be opened, the broker refuses it): the
 * previous config runs again and the file holds it again. `message` says what failed and what to change.
 */
export class ConfigApplyFailed extends Schema.TaggedError<ConfigApplyFailed>()(
  "ConfigApplyFailed",
  { message: Schema.String },
  { httpApiStatus: 422 }
) {}

export class ConfigEditGroup extends HttpApiGroup.make("editor")
  .add(HttpApiEndpoint.get("editStatus", "/api/config/edit", { success: EditStatus }))
  .add(HttpApiEndpoint.get("file", "/api/config/file", { success: ConfigFile, error: ConfigUnreadable }))
  .add(
    HttpApiEndpoint.post("check", "/api/config/check", {
      payload: Schema.Struct({ text: Schema.String }),
      success: ConfigCheck,
      error: EditingDisabled
    })
  )
  .add(
    HttpApiEndpoint.put("save", "/api/config/file", {
      payload: Schema.Struct({ text: Schema.String, etag: Schema.String }),
      success: ConfigSaved,
      error: [EditingDisabled, ConfigConflict, ConfigInvalid, ConfigUnreadable, ConfigWriteFailed, ConfigApplyFailed]
    })
  ) {}
