/**
 * `ot-gateway write <device/point> <value>`: one guarded command, the way a consumer sends it, and its outcome. It
 * finds the point in the config, so nobody types a topic, checks the value as the gateway's command guard will
 * (type and `limits`), sends `{"value": …}` live on `site/building/device/point/$set` with correlation data of its
 * own, and waits for the gateway's answer on `…/$set/result`. It exits 0 when the device took the write and 1
 * otherwise, with a `code` (the guard's reason, the driver's, or `no-result`), a `hint`, what to do next, and
 * `written`: false when no device saw it, "unknown" when it may have.
 *
 * The result topic is subscribed before the command goes out, and a message to a topic of its own on the same
 * subscription comes back first, so the broker is known to deliver results before anything is sent. MQTT 3.1.1 has
 * no correlation data: there the first result on the point's topic after the command is taken as its answer.
 *
 * The local checks read the config named here, and the gateway checks against the one it runs, which is the one
 * that counts: a point made writable on the status page and not yet in the file is refused here first.
 */
import {
  type AnyPoint,
  type Device,
  type GatewayConfig,
  monotonicMillis,
  pointTopic,
  valueRejection,
  writeKind,
  type WriteValue
} from "@ot-gateway/core"
import { unitLabel } from "@ot-gateway/api"
import type { InboundMessage } from "@ot-gateway/mqtt"
import { Deferred, Duration, Effect, Option, Random, Schema } from "effect"
import { BrokerCommandError, brokerClient, firstDialOf } from "./Broker.ts"

/**
 * Why a write did not happen, for scripts and agents. The guard's reasons (`unknown-point`, `not-writable`,
 * `wrong-type`, `out-of-range`, …: nothing reached the device), the driver's (`timeout`: the device did not answer
 * in time and may have applied it; `connection`, `protocol`, …) and `device-unavailable`, and `no-result`: no
 * gateway answered in time, so whether it was applied is unknown.
 */
export class WriteFailed extends Schema.TaggedError<WriteFailed>()("WriteFailed", {
  message: Schema.String,
  code: Schema.String,
  hint: Schema.String,
  /** Whether the device may have applied it: false when it was refused before any write. */
  written: Schema.Union([Schema.Boolean, Schema.Literal("unknown")])
}) {}

/** `device/point`, both slugs' worth of characters, or undefined. */
export const parseTarget = (text: string): { readonly device: string; readonly point: string } | undefined => {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(text.trim())
  return match?.[1] === undefined || match[2] === undefined ? undefined : { device: match[1], point: match[2] }
}

/** The writable points of a config, as `device/point`, for a hint. */
export const writablePoints = (config: Pick<GatewayConfig, "devices">) =>
  config.devices.flatMap((device) =>
    device.points.filter((point) => point.writable).map((point) => `${device.id}/${point.id}`)
  )

const listed = (names: ReadonlyArray<string>) =>
  names.length === 0
    ? "the config has no writable point: set writable to true (and limits for a number) on one"
    : `writable points: ${names.slice(0, 10).join(", ")}${names.length > 10 ? `, and ${names.length - 10} more` : ""}`

/** The device and point `target` names in `config`, or why there is none. */
export const findPoint = (
  config: GatewayConfig,
  target: { readonly device: string; readonly point: string }
): { readonly device: Device; readonly point: AnyPoint } | WriteFailed => {
  const device = config.devices.find((candidate) => candidate.id === target.device)
  const point = device?.points.find((candidate) => candidate.id === target.point)
  if (device === undefined || point === undefined) {
    return new WriteFailed({
      message: `${target.device}/${target.point}: ${device === undefined ? "no such device" : "no such point"} in the config`,
      code: "unknown-point",
      hint: listed(writablePoints(config)),
      written: false
    })
  }
  if (!point.writable) {
    return new WriteFailed({
      message: `${target.device}/${target.point} is not writable in the config`,
      code: "not-writable",
      hint: `set "writable": true on it${point.limits === undefined ? ', with "limits": {"min": …, "max": …} for a number,' : ""} in the config or on the status page, and restart the gateway; ${listed(writablePoints(config))}`,
      written: false
    })
  }
  return { device, point }
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

/** What `point` takes, in a few words, for a hint. */
export const takes = (device: Device, point: AnyPoint) => {
  const kind = writeKind(device, point)
  const release = device.protocol === "bacnet-ip" ? ", or null to release the priority slot" : ""
  if (kind === "binary") return `true or false (on/off, 1/0)${release}`
  const range = point.limits === undefined ? "" : ` from ${point.limits.min} to ${point.limits.max}`
  const unit = unitLabel(point.unit)
  return kind === "multi-state"
    ? `a state number${range}${release}`
    : `a number${range}${unit === "" ? "" : ` ${unit}`}${release}`
}

/**
 * The value `text` means for `point`: true or false (also on/off, 1/0) for a binary point, null (or `release`) to
 * release a BACnet priority slot, a number otherwise. Then the guard's own checks, so a value it would refuse is
 * refused here, before anything is sent.
 */
export const parseValue = (device: Device, point: AnyPoint, text: string): WriteValue | WriteFailed => {
  const word = text.trim().toLowerCase()
  const kind = writeKind(device, point)
  const value: WriteValue | undefined =
    word === "null" || word === "release"
      ? null
      : kind === "binary"
        ? word === "true" || word === "on" || word === "1"
          ? true
          : word === "false" || word === "off" || word === "0"
            ? false
            : undefined
        : NUMBER.test(word)
          ? Number(word)
          : undefined
  const target = `${device.id}/${point.id}`
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
    return new WriteFailed({
      message: `${target} takes ${takes(device, point)}, not ${JSON.stringify(text)}`,
      code: "wrong-type",
      hint: `ot-gateway write ${target} <value>, the value being ${takes(device, point)}`,
      written: false
    })
  }
  const rejection = valueRejection(device, point, value)
  if (rejection === undefined) return value
  return new WriteFailed({
    message: `${target}: ${rejection.message}`,
    code: rejection.reason,
    hint:
      rejection.reason === "out-of-range"
        ? `${target} takes ${takes(device, point)}; to allow more, widen its limits in the config and restart the gateway`
        : `${target} takes ${takes(device, point)}`,
    written: false
  })
}

