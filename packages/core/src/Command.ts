/**
 * The command guard (VISION.md, principle 6: safe writes). A command arrives
 * on `site/building/device/point/$set` as `{"value": …}` and is written to
 * the device only if all of these hold:
 *
 * - it is live: a retained message is refused, since it would be applied
 *   again on every reconnect;
 * - it is fresh: one that waited longer than `maxAge` (or its MQTT message
 *   expiry) before its turn came is refused, not applied late;
 * - the point exists and is `writable` in the config;
 * - the payload is exactly `{"value": …}`, and the value has the point's
 *   type (true or false for a binary point, a whole number from 1 for a
 *   multi-state one, a finite number otherwise; `null` releases a BACnet
 *   point's priority slot and nothing else);
 * - a number lies within the point's `limits`, in engineering units.
 *
 * The value is then unscaled into device units and written once, with a
 * deadline: never retried, so a command never happens twice or late. Every
 * command whose topic can name a point gets one result on `…/$set/result`,
 * with its correlation data; every command is counted in `ot_gateway_commands`
 * and logged (a run of rejections for unknown or read-only points as a
 * count, at most once a minute). Results are transient: delivered
 * now or not at all. A request's MQTT 5 Response Topic is ignored: answering
 * wherever a sender asks would let it make the gateway publish on topics it
 * may not publish on itself, another point's `$set` included.
 */
import { Clock, Duration, Effect, Metric, Schema, type Scope } from "effect"
import type { Device } from "./Config.ts"
import type { Driver, WriteValue } from "./Driver.ts"
import { monotonicMillis } from "./Monotonic.ts"
import { type AnyPoint, bacnetValueKind, type Scaling, Slug } from "./Point.ts"
import { Publisher } from "./Publisher.ts"
import { commands } from "./Telemetry.ts"

export interface InboundCommand {
  readonly topic: string
  readonly payload: string
  /** A retained message, sent by the broker on subscribing: never applied. */
  readonly retain: boolean
  /** When the gateway received it, in monotonic milliseconds (`monotonicMillis`). */
  readonly receivedAt: number
  /** What was left of its MQTT message expiry when it arrived, in seconds. */
  readonly expirySeconds?: number
  readonly correlationData?: Uint8Array
}

/** The drivers of the devices running now; a device that is down or restarting has none. */
export interface DriverRegistry {
  readonly get: (deviceId: string) => Driver | undefined
  /** Make `driver` the device's driver until the scope closes. */
  readonly register: (driver: Driver) => Effect.Effect<void, never, Scope.Scope>
}

export const makeDriverRegistry = (): DriverRegistry => {
  const drivers = new Map<string, Driver>()
  return {
    get: (deviceId) => drivers.get(deviceId),
    register: (driver) =>
      Effect.acquireRelease(
        Effect.sync(() => drivers.set(driver.deviceId, driver)),
        () =>
          Effect.sync(() => {
            if (drivers.get(driver.deviceId) === driver) drivers.delete(driver.deviceId)
          })
      ).pipe(Effect.asVoid)
  }
}

/** The topic filter the gateway subscribes to for commands. */
export const commandFilter = (site: string, building: string) => `${site}/${building}/+/+/$set`

export type RejectReason =
  | "retained"
  | "expired"
  | "unknown-point"
  | "not-writable"
  | "invalid-payload"
  | "wrong-type"
  | "out-of-range"

export type CommandOutcome =
  | { readonly status: "written"; readonly value: WriteValue }
  | { readonly status: "rejected"; readonly reason: RejectReason; readonly message: string }
  | { readonly status: "failed"; readonly reason: string; readonly message: string }

/**
 * The command payload; it is MQTT input, so it is decoded, not trusted. Only
 * `value` is allowed, so no other message (a command result, say) is ever
 * taken for a command.
 */
const CommandPayload = Schema.fromJsonString(
  Schema.Struct({ value: Schema.Union([Schema.Finite, Schema.Boolean, Schema.Null]) })
)
const decodePayload = Schema.decodeUnknownExit(CommandPayload, { onExcessProperty: "error" })

/** What a point takes when written: true or false, a whole number from 1 (a multi-state state), or a number. */
export const writeKind = (device: Device, point: AnyPoint): "binary" | "multi-state" | "number" => {
  switch (device.protocol) {
    case "modbus-tcp": {
      const modbus = device.points.find((candidate) => candidate.id === point.id)
      return modbus?.table === "coil" || modbus?.table === "discrete" || modbus?.dataType === "bool"
        ? "binary"
        : "number"
    }
    case "bacnet-ip": {
      const bacnet = device.points.find((candidate) => candidate.id === point.id)
      const kind = bacnet === undefined ? "real" : bacnetValueKind(bacnet)
      return kind === "real" ? "number" : kind
    }
    case "simulator":
      return "number"
  }
}

