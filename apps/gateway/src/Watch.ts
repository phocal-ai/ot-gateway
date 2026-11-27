/**
 * `ot-gateway watch`: what the gateway publishes, as it arrives at the broker in the config. It subscribes to
 * `site/building/#` (or a filter of its own) with a client id of its own, so it runs next to the gateway, and
 * prints one line per message: the time, `retained` for what the broker kept, the topic and the payload. With
 * `--json` the line is a JSON object (NDJSON), for scripts and agents. When the broker connection breaks, a line
 * says so, and another when it is back (`{"event":"broker-disconnected"}`, `{"event":"broker-connected"}`).
 *
 * A retained message the broker keeps from another gateway, or for a device or point the config does not have
 * (an old config's, say), is marked with whose it is (`"stale"` in JSON), and the first one prints, once, how to
 * clear it: `ot-gateway publish <topic> --retain`.
 *
 * With `--check` it checks every message under the config's site and building against the MQTT contract instead
 * (`ot-gateway contract`), with the same strict decode the gateway's own tests use, and prints only the ones off it,
 * each with what is wrong; a watch that ends by itself then fails when one was.
 */
import {
  contractMessageOf,
  contractMessages,
  contractTopics,
  contractVersion,
  covPointIds,
  decodeContractMessage,
  type ContractMessage,
  type Device,
  type GatewayConfig,
  monotonicMillis,
  publishOf,
  windowIntervalMs
} from "@ot-gateway/core"
import { type InboundMessage, topicMatches } from "@ot-gateway/mqtt"
import { Console, Deferred, Duration, Effect, Exit, Schema } from "effect"
import { BrokerCommandError, brokerClient, firstDialOf } from "./Broker.ts"
import { configIssues } from "./ConfigStore.ts"
import { withoutControls } from "./Discover.ts"
import { localTime, printResult } from "./Output.ts"
import { metaGateway } from "./StaleMeta.ts"
import { ago } from "./StatusReport.ts"
import { count, firstOf, named, plural } from "./Words.ts"

/** Payloads are cut here on the terminal; the status page and any MQTT client show them whole. */
const MAX_PAYLOAD = 300

/** Everything under the config's site and building: values, `$meta`, the gateway's health and command results. */
export const watchFilter = (config: Pick<GatewayConfig, "site" | "building">) => `${config.site}/${config.building}/#`

/** What `stale` reads of a config: the gateway's id, where it publishes, and its devices and points. */
export type WatchedConfig = Pick<GatewayConfig, "id" | "site" | "building"> & {
  readonly devices: ReadonlyArray<{ readonly id: string; readonly points: ReadonlyArray<{ readonly id: string }> }>
}

/**
 * Why a retained message is not the running gateway's, in a few words: `from gateway b`, `not in this config`. Only
 * under the config's site and building (another filter's topics cannot be told apart); undefined for a live
 * message, an empty one (that clears a topic) and everything the config has.
 */
export const staleReason = (
  config: WatchedConfig,
  message: Pick<InboundMessage, "topic" | "payload" | "retain">
): string | undefined => {
  if (!message.retain || message.payload === "") return undefined
  const [site, building, device, point, ...rest] = message.topic.split("/")
  if (site !== config.site || building !== config.building || device === undefined) return undefined
  // `site/building/$gateway/<id>/health`: the health of a gateway, maybe one long gone.
  if (device === "$gateway") return point === config.id ? undefined : `from gateway ${point ?? ""}`
  const owner = rest[0] === "$meta" ? metaGateway(message.payload) : undefined
  if (owner !== undefined && owner !== config.id) return `from gateway ${owner}`
  const configured = config.devices.find((candidate) => candidate.id === device)
  if (configured === undefined) return "device not in this config"
  if (point !== undefined && !configured.points.some((candidate) => candidate.id === point)) {
    return "point not in this config"
  }
  return undefined
}

/** Printed once, at the first stale retained message. */
export const clearHint =
  "-- marked retained messages are kept by the broker from another gateway or an older config; if nothing needs them, clear one with: ot-gateway publish <topic> --retain"