/** What the gateway answered, decoded from MQTT: anything else on the topic is ignored. */
const Result = Schema.Union([
  Schema.Struct({ status: Schema.Literal("written") }),
  Schema.Struct({
    status: Schema.Literals(["rejected", "failed"]),
    reason: Schema.String,
    message: Schema.String
  })
])
const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Result))

/** The gateway's `failed` reasons that come before anything is sent to the device. */
const notSentReasons: ReadonlySet<string> = new Set(["device-unavailable", "configuration", "not-implemented"])

/** What to do after the gateway's answer, by its reason. */
export const outcomeHint = (reason: string, target: string, topic: string) => {
  switch (reason) {
    case "unknown-point":
    case "not-writable":
      return `the running gateway's config differs from this one: restart it with this config, or check it with ot-gateway status`
    case "out-of-range":
    case "wrong-type":
      return `the running gateway's limits for ${target} differ from this config's: restart it with this config`
    case "expired":
      return "the gateway was busy with other commands for longer than its maxAge; try again"
    case "device-unavailable":
      return "the device is not running on the gateway: ot-gateway status says why"
    case "timeout":
      return `the device may have applied it anyway; read ${target} back before trying again (ot-gateway history ${target} --since 1m)`
    default:
      return `the device refused or broke off the write; ot-gateway logs --level warn shows the details (topic ${topic})`
  }
}

export interface WriteOptions {
  /**
   * How long to wait for the gateway's result (default 25 s: a command may wait 10 s for its turn, the guard's
   * maxAge, and the write 10 s more, its write timeout).
   */
  readonly timeout?: Duration.Input
}

export interface WriteReport {
  readonly ok: true
  readonly status: "written"
  readonly device: string
  readonly point: string
  readonly topic: string
  readonly value: WriteValue
  readonly unit?: string
  /** From sending the command to the gateway's result, in milliseconds. */
  readonly ms: number
  readonly broker: string
}

const randomBytes = Effect.gen(function* () {
  const bytes = new Uint8Array(16)
  for (let index = 0; index < bytes.length; index++) bytes[index] = yield* Random.nextIntBetween(0, 255)
  return bytes
})

const sameBytes = (left: Uint8Array | undefined, right: Uint8Array) =>
  left !== undefined && left.length === right.length && left.every((byte, index) => byte === right[index])

