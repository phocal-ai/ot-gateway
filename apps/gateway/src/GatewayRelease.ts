/**
 * Which release the running gateway is, for a CLI that may be newer: the CLI reads gateways of the previous minor
 * release (docs/operations.md). The status says the gateway's version (`host.version`: the release tag, or a `git
 * describe`); what an older gateway does not serve yet (`/api/events`, `/api/messages/window` before v0.13) is then
 * left out of a report, or refused in words that name both versions, instead of failing as an answer that does not
 * decode.
 */
import type { GatewayStatus } from "@ot-gateway/api"
import { Schema } from "effect"

/** A release as numbers, to compare: `v0.12.0` is `[0, 12, 0]`. */
export type Release = readonly [major: number, minor: number, patch: number]

/**
 * The release a version names: `v0.12.0`, `0.13.1`, a `git describe` such as `v0.12.0-5-gabc1234` (the release it
 * builds on). Undefined for any other build (`dev`, a commit, `unknown`), which counts as current.
 */
export const parseRelease = (version: string): Release | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

const compareReleases = (left: Release, right: Release) =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2]

/** The release that first served `/api/events` and `/api/messages/window`. */
export const EVENTS_RELEASE: Release = [0, 13, 0]

/** The gateway's version from its status: absent before the host monitor's first sample, taken as it starts. */
export const gatewayVersionOf = (status: Pick<GatewayStatus, "host">) => status.host?.version

/** Whether `version` is a release before `release`. A build that names no release, or none known, is not. */
export const isBefore = (version: string | undefined, release: Release) => {
  const parsed = version === undefined ? undefined : parseRelease(version)
  return parsed !== undefined && compareReleases(parsed, release) < 0
}

/** Whether the gateway of `status` serves `/api/events` (and `/api/messages/window`). */
export const servesEvents = (status: Pick<GatewayStatus, "host">) => !isBefore(gatewayVersionOf(status), EVENTS_RELEASE)

/** A version as the CLI names it: `v0.12.0` for a release (with the `v` added to a bare number), else as it is. */
export const versionName = (version: string) => (/^\d+\.\d/.test(version) ? `v${version}` : version)

/** The gateway runs an older release than this command needs. */
export class GatewayTooOld extends Schema.TaggedError<GatewayTooOld>()("GatewayTooOld", {
  url: Schema.String,
  message: Schema.String
}) {}

/**
 * Both versions and the two ways out: `this gateway runs v0.12.0, the CLI is v0.13.0: …`. `what` is what needs the
 * newer gateway (`events`), `release` the release that brought it.
 */
export const tooOldMessage = (options: {
  readonly gatewayVersion: string
  readonly cliVersion: string
  readonly what: string
  readonly release: Release
}) => {
  const gateway = versionName(options.gatewayVersion)
  const parsed = parseRelease(options.gatewayVersion)
  const pinned = parsed === undefined ? "" : ` (npx ot-gateway@${parsed.join(".")})`
  return `this gateway runs ${gateway}, the CLI is ${versionName(options.cliVersion)}: ${options.what} needs a gateway of v${options.release.join(".")} or later. Upgrade the gateway, or run the CLI at ${gateway}${pinned}`
}