/**
 * One line for a message: local time, a retained marker (with why it is stale, if it is), the topic and the payload
 * on one line. Anyone who may publish to the broker chooses the topic and the payload, so their control characters
 * never reach the terminal: line breaks and tabs become a space, the rest `?`.
 */
export const formatMessage = (
  message: Pick<InboundMessage, "topic" | "payload" | "retain">,
  at: Date,
  stale?: string
) => {
  const time = localTime(at)
  const flat = withoutControls(message.payload.replace(/\s*\n\s*/g, " ").replace(/[\t\r]/g, " "))
  const payload = flat.length > MAX_PAYLOAD ? `${flat.slice(0, MAX_PAYLOAD)}…` : flat
  const retained = message.retain ? (stale === undefined ? "retained " : `retained (${withoutControls(stale)}) `) : ""
  return `${time} ${retained}${withoutControls(message.topic)} ${payload}`
}

/**
 * One message as a JSON line: the payload parsed when it is JSON, as the gateway's own messages are, whole. With
 * `--check`, `contract` says which message it should be and what is wrong with it.
 */
export const messageRecord = (
  message: Pick<InboundMessage, "topic" | "payload" | "retain">,
  at: Date,
  stale?: string,
  contract?: ContractViolation
) => {
  let payload: unknown = message.payload
  try {
    payload = JSON.parse(message.payload)
  } catch {
    // Not JSON (a plain MQTT client's message): kept as the string it is.
  }
  return JSON.stringify({
    at: at.toISOString(),
    topic: message.topic,
    retained: message.retain,
    ...(stale === undefined ? {} : { stale }),
    ...(contract === undefined ? {} : { contract }),
    payload
  })
}

/** A message off the contract: which message its topic says it is, and every mistake, with where it is. */
export interface ContractViolation {
  readonly message: ContractMessage
  readonly issues: ReadonlyArray<{ readonly path?: string; readonly message: string }>
}

/** The contract messages that are retained: an empty payload on their topics clears what the broker kept. */
const retainedMessages = new Set(contractTopics.filter((topic) => topic.retained).map((topic) => topic.message))

/**
 * Checks one message against the contract, strictly (a field the contract does not have is a mistake too): what
 * is wrong with it, `"ok"` when nothing is, or undefined when it is not the contract's to check. That is a topic
 * outside the config's site and building (another application's) or one no contract message has (the broker
 * check's `$gateway/<id>/check/…`). An empty payload on a retained message's topic clears it, which is allowed.
 */
export const contractViolation = (
  config: Pick<GatewayConfig, "site" | "building">,
  message: Pick<InboundMessage, "topic" | "payload">
): ContractViolation | "ok" | undefined => {
  const [site, building] = message.topic.split("/")
  if (site !== config.site || building !== config.building) return undefined
  const kind = contractMessageOf(message.topic)
  if (kind === undefined) return undefined
  if (message.payload === "" && retainedMessages.has(kind)) return "ok"
  if (Exit.isSuccess(decodeContractMessage(kind, message.payload))) return "ok"
  // A message with several forms (a value, sample or aggregate; health, online or offline) is measured against the
  // form it comes closest to: the mistakes of every form at once would mostly be about the forms it is not.
  const schema = contractMessages[kind]
  const forms: ReadonlyArray<Schema.Codec<unknown, unknown>> = "members" in schema ? schema.members : [schema]
  const candidates = forms.map((form) => {
    const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(form), {
      onExcessProperty: "error",
      errors: "all"
    })(message.payload)
    const error = Exit.findErrorOption(decoded)
    return error._tag === "Some"
      ? configIssues(error.value.issue).map((issue) =>
          issue.path.length === 0 ? { message: issue.message } : { path: issue.path.join("."), message: issue.message }
        )
      : []
  })
  const closest = candidates.reduce((best, issues) => (issues.length < best.length ? issues : best))
  return { message: kind, issues: closest.length === 0 ? [{ message: "does not decode" }] : closest }
}

/** What is wrong with a message, on one line: `value: ts: Expected an integer, got 1.5`. */
export const describeViolation = (violation: ContractViolation) =>
  `off contract (${violation.message}): ${violation.issues
    .map((issue) => withoutControls(issue.path === undefined ? issue.message : `${issue.path}: ${issue.message}`))
    .join("; ")}`