/** `ot-gateway write`: check, send the command, wait for its result. */
export const writePoint = Effect.fn("writePoint")(function* (
  config: GatewayConfig,
  target: { readonly device: string; readonly point: string },
  valueText: string,
  options: WriteOptions = {}
) {
  const found = findPoint(config, target)
  if (found instanceof WriteFailed) return yield* found
  const { device, point } = found
  const value = parseValue(device, point, valueText)
  if (value instanceof WriteFailed) return yield* value

  const topic = pointTopic({ site: config.site, building: config.building, device: device.id, point: point.id })
  const commandTopic = `${topic}/$set`
  const resultTopic = `${commandTopic}/result`
  const correlation = yield* randomBytes
  const suffix = Array.from(correlation.slice(0, 3), (byte) => byte.toString(16).padStart(2, "0")).join("")
  const probeTopic = `${config.site}/${config.building}/$gateway/${config.id}/check/write-${suffix}`
  const probed = yield* Deferred.make<void>()
  const answered = yield* Deferred.make<string>()
  // Results from before the command (another client's) are not its answer.
  let sent = false
  let correlated = true

  const onMessage = (message: InboundMessage) => {
    if (message.topic === probeTopic) return Deferred.succeed(probed, undefined).pipe(Effect.asVoid)
    if (message.topic !== resultTopic || !sent) return Effect.void
    if (correlated && !sameBytes(message.correlationData, correlation)) return Effect.void
    return Deferred.succeed(answered, message.payload).pipe(Effect.asVoid)
  }
  const client = yield* brokerClient(config.mqtt, "write", {
    subscriptions: [
      { filter: resultTopic, qos: 1 },
      { filter: probeTopic, qos: 1 }
    ],
    onMessage
  })
  yield* firstDialOf(client, config.mqtt)
  const connection = yield* client.connection
  correlated = connection?.protocolVersion !== "3.1.1"

  const brokerFailure = (error: { readonly message: string }) =>
    new BrokerCommandError({ message: `${config.mqtt.url} did not take a message: ${error.message}` })
  yield* client.publish(probeTopic, "ot-gateway write check", { qos: 1 }).pipe(Effect.mapError(brokerFailure))
  const subscribed = yield* Deferred.await(probed).pipe(Effect.timeoutOption("5 seconds"))
  if (Option.isNone(subscribed)) {
    return yield* new BrokerCommandError({
      message: `${config.mqtt.url}: a message to ${probeTopic} did not come back within 5 seconds, so the result of a command would not arrive either; nothing was sent`,
      code: "no-round-trip",
      hint: `check the broker's access rules (ACL) for this user under ${config.site}/${config.building}/#: they must allow publishing and subscribing`
    })
  }

  sent = true
  const startedAt = yield* monotonicMillis
  yield* client
    .publish(commandTopic, JSON.stringify({ value }), {
      qos: 1,
      ...(correlated ? { correlationData: correlation } : {})
    })
    .pipe(
      Effect.catchTag("MqttPublishError", (error) =>
        Effect.fail(
          // A message the broker refused (its access rules, say) reached nobody; any other failure may have come
          // after the broker took it and passed it on.
          error.reason === "rejected"
            ? new WriteFailed({
                message: `${device.id}/${point.id}: the broker refused the command on ${commandTopic}: ${error.message}`,
                code: "command-refused",
                hint: `check the broker's access rules (ACL) for this user: it must allow publishing on ${config.site}/${config.building}/+/+/$set`,
                written: false
              })
            : new WriteFailed({
                message: `${device.id}/${point.id}: the broker did not confirm the command on ${commandTopic}: ${error.message}`,
                code: "command-unconfirmed",
                hint: `the gateway may have received and applied it: read ${device.id}/${point.id} back before trying again`,
                written: "unknown"
              })
        )
      )
    )
  const timeout = Duration.fromInputUnsafe(options.timeout ?? "25 seconds")
  const payload = yield* Deferred.await(answered).pipe(Effect.timeoutOption(timeout))
  const ms = Math.max(0, (yield* monotonicMillis) - startedAt)
  const label = `${device.id}/${point.id}`
  if (Option.isNone(payload)) {
    return yield* new WriteFailed({
      message: `${label}: no gateway answered on ${resultTopic} within ${Duration.format(timeout)}`,
      code: "no-result",
      hint: `is the gateway running with this config, connected to ${config.mqtt.url}? ot-gateway status says; the command may still have been applied, so read ${label} back before trying again`,
      written: "unknown"
    })
  }
  const result = decodeResult(payload.value)
  if (Option.isNone(result)) {
    return yield* new WriteFailed({
      message: `${label}: the gateway's answer is not a command result: ${payload.value.slice(0, 200)}`,
      code: "invalid-result",
      hint: "ot-gateway watch --check shows what is off the MQTT contract; an older gateway may answer differently",
      written: "unknown"
    })
  }
  if (result.value.status !== "written") {
    const { status, reason, message } = result.value
    return yield* new WriteFailed({
      message: `${label}: ${status} by the gateway: ${message}`,
      code: reason,
      hint: outcomeHint(reason, label, topic),
      // A failed write may have reached the device (a garbled answer after it applied it, say), unless it failed
      // before anything was sent: no running device, a config it cannot take, a write it cannot do.
      written: status === "failed" && !notSentReasons.has(reason) ? "unknown" : false
    })
  }
  const report: WriteReport = {
    ok: true,
    status: "written",
    device: device.id,
    point: point.id,
    topic,
    value,
    ...(point.unit === undefined ? {} : { unit: point.unit }),
    ms,
    broker: config.mqtt.url
  }
  return report
}, Effect.scoped)

/** `write` for a person, one line. */
export const formatWritten = (report: WriteReport) => {
  const unit = unitLabel(report.unit)
  const value = report.value === null ? "released" : `${report.value}${unit === "" ? "" : ` ${unit}`}`
  return `✓ ${report.device}/${report.point} ${report.value === null ? "" : "= "}${value} (written in ${report.ms} ms)`
}
