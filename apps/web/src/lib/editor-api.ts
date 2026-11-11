/**
 * The config editor's requests (`/api/config/edit`, `/api/config/file`, `/api/config/check`), through the typed
 * client for `OtGatewayApi`. Every write carries the `X-OT-Gateway` header the gateway asks for, and the edit
 * token when the gateway is guarded by one; the browser adds the `Origin` it checks against its address.
 *
 * A save comes back as one of a few outcomes the page shows as they are: saved and applied, a conflict (the file
 * changed, reload), invalid (issues by field), or refused or failed with the gateway's own words.
 */
import {
  type ConfigCheck,
  type ConfigFile,
  type ConfigIssue,
  type ConfigSaved,
  EDIT_HEADER,
  EDIT_HEADER_VALUE,
  type EditStatus,
  OtGatewayApi
} from "@ot-gateway/api"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { StatusUnavailable } from "./status"

/** Where the page keeps the edit token for this tab: sessionStorage, gone when the tab closes. */
const TOKEN_KEY = "ot-gateway-edit-token"

export const readToken = (): string | undefined => {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export const storeToken = (token: string | undefined) => {
  try {
    if (token === undefined || token === "") window.sessionStorage.removeItem(TOKEN_KEY)
    else window.sessionStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Storage blocked: the token is asked for again on the next save.
  }
}

/** The headers every write carries: the page's own header, and the token when there is one. */
export const writeHeaders = (token: string | undefined): Readonly<Record<string, string>> => ({
  [EDIT_HEADER]: EDIT_HEADER_VALUE,
  ...(token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` })
})

const editor = (token: string | undefined) =>
  HttpApiClient.make(OtGatewayApi, {
    baseUrl: typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders(writeHeaders(token)))
  }).pipe(Effect.map((client) => client.editor))

/** Applying a config waits for its broker, up to 10 s on the gateway: the page waits a little longer. */
const SAVE_TIMEOUT = "30 seconds"

const within = <A, E extends { readonly message: string }, R>(
  request: Effect.Effect<A, E, R>,
  duration: "3 seconds" | "5 seconds" | "30 seconds"
) =>
  request.pipe(
    Effect.mapError((error) => new StatusUnavailable({ message: error.message })),
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(new StatusUnavailable({ message: `no answer within ${duration}` }))
    })
  )

export const fetchEditStatus: Effect.Effect<EditStatus, StatusUnavailable> = editor(undefined).pipe(
  Effect.flatMap((client) => client.editStatus()),
  Effect.provide(FetchHttpClient.layer),
  (request) => within(request, "3 seconds")
)

export const fetchConfigFile: Effect.Effect<ConfigFile, StatusUnavailable> = editor(undefined).pipe(
  Effect.flatMap((client) => client.file()),
  Effect.provide(FetchHttpClient.layer),
  (request) => within(request, "3 seconds")
)

export const checkConfig = (text: string): Effect.Effect<ConfigCheck, StatusUnavailable> =>
  editor(readToken()).pipe(
    Effect.flatMap((client) => client.check({ payload: { text } })),
    Effect.provide(FetchHttpClient.layer),
    (request) => within(request, "5 seconds")
  )

/** What became of a save, for the page. */
export type SaveOutcome =
  | { readonly _tag: "saved"; readonly saved: ConfigSaved }
  | { readonly _tag: "conflict"; readonly message: string }
  | { readonly _tag: "invalid"; readonly issues: ReadonlyArray<ConfigIssue> }
  /** The gateway refused the write (editing off, a wrong or missing token). */
  | { readonly _tag: "refused"; readonly message: string }
  /** Saved but not started (rolled back), not written, or no answer: the message says which. */
  | { readonly _tag: "failed"; readonly message: string }

export const saveConfig = (text: string, etag: string): Effect.Effect<SaveOutcome> =>
  editor(readToken()).pipe(
    Effect.flatMap((client) => client.save({ payload: { text, etag } })),
    Effect.map((saved): SaveOutcome => ({ _tag: "saved", saved })),
    Effect.catchTags({
      EditingDisabled: (error) => Effect.succeed<SaveOutcome>({ _tag: "refused", message: error.message }),
      ConfigConflict: (error) => Effect.succeed<SaveOutcome>({ _tag: "conflict", message: error.message }),
      ConfigInvalid: (error) => Effect.succeed<SaveOutcome>({ _tag: "invalid", issues: error.issues }),
      ConfigUnreadable: (error) => Effect.succeed<SaveOutcome>({ _tag: "failed", message: error.message }),
      ConfigWriteFailed: (error) => Effect.succeed<SaveOutcome>({ _tag: "failed", message: error.message }),
      ConfigApplyFailed: (error) => Effect.succeed<SaveOutcome>({ _tag: "failed", message: error.message })
    }),
    Effect.provide(FetchHttpClient.layer),
    (request) => within(request, SAVE_TIMEOUT),
    Effect.catch((error) => Effect.succeed<SaveOutcome>({ _tag: "failed", message: error.message })),
    Effect.catchDefect((defect) =>
      Effect.succeed<SaveOutcome>({
        _tag: "failed",
        message: defect instanceof Error ? defect.message : "unexpected error"
      })
    )
  )
