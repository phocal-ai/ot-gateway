/**
 * The setup requests (`/api/test/broker`, `/api/test/read`, `/api/import/check`, `/api/import/apply`), through the
 * typed client for `OtGatewayApi`. They are writes as far as the gateway's guard goes (they connect to devices), so
 * every one carries the same headers as a save. Each comes back as an outcome the page shows as it is.
 */
import type { BrokerTest, ConfigIssue, ImportApplied, ImportCheck, ReadTest } from "@ot-gateway/api"
import { OtGatewayApi } from "@ot-gateway/api"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { readToken, writeHeaders } from "./editor-api"

const setup = () =>
  HttpApiClient.make(OtGatewayApi, {
    baseUrl: typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders(writeHeaders(readToken())))
  }).pipe(Effect.map((client) => client.setup))

/** What became of a request, for the page. */
export type Outcome<A> =
  | { readonly _tag: "ok"; readonly value: A }
  /** Another test runs, or this one ran a moment ago. */
  | { readonly _tag: "busy"; readonly message: string }
  /** The candidate does not work for this (issues by path), or the upload adds nothing. */
  | { readonly _tag: "invalid"; readonly message: string; readonly issues: ReadonlyArray<ConfigIssue> }
  | { readonly _tag: "conflict"; readonly message: string }
  /** Editing is off, a token is wrong, no answer, or the gateway could not write or apply. */
  | { readonly _tag: "failed"; readonly message: string }

const failed = <A>(message: string): Outcome<A> => ({ _tag: "failed", message })

/** The request with a deadline, every failure left as an outcome. */
const settled = <A>(
  request: Effect.Effect<Outcome<A>, { readonly message: string }, HttpClient.HttpClient>,
  seconds: number
) =>
  request.pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.timeoutOrElse({
      duration: `${seconds} seconds`,
      orElse: () => Effect.succeed(failed<A>(`no answer within ${seconds} s`))
    }),
    Effect.catch((error) => Effect.succeed(failed<A>(error.message))),
    Effect.catchDefect((defect) =>
      Effect.succeed(failed<A>(defect instanceof Error ? defect.message : "unexpected error"))
    )
  )

/** The gateway gives a device test 12 s and a broker test 22 s: the page waits a little longer. */
export const testRead = (text: string, device: number, points?: ReadonlyArray<number>) =>
  settled<ReadTest>(
    setup().pipe(
      Effect.flatMap((client) =>
        client.testRead({ payload: { text, device, ...(points === undefined ? {} : { points }) } })
      ),
      Effect.map((value): Outcome<ReadTest> => ({ _tag: "ok", value })),
      Effect.catchTags({
        TestBusy: (error) => Effect.succeed<Outcome<ReadTest>>({ _tag: "busy", message: error.message }),
        TestInvalid: (error) =>
          Effect.succeed<Outcome<ReadTest>>({ _tag: "invalid", message: error.message, issues: error.issues }),
        EditingDisabled: (error) => Effect.succeed(failed<ReadTest>(error.message))
      })
    ),
    15
  )

export const testBroker = (text: string) =>
  settled<BrokerTest>(
    setup().pipe(
      Effect.flatMap((client) => client.testBroker({ payload: { text } })),
      Effect.map((value): Outcome<BrokerTest> => ({ _tag: "ok", value })),
      Effect.catchTags({
        TestBusy: (error) => Effect.succeed<Outcome<BrokerTest>>({ _tag: "busy", message: error.message }),
        TestInvalid: (error) =>
          Effect.succeed<Outcome<BrokerTest>>({ _tag: "invalid", message: error.message, issues: error.issues }),
        EditingDisabled: (error) => Effect.succeed(failed<BrokerTest>(error.message))
      })
    ),
    25
  )

export const checkImport = (text: string, name: string) =>
  settled<ImportCheck>(
    setup().pipe(
      Effect.flatMap((client) => client.importCheck({ payload: { text, name } })),
      Effect.map((value): Outcome<ImportCheck> => ({ _tag: "ok", value })),
      Effect.catchTags({
        EditingDisabled: (error) => Effect.succeed(failed<ImportCheck>(error.message)),
        ConfigUnreadable: (error) => Effect.succeed(failed<ImportCheck>(error.message))
      })
    ),
    15
  )

/** Adding waits for the gateway to apply the new config, as a save does. */
export const applyImport = (text: string, name: string, etag: string) =>
  settled<ImportApplied>(
    setup().pipe(
      Effect.flatMap((client) => client.importApply({ payload: { text, name, etag } })),
      Effect.map((value): Outcome<ImportApplied> => ({ _tag: "ok", value })),
      Effect.catchTags({
        ImportInvalid: (error) =>
          Effect.succeed<Outcome<ImportApplied>>({ _tag: "invalid", message: error.message, issues: [] }),
        ConfigInvalid: (error) =>
          Effect.succeed<Outcome<ImportApplied>>({
            _tag: "invalid",
            message: "the config would have problems",
            issues: error.issues
          }),
        ConfigConflict: (error) => Effect.succeed<Outcome<ImportApplied>>({ _tag: "conflict", message: error.message }),
        EditingDisabled: (error) => Effect.succeed(failed<ImportApplied>(error.message)),
        ConfigUnreadable: (error) => Effect.succeed(failed<ImportApplied>(error.message)),
        ConfigWriteFailed: (error) => Effect.succeed(failed<ImportApplied>(error.message)),
        ConfigApplyFailed: (error) => Effect.succeed(failed<ImportApplied>(error.message))
      })
    ),
    30
  )