/** How many messages `--check` looked at, and how many were off the contract. */
export interface ContractSummary {
  readonly event: "contract"
  readonly version: string
  readonly checked: number
  readonly off: number
}

/** `-- 120 messages checked against the MQTT contract 1.0: 2 off it`. */
export const formatContractSummary = (summary: ContractSummary) =>
  `-- ${plural(summary.checked, "message")} checked against the MQTT contract ${summary.version}: ${summary.off === 0 ? "all on it" : `${summary.off} off it`}`

/**
 * What arrived for one device's points: the configured points that sent a value, the ones that did not, and the
 * ones that did not but send only when their value changes (`onChange`), which a quiet building leaves silent.
 */
export interface DeviceArrivals {
  readonly id: string
  readonly arrived: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
  readonly onChange: ReadonlyArray<string>
}

/**
 * When a point's next value is due at the latest: undefined when it sends only on a change (change mode without
 * `maxSilenceMs`, or asked for by BACnet COV), else its device's poll interval, after its publish window or its
 * `maxSilenceMs` when it has one.
 */
export const valueDueMs = (device: Device, point: Device["points"][number]): number | undefined => {
  if (covPointIds(device).includes(point.id)) return undefined
  const publish = publishOf(device.publish, point)
  // A resend after maxSilenceMs, or a window's value, goes out with the first read after it: up to a poll later.
  if (publish.mode === "change") {
    return publish.maxSilenceMs === undefined ? undefined : publish.maxSilenceMs + device.pollIntervalMs
  }
  const window = windowIntervalMs(publish)
  return window === undefined ? device.pollIntervalMs : window + device.pollIntervalMs
}

/**
 * The configured points a watch looks for: every point whose topic its filter covers. A value is a live message
 * (not retained: that may be an older run's) with a payload, on `site/building/device/point`.
 */
export const pointArrivals = (config: GatewayConfig, filter: string) => {
  const expected = config.devices.map((device) => {
    const covered = device.points.filter((point) =>
      topicMatches(filter, `${config.site}/${config.building}/${device.id}/${point.id}`)
    )
    return {
      id: device.id,
      points: covered.map((point) => point.id),
      due: new Map(covered.map((point) => [point.id, valueDueMs(device, point)]))
    }
  })
  const arrived = new Map(expected.map((device) => [device.id, new Set<string>()]))
  const awaited = expected.flatMap((device) =>
    device.points.filter((point) => device.due.get(point) !== undefined).map((point) => `${device.id}/${point}`)
  )
  const pending = new Set(awaited)
  return {
    /** Whether the filter covers any configured point at all; a watch of other topics has nothing to report. */
    expects: expected.some((device) => device.points.length > 0),
    /** The longest a covered point that sends on a timer can take, or undefined when none does. */
    slowestDueMs: expected.reduce<number | undefined>(
      (slowest, device) =>
        [...device.due.values()].reduce<number | undefined>(
          (max, due) => (due === undefined ? max : Math.max(max ?? 0, due)),
          slowest
        ),
      undefined
    ),
    /** Records a message; true once every point that sends on a timer has sent a value, and some point has. */
    record: (message: Pick<InboundMessage, "topic" | "payload" | "retain">) => {
      if (message.retain || message.payload === "") return false
      const [site, building, device, point, ...rest] = message.topic.split("/")
      if (site !== config.site || building !== config.building || rest.length > 0) return false
      if (device === undefined || point === undefined) return false
      const configured = expected.find((candidate) => candidate.id === device)
      if (configured === undefined || !configured.points.includes(point)) return false
      arrived.get(device)?.add(point)
      pending.delete(`${device}/${point}`)
      // With only points that send on change, the first value of any of them is what there is to wait for.
      return pending.size === 0
    },
    devices: (): ReadonlyArray<DeviceArrivals> =>
      expected
        .filter((device) => device.points.length > 0)
        .map((device) => {
          const points = arrived.get(device.id) ?? new Set<string>()
          const silent = device.points.filter((point) => !points.has(point))
          return {
            id: device.id,
            arrived: device.points.filter((point) => points.has(point)),
            missing: silent.filter((point) => device.due.get(point) !== undefined),
            onChange: silent.filter((point) => device.due.get(point) === undefined)
          }
        })
  }
}