/**
 * A value in device units: `(value - offset) / factor`, the inverse of
 * scaling. A result within floating-point error of a whole number is that
 * number: 19.9 at factor 0.1 is register value 199, not 198.99999999999997,
 * which an integer register would refuse.
 */
export const toDeviceUnits = (value: number, scaling: Scaling | undefined): number => {
  if (scaling === undefined) return value
  const raw = (value - scaling.offset) / scaling.factor
  const whole = Math.round(raw)
  return Math.abs(raw - whole) <= 1e-9 * Math.max(1, Math.abs(raw)) ? whole : raw
}

/** A topic level as it may appear in logs, spans and the status page: ids are slugs of at most 64 characters. */
const label = (level: string) => (level.length <= 64 ? level : `${level.slice(0, 64)}…`)

const rejected = (reason: RejectReason, message: string): CommandOutcome => ({ status: "rejected", reason, message })

/** Whether a topic level can be a configured id: a slug, as the config schema requires. */
const isId = Schema.is(Slug)

/** Rejections that do not involve a writable point; a run of them is summarised, not logged one by one. */
const THROTTLED: ReadonlySet<RejectReason> = new Set(["unknown-point", "not-writable"])
/** How often a run of throttled rejections is summarised, in monotonic milliseconds. */
const SUMMARY_INTERVAL_MS = 60_000

export interface CommandGuardOptions {
  readonly site: string
  readonly building: string
  readonly devices: ReadonlyArray<Device>
  readonly drivers: DriverRegistry
  /** How long one write may take before it counts as failed (default 10 s). */
  readonly writeTimeout?: Duration.Input
  /**
   * How long a command may wait for its turn before it is refused as
   * expired (default 10 s). A command's MQTT message expiry shortens it.
   */
  readonly maxAge?: Duration.Input
  /** Told what became of every command on this gateway's topics (the status page lists them). */
  readonly onOutcome?: (command: { readonly device: string; readonly point: string }, outcome: CommandOutcome) => void
}

