/**
 * Which running gateway `status`, `events` and `history` ask: the one the config describes. Its status block
 * (`bindAddress` and `port`) gives the address, and its site, building and id say which gateway should answer
 * there, so a second gateway on the same machine or a stale port forward is named instead of reported on.
 * `--url` asks elsewhere; the config, when one was named, still says which gateway is expected.
 */
import type { GatewayConfig, StatusSettings } from "@ot-gateway/core"
import { Effect, FileSystem, Schema } from "effect"
import { defaultConfigPath } from "./Import.ts"
import { loadConfig } from "./LoadConfig.ts"

/** Where a gateway's status page is when neither a config nor `--url` says. */
export const DEFAULT_STATUS_URL = "http://127.0.0.1:8080"

/** The gateway that should answer: from the config at `path`. */
export interface ExpectedGateway {
  readonly path: string
  readonly site: string
  readonly building: string
  readonly id: string
}

export interface GatewayTarget {
  readonly url: string
  /** Absent when no config was named and none is in this folder: then whoever answers at `url` is reported. */
  readonly expected?: ExpectedGateway | undefined
}

/** The config names no status page, so there is nothing to ask. */
export class NoStatusPage extends Schema.TaggedError<NoStatusPage>()("NoStatusPage", {
  path: Schema.String,
  message: Schema.String
}) {}

/** Another gateway than the config's answered: its report would describe the wrong building. */
export class GatewayMismatch extends Schema.TaggedError<GatewayMismatch>()("GatewayMismatch", {
  url: Schema.String,
  message: Schema.String
}) {}

/**
 * The status page's address from a config's status block, as seen from the same machine: a page bound to every
 * interface (`0.0.0.0`) is asked on loopback.
 */
export const statusUrlOf = (settings: StatusSettings) =>
  `http://${settings.bindAddress === "0.0.0.0" ? "127.0.0.1" : settings.bindAddress}:${settings.port}`

/** The target for a config already read from `path`, with `url` instead of its status block when given. */
export const targetOf = (path: string, config: GatewayConfig, url: string | undefined) =>
  Effect.gen(function* () {
    const expected = { path, site: config.site, building: config.building, id: config.id }
    if (url !== undefined) return { url, expected }
    if (config.status === undefined) {
      return yield* new NoStatusPage({
        path,
        message: `${path} has no status block, so its gateway serves no status page or API to ask. Add "status": {} to it and restart the gateway, or pass --url`
      })
    }
    return { url: statusUrlOf(config.status), expected }
  })

/**
 * The gateway to ask: `config` when named; else `--url` alone when given; else `ot-gateway.json` in this folder
 * when there is one; else `DEFAULT_STATUS_URL`, with nobody expected.
 */
export const resolveTarget = Effect.fn("resolveTarget")(function* (options: {
  readonly config?: string | undefined
  readonly url?: string | undefined
}) {
  const fs = yield* FileSystem.FileSystem
  if (options.config === undefined) {
    if (options.url !== undefined) return { url: options.url } satisfies GatewayTarget
    const here = yield* fs.exists(defaultConfigPath).pipe(Effect.orElseSucceed(() => false))
    if (!here) return { url: DEFAULT_STATUS_URL } satisfies GatewayTarget
  }
  const path = options.config ?? defaultConfigPath
  const config = yield* loadConfig(path)
  return yield* targetOf(path, config, options.url)
})

/** `s/b gateway main`: how the CLI names a gateway. */
export const gatewayName = (gateway: { readonly site: string; readonly building: string; readonly id: string }) =>
  `${gateway.site}/${gateway.building} gateway ${gateway.id}`

/** Fails with `GatewayMismatch` when the gateway that answered is not the one the config describes. */
export const checkIdentity = (
  target: GatewayTarget,
  found: { readonly site: string; readonly building: string; readonly id: string }
) => {
  const expected = target.expected
  if (
    expected === undefined ||
    (expected.site === found.site && expected.building === found.building && expected.id === found.id)
  ) {
    return Effect.void
  }
  return Effect.fail(
    new GatewayMismatch({
      url: target.url,
      message: `WRONG GATEWAY: ${target.url} is ${gatewayName(found)}, but ${expected.path} describes ${gatewayName(expected)}. Another gateway answers on that address: is this config's gateway running, and does its status port differ from the other's? To report on whichever gateway answers there, pass --url and no config.`
    })
  )
}