/** The last line of a watch that ended by itself: how many configured points sent a value, and which did not. */
export interface WatchSummary {
  readonly event: "summary"
  readonly seconds: number
  readonly messages: number
  readonly points: number
  readonly arrived: number
  readonly missing: number
  readonly devices: ReadonlyArray<DeviceArrivals>
}

export const watchSummary = (
  devices: ReadonlyArray<DeviceArrivals>,
  seconds: number,
  messages: number
): WatchSummary => {
  const total = (pick: (device: DeviceArrivals) => ReadonlyArray<string>) =>
    devices.reduce((sum, device) => sum + pick(device).length, 0)
  const arrived = total((device) => device.arrived)
  const missing = total((device) => device.missing)
  const points = arrived + missing + total((device) => device.onChange)
  return { event: "summary", seconds, messages, points, arrived, missing, devices }
}

/**
 * The summary on the terminal: `-- 6 of 8 points sent a value in 10 s (20 messages); none from heat-pump:
 * flow-temp; on change only, unchanged so far: heat-pump: running`.
 */
export const formatSummary = (summary: WatchSummary) => {
  // A few devices by name, each with its first points, or `all` of them: a site of 300 devices stays one line.
  const list = (pick: (device: DeviceArrivals) => ReadonlyArray<string>) => {
    const entries = summary.devices
      .filter((device) => pick(device).length > 0)
      .map((device) => {
        const picked = pick(device)
        const every =
          picked.length > 1 && picked.length === device.arrived.length + device.missing.length + device.onChange.length
        return every ? `${device.id}: all ${count(picked.length)}` : `${device.id}: ${named(picked, 3)}`
      })
    const { shown, more } = firstOf(entries)
    return [...shown, ...(more > 0 ? [`and ${plural(more, "more device")}`] : [])].join("; ")
  }
  const missing = list((device) => device.missing)
  const quiet = list((device) => device.onChange)
  return [
    `-- ${count(summary.arrived)} of ${plural(summary.points, "point")} sent a value in ${summary.seconds} s (${plural(summary.messages, "message")})`,
    ...(missing === "" ? [] : [`none from ${missing}`]),
    ...(quiet === "" ? [] : [`on change only, unchanged so far: ${quiet}`])
  ].join("; ")
}

/**
 * How long `--until-values` waits without `--seconds`: the slowest point that sends on a timer and half a minute
 * more, at least a minute, so a device read every five minutes is not called missing after one.
 */
export const untilValuesSeconds = (slowestDueMs: number | undefined) =>
  Math.max(60, Math.ceil((slowestDueMs ?? 0) / 1000) + 30)

export interface WatchOptions {
  /** A topic filter instead of the config's site and building (`#` for everything on the broker). */
  readonly topic?: string | undefined
  /** Stop after this many seconds instead of at Ctrl-C: for scripts and agents, which cannot press it. */
  readonly seconds?: number | undefined
  /** One JSON object per line on stdout (`messageRecord`) instead of the terminal's lines. */
  readonly json?: boolean | undefined
  /**
   * Stop as soon as every configured point under the filter sent a value, or fail when one has not within
   * `seconds` (or `untilValuesSeconds`): for an agent checking that a new gateway's values arrive.
   */
  readonly untilValues?: boolean | undefined
  /**
   * Check every message under the config's site and building against the MQTT contract and print only those off
   * it (`contractViolation`); a watch that ends by itself fails when one was (`off-contract`), or when none
   * arrived to check (`nothing-checked`).
   */
  readonly check?: boolean | undefined
}

/**
 * Prints the broker's messages until interrupted (Ctrl-C) or for `seconds`, reconnecting as the gateway does.
 * The CLI runs in a container without Node on the machine, where killing the docker client leaves the
 * container running: a watch that ends by itself needs no one to stop it. With `seconds` a first dial that fails
 * fails the watch (`BrokerCommandError`), so "never connected" does not look like "connected, nothing arrived";
 * without, someone is watching and it keeps trying.
 */