export const makeCommandGuard = (options: CommandGuardOptions) => {
  const writeTimeout = options.writeTimeout ?? "10 seconds"
  const maxAgeMillis = Duration.toMillis(Duration.fromInputUnsafe(options.maxAge ?? "10 seconds"))
  const prefix = `${options.site}/${options.building}/`

  /** Every check, then the write: what happened to `command`. */
  const decide = Effect.fnUntraced(function* (command: InboundCommand, device: Device | undefined, pointId: string) {
    if (command.retain) return rejected("retained", "a retained command is never applied: publish it live")
    const point = device?.points.find((candidate) => candidate.id === pointId)
    if (device === undefined || point === undefined) return rejected("unknown-point", "no such device or point")
    if (!point.writable) return rejected("not-writable", "the point is not writable in the gateway's config")
    const payload = decodePayload(command.payload)
    if (payload._tag === "Failure") return rejected("invalid-payload", 'the payload must be {"value": …}')
    const { value } = payload.value
    const kind = writeKind(device, point)
    if (value === null) {
      if (device.protocol !== "bacnet-ip") return rejected("wrong-type", "only a BACnet point can be released")
    } else if ((kind === "binary") !== (typeof value === "boolean")) {
      return rejected("wrong-type", kind === "binary" ? "the point takes true or false" : "the point takes a number")
    } else if (kind === "multi-state" && !(Number.isInteger(value) && Number(value) >= 1)) {
      return rejected("wrong-type", "a multi-state point takes a whole number from 1 (its state)")
    } else if (typeof value === "number") {
      const limits = point.limits
      if (limits === undefined || value < limits.min || value > limits.max) {
        return rejected("out-of-range", `${value} is outside ${limits?.min} to ${limits?.max}`)
      }
    }
    // Last before the write: a command that waited too long behind others is not applied late.
    const waited = (yield* monotonicMillis) - command.receivedAt
    const maxAge = Math.min(maxAgeMillis, (command.expirySeconds ?? Number.POSITIVE_INFINITY) * 1000)
    if (waited > maxAge) return rejected("expired", `waited ${waited} ms for its turn, longer than ${maxAge} ms`)
    const driver = options.drivers.get(device.id)
    if (driver === undefined) {
      return { status: "failed", reason: "device-unavailable", message: "the device is not running" } as const
    }
    // The device takes raw units: undo the point's scaling (value = raw * factor + offset).
    const raw = typeof value === "number" ? toDeviceUnits(value, point.scaling) : value
    return yield* driver.write(point.id, raw).pipe(
      Effect.as<CommandOutcome>({ status: "written", value }),
      Effect.timeoutOrElse({
        duration: writeTimeout,
        orElse: () =>
          Effect.succeed<CommandOutcome>({
            status: "failed",
            reason: "timeout",
            message: `no answer within ${Duration.format(Duration.fromInputUnsafe(writeTimeout))}; the device may have applied it`
          })
      }),
      Effect.catchTag("DriverError", (error) =>
        Effect.succeed<CommandOutcome>({ status: "failed", reason: error.reason, message: error.message })
      )
    )
  })

  /**
   * Logs rejections for unknown and read-only points: the first of a run in
   * full, then at most one line a minute with how many arrived since. None of
   * them touches a writable point, and the metric counts every one.
   */
  let throttle: { loggedAt: number; since: number } | undefined
  const logThrottled = Effect.fnUntraced(function* (
    log: Effect.Effect<void>,
    annotations: Readonly<Record<string, string>>
  ) {
    const now = yield* monotonicMillis
    if (throttle === undefined || (now - throttle.loggedAt >= SUMMARY_INTERVAL_MS && throttle.since === 0)) {
      throttle = { loggedAt: now, since: 0 }
      return yield* log
    }
    throttle.since++
    if (now - throttle.loggedAt < SUMMARY_INTERVAL_MS) return
    const rejectedSince = throttle.since
    throttle = { loggedAt: now, since: 0 }
    yield* Effect.logWarning("commands rejected").pipe(Effect.annotateLogs({ ...annotations, rejected: rejectedSince }))
  })

  /** Check, write, answer, log and count one command. Never fails: a command's problems are its result. */
  const handle = Effect.fn("Command")(function* (command: InboundCommand) {
    const publisher = yield* Publisher
    const levels = command.topic.startsWith(prefix) ? command.topic.slice(prefix.length).split("/") : []
    const [deviceId = "", pointId = "", suffix] = levels
    if (levels.length !== 3 || suffix !== "$set") return
    // The levels come from the topic, so from whoever sent it: bounded before they reach logs or spans.
    const ids = { device: label(deviceId), point: label(pointId) }
    yield* Effect.annotateCurrentSpan({ "ot_gateway.device": ids.device, "ot_gateway.point": ids.point })
    // A level that is not a slug of at most 64 characters can never be a configured id, so no point is
    // addressed and nobody waits for a result on that topic: counted and logged, but not answered.
    const wellFormed = isId(deviceId) && isId(pointId)
    const device = wellFormed ? options.devices.find((candidate) => candidate.id === deviceId) : undefined
    const outcome = wellFormed
      ? yield* decide(command, device, pointId)
      : rejected("unknown-point", "no such device or point")
    options.onOutcome?.(ids, outcome)
    const annotations = { ...ids, payload: command.payload.slice(0, 200) }
    yield* Metric.update(
      Metric.withAttributes(commands, {
        outcome: outcome.status,
        ...(outcome.status === "written" ? {} : { reason: outcome.reason })
      }),
      1
    )
    if (outcome.status === "written") {
      yield* Effect.logInfo("command written").pipe(Effect.annotateLogs(annotations))
    } else {
      const details = { ...annotations, reason: outcome.reason, message: outcome.message }
      const log = Effect.logWarning(`command ${outcome.status}`).pipe(Effect.annotateLogs(details))
      yield* outcome.status === "rejected" && THROTTLED.has(outcome.reason) ? logThrottled(log, details) : log
    }
    if (!wellFormed) return
    const ts = yield* Clock.currentTimeMillis
    const result = outcome.status === "written" ? { status: "written", value: outcome.value } : outcome
    yield* publisher
      .publish(`${command.topic}/result`, JSON.stringify({ ...result, ts }), {
        transient: true,
        ...(command.correlationData === undefined ? {} : { correlationData: command.correlationData })
      })
      .pipe(
        Effect.catchTag("PublishError", (error) =>
          Effect.logWarning("command result not delivered").pipe(Effect.annotateLogs({ error: error.message }))
        )
      )
  })

  return { filter: commandFilter(options.site, options.building), handle }
}
