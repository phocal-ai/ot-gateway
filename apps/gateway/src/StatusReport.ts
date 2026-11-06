/**
 * `ot-gateway status`: the running gateway's status page as text, through the same typed client and schema
 * the page uses. One line for the gateway and its broker, one per device.
 */
import { type GatewayStatus, OtGatewayApi } from "@ot-gateway/api"
import { Console, Effect, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { printJson } from "./Output.ts"

export class GatewayUnreachable extends Schema.TaggedError<GatewayUnreachable>()("GatewayUnreachable", {
  url: Schema.String,
  message: Schema.String
}) {}

/** `12 s`, `4 min`, `3 h`, `2 d`: how long ago, as coarse as a glance needs. */
export const ago = (milliseconds: number) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 120) return `${seconds} s`
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`
  return `${Math.round(seconds / 86_400)} d`
}

/** The report: the gateway, its broker and buffer, then one aligned line per device. */
export const formatStatus = (status: GatewayStatus) => {
  const width = Math.max(0, ...status.devices.map((device) => device.id.length))
  const failing = status.devices.filter((device) => device.status === "failing").length
  return [
    `${status.site}/${status.building} gateway ${status.id}, up ${ago(status.now - status.since)}`,
    `  broker ${status.broker.url}: ${status.broker.connected ? "connected" : "NOT CONNECTED"}`,
    ...(status.buffer === undefined
      ? []
      : [
          `  buffer: ${status.buffer.rows} of ${status.buffer.maxRows} message(s) waiting` +
            (status.buffer.dropped > 0 ? `, ${status.buffer.dropped} DROPPED since start` : "")
        ]),
    `  ${status.devices.length} device(s)${failing > 0 ? `, ${failing} failing` : ""}`,
    ...status.devices.map((device) => {
      const lastRead =
        device.lastSuccess === undefined ? "no read yet" : `read ${ago(status.now - device.lastSuccess)} ago`
      const reason = device.reason === undefined ? "" : ` (${device.reason})`
      return `    ${device.id.padEnd(width)}  ${device.status.padEnd(8)} ${device.protocol}, ${device.points.length} point(s), ${lastRead}${reason}`
    })
  ].join("\n")
}

const advice =
  "Is the gateway running (ot-gateway run, or ot-gateway demo)? If its status page is elsewhere, pass --url."

/** The status from the gateway at `url`, within three seconds. */
export const fetchGatewayStatus = (url: string) =>
  HttpApiClient.make(OtGatewayApi, { baseUrl: url }).pipe(
    Effect.flatMap((client) => client.status.status()),
    Effect.provide(FetchHttpClient.layer),
    // Unreachable, a timeout or an answer that does not decode: the same advice for each.
    Effect.mapError(
      (error) => new GatewayUnreachable({ url, message: `no gateway status at ${url} (${error.message}). ${advice}` })
    ),
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () =>
        Effect.fail(new GatewayUnreachable({ url, message: `no gateway status at ${url} within 3 s. ${advice}` }))
    })
  )

/** Prints the report for the gateway at `url`. */
export const statusReport = Effect.fn("statusReport")(function* (
  url: string,
  options: { readonly json?: boolean } = {}
) {
  const status = yield* fetchGatewayStatus(url)
  // --json: the status page's own /api/status answer, as checked against its contract.
  yield* options.json === true ? printJson(status) : Console.log(formatStatus(status))
})