export const watch = Effect.fn("watch")(function* (config: GatewayConfig, options: WatchOptions = {}) {
  const filter = options.topic ?? watchFilter(config)
  const json = options.json === true
  /** Whether the watch has had a connection, and while it has none since then: since when (monotonic) and why. */
  let everConnected = false
  let away: { readonly since: number; readonly at: Date; readonly error: string } | undefined
  let hinted = false
  let messages = 0
  const arrivals = pointArrivals(config, filter)
  const allArrived = yield* Deferred.make<void>()
  const untilValues = options.untilValues === true
  const check = options.check === true
  let checked = 0
  let offContract = 0
  if (untilValues && !arrivals.expects) {
    return yield* new WatchError({
      message: `${filter} covers none of the config's points, so --until-values has nothing to wait for`,
      hint: "leave out --topic, or name a filter under the config's site and building",
      code: "nothing-to-wait-for"
    })
  }
  const seconds = options.seconds ?? (untilValues ? untilValuesSeconds(arrivals.slowestDueMs) : undefined)
  const say = (record: BrokerRecord, at: Date) =>
    json ? printResult(brokerRecordLine(record, at)) : Console.log(formatBrokerRecord(record, at))
  const client = yield* brokerClient(config.mqtt, "watch", {
    subscriptions: [{ filter, qos: 0, retainAsPublished: true }],
    onConnect: () =>
      Effect.gen(function* () {
        const was = away
        away = undefined
        if (everConnected && was !== undefined) {
          const downMs = (yield* monotonicMillis) - was.since
          yield* say({ event: "broker-connected", downMs }, new Date())
          return
        }
        everConnected = true
        yield* Console.error(
          `${check ? `checking ${filter} against the MQTT contract ${contractVersion}, printing only what is off it,` : `watching ${filter}`} on ${config.mqtt.url} (${seconds === undefined ? "Ctrl-C to stop" : untilValues ? `until every point sent a value, at most ${seconds} s` : `for ${seconds} s`})`
        )
      }),
    // Every failed redial calls this; only the first of an outage is printed. Before the first connect, `--seconds`
    // fails on the first dial anyway, and without it the client's own warning says why it keeps trying.
    onDisconnected: (failure) =>
      Effect.gen(function* () {
        if (away !== undefined || !everConnected) return
        const at = new Date()
        away = { since: yield* monotonicMillis, at, error: failure.error }
        yield* say({ event: "broker-disconnected", error: failure.error }, at)
      }),
    onMessage: (message) =>
      Effect.gen(function* () {
        const stale = staleReason(config, message)
        const at = new Date()
        messages += 1
        const violation = check ? contractViolation(config, message) : undefined
        if (violation !== undefined) checked += 1
        const off = violation !== undefined && violation !== "ok"
        if (off) offContract += 1
        // With --check only the messages off the contract are printed, and only theirs need the hint below.
        const printed = !check || off
        if (!check) {
          yield* json ? printResult(messageRecord(message, at, stale)) : Console.log(formatMessage(message, at, stale))
        } else if (off) {
          yield* json
            ? printResult(messageRecord(message, at, stale, violation))
            : Console.log(`${formatMessage(message, at, stale)}\n  ${describeViolation(violation)}`)
        }
        // After the message is out, so the summary that this may end the watch with comes after it.
        if (arrivals.record(message)) yield* Deferred.succeed(allArrived, undefined)
        if (stale !== undefined && printed && !hinted) {
          hinted = true
          yield* Console.error(clearHint)
        }
      })
  })
  yield* Console.error(`connecting to ${config.mqtt.url}…`)
  if (seconds === undefined) return yield* Effect.never
  yield* firstDialOf(client, config.mqtt)
  // From the connection on, as the deadline counts: the dial has a timeout of its own.
  const started = yield* monotonicMillis
  const deadline = Effect.sleep(Duration.seconds(seconds))
  yield* untilValues ? Effect.raceFirst(Deferred.await(allArrived), deadline) : deadline
  // A watch that ends without its broker saw only part of the time it was asked for: say so with the exit code.
  const lost = away
  if (lost !== undefined) {
    return yield* new BrokerCommandError({
      message: `lost ${config.mqtt.url} at ${localTime(lost.at)} and it did not come back: ${lost.error}`,
      code: "broker-lost",
      hint: "the broker or the network went away during the watch: ot-gateway broker checks the connection"
    })
  }
  // The points' summary first, then the contract's: with --check, the last line before a failure is the contract's.
  const elapsed = Math.round(((yield* monotonicMillis) - started) / 1000)
  const summary = arrivals.expects ? watchSummary(arrivals.devices(), elapsed, messages) : undefined
  if (summary !== undefined) {
    yield* json ? printResult(JSON.stringify(summary)) : Console.log(formatSummary(summary))
  }
  if (check) {
    const checkedSummary: ContractSummary = { event: "contract", version: contractVersion, checked, off: offContract }
    yield* json ? printResult(JSON.stringify(checkedSummary)) : Console.log(formatContractSummary(checkedSummary))
  }
  const offLine = `${count(offContract)} of ${plural(checked, "message")} under ${config.site}/${config.building} were off the MQTT contract ${contractVersion}`
  // Points that send only on change may stay quiet, but not every one of them: then nothing shows the gateway works.
  const nothing = summary !== undefined && summary.arrived === 0
  if (untilValues && summary !== undefined && (summary.missing > 0 || nothing)) {
    const silent = (device: DeviceArrivals) => (nothing ? [...device.missing, ...device.onChange] : device.missing)
    const missingLine = nothing
      ? `no point sent a value within ${seconds} s`
      : `${count(summary.missing)} of ${plural(summary.points, "point")} sent no value within ${seconds} s`
    // Missing values win the code, since they are what to fix first; the message still says the contract was broken.
    return yield* new WatchError({
      message: check && offContract > 0 ? `${missingLine}; and ${offLine}` : missingLine,
      code: "values-missing",
      missing: summary.devices.flatMap((device) => silent(device).map((point) => `${device.id}/${point}`)),
      hint: "ot-gateway status says why a device fails (it must be running: ot-gateway run, or docker compose up -d); a point that never changes and publishes on change only sends its first value at start"
    })
  }
  if (check && offContract > 0) {
    return yield* new WatchError({
      message: offLine,
      code: "off-contract",
      hint: "each one is printed with what is wrong; ot-gateway contract <message> lists the fields. A gateway newer than this CLI may send fields a later contract version added: compare the contract in its health message"
    })
  }
  // A check of nothing is no pass: the gateway is not running, or --topic is outside the site and building.
  if (check && checked === 0) {
    return yield* new WatchError({
      message: `no message under ${config.site}/${config.building} arrived within ${seconds} s, so nothing was checked against the MQTT contract`,
      code: "nothing-checked",
      hint: "is the gateway running (ot-gateway status)? --check looks only at topics under the config's site and building; the gateway's retained $meta and health arrive at once when it has published them"
    })
  }
}, Effect.scoped)

