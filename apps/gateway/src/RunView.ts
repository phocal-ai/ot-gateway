/**
 * `ot-gateway run` for a person at a terminal: a short overview once the gateway has settled (the broker, each
 * device, the status page, how to stop), then a line for each change that matters, as `ot-gateway events` words it
 * (a device that fails or answers again, the broker that goes away or comes back, an alarm). The log lines behind
 * them are not printed: they stay in the gateway's ring (`ot-gateway logs`, the status page), and `run --verbose`,
 * Docker, a pipe and an agent get them on stderr as before.
 */
import type { DeviceStatus, GatewayStatus } from "@ot-gateway/api"
import { type GatewayConfig, monotonicMillis } from "@ot-gateway/core"
import { Cause, Console, Effect, Logger } from "effect"
import type { GatewayEventsShape } from "./Events.ts"
import type { StatusState } from "./Status.ts"
import { allEvents, type AnyEvent, eventLine } from "./StatusReport.ts"
import type { Ui } from "./Ui.ts"

/** What the view reads from the running gateway: its events, and its status when it has a status page. */
export interface RunWatch {
  readonly events: GatewayEventsShape
  readonly status: StatusState | undefined
}

/** How long the overview waits for the broker and every device to answer, or not, before it is printed anyway. */
const SETTLE_MS = 20_000
/** How often the view asks for the status while it settles, and for new events afterwards. */
const SETTLE_POLL = "250 millis"
const EVENT_POLL = "1 second"

/** What the overview shows of the status: the broker and the devices. */
export interface Overview {
  readonly broker: Pick<GatewayStatus["broker"], "url" | "connected" | "lastError">
  readonly devices: ReadonlyArray<Pick<DeviceStatus, "id" | "status" | "pointCount" | "lastError" | "reason">>
}

/** Whether the first answers are in: the broker connected or failed, and no device is still starting. */
export const settled = (status: Overview) =>
  (status.broker.connected || status.broker.lastError !== undefined) &&
  status.devices.every((device) => device.status !== "starting")

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

const deviceLine = (ui: Ui, device: Overview["devices"][number]) => {
  switch (device.status) {
    case "ok":
      return ui.done(`${device.id}: ${plural(device.pointCount, "point")} read`)
    case "failing":
      return ui.failed(`${device.id}: ${device.lastError ?? device.reason ?? "not answering"}`)
    case "starting":
      return ui.todo(`${device.id}: no answer yet`)
  }
}

/** The overview: the broker, each device, then where the status page is and how to stop. */
export const overviewLines = (
  ui: Ui,
  config: {
    readonly site: string
    readonly building: string
    readonly mqtt: { readonly url: string }
    readonly devices: ReadonlyArray<unknown>
  },
  status: Overview | undefined,
  pageUrl: string | undefined
): ReadonlyArray<string> => [
  ...(status === undefined
    ? [
        ui.done(
          `${config.site}/${config.building}: ${plural(config.devices.length, "device")}, broker ${config.mqtt.url}`
        )
      ]
    : [
        status.broker.connected
          ? ui.done(`Broker ${status.broker.url} connected`)
          : ui.failed(`Broker ${status.broker.url}: ${status.broker.lastError ?? "not connected yet"}`),
        ...status.devices.map((device) => deviceLine(ui, device))
      ]),
  ...(config.devices.length === 0 ? [ui.todo("No devices yet: ot-gateway discover finds them")] : []),
  "",
  ui.rows([
    ...(pageUrl === undefined ? [] : [["Status page", ui.command(pageUrl)] as const]),
    ["Topics", `${config.site}/${config.building}/<device>/<point>`] as const,
    ["Stop", "Ctrl-C", "the changes that matter show up below"] as const
  ])
]

/** Whether an event is something that went wrong, came right, or neither. */
const eventKind = (event: AnyEvent): "bad" | "good" | "other" => {
  switch (event.type) {
    case "device-failing":
    case "broker-disconnected":
    case "config-apply-failed":
    case "gateway-conflict":
    case "alarm-raised":
    case "alarm-flapping":
    case "counter-went-back":
    case "counter-jumped":
      return "bad"
    case "device-recovered":
    case "broker-connected":
    case "buffer-drained":
    case "config-applied":
    case "alarm-cleared":
    case "alarm-settled":
      return "good"
    case "gateway-started":
      return "other"
  }
}

/** One change as a line in the column: the symbol says which way it went, the rest is `events`' line. */
export const changeLine = (ui: Ui, event: AnyEvent, now: number) => {
  const text = eventLine(event, now)
  const kind = eventKind(event)
  return kind === "bad" ? ui.failed(text) : kind === "good" ? ui.done(text) : ui.note(text)
}

/** The view, run next to the gateway (`GatewayOptions.watch`): the overview once settled, then the changes. */
export const runView = (ui: Ui, config: GatewayConfig, pageUrl: string | undefined) => (watch: RunWatch) =>
  Effect.gen(function* () {
    let status: GatewayStatus | undefined
    if (watch.status !== undefined) {
      const state = watch.status
      const start = yield* monotonicMillis
      while (true) {
        status = yield* state.snapshot("none", "none")
        if (settled(status) || (yield* monotonicMillis) - start >= SETTLE_MS) break
        yield* Effect.sleep(SETTLE_POLL)
      }
    }
    const shown = yield* watch.events.log()
    let after = allEvents(shown).reduce((newest, event) => Math.max(newest, event.id), 0)
    yield* Console.error(overviewLines(ui, config, status, pageUrl).join("\n"))
    while (true) {
      yield* Effect.sleep(EVENT_POLL)
      const log = yield* watch.events.log({ after })
      for (const event of allEvents(log)) {
        after = Math.max(after, event.id)
        if (event.type !== "gateway-started") yield* Console.error(changeLine(ui, event, log.now))
      }
    }
  })

/**
 * The logger of a run a person watches: errors only, one line each in the column; the rest is in the ring and on
 * the status page, and the view's lines say what changed.
 */
export const humanLogger = (ui: Ui) =>
  Logger.make((options) => {
    if (options.logLevel !== "Error" && options.logLevel !== "Fatal") return
    const parts = Array.isArray(options.message) ? options.message : [options.message]
    const text = parts.map((part) => (typeof part === "string" ? part : String(part))).join(" ")
    const cause = options.cause.reasons.length === 0 ? "" : `: ${Cause.pretty(options.cause).split("\n")[0] ?? ""}`
    globalThis.console.error(ui.failed(`${text}${cause}`))
  })