/**
 * A `watch --until-values` that has nothing to wait for, or whose points did not all send a value in time; or a
 * `watch --check` that saw a message off the contract, or no message to check at all.
 */
export class WatchError extends Schema.TaggedError<WatchError>()("WatchError", {
  message: Schema.String,
  code: Schema.Literals(["nothing-to-wait-for", "values-missing", "off-contract", "nothing-checked"]),
  missing: Schema.optionalKey(Schema.Array(Schema.String)),
  hint: Schema.optionalKey(Schema.String)
}) {}

/** What `watch` says about its own connection, between the messages. */
export type BrokerRecord =
  | { readonly event: "broker-disconnected"; readonly error: string }
  | { readonly event: "broker-connected"; readonly downMs: number }

/** The line `watch` prints when it loses or regains the broker: local time, then what happened. */
export const formatBrokerRecord = (record: BrokerRecord, at: Date) =>
  record.event === "broker-disconnected"
    ? `${localTime(at)} -- lost the broker: ${withoutControls(record.error)}; reconnecting`
    : `${localTime(at)} -- broker back after ${ago(record.downMs)}`

/** The same as a JSON line for `--json`, next to the messages': `at`, then the event. */
export const brokerRecordLine = (record: BrokerRecord, at: Date) => JSON.stringify({ at: at.toISOString(), ...record })
