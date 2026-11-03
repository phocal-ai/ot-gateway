/**
 * The command guard (VISION.md, principle 6: safe writes). A command arrives
 * on `site/building/device/point/$set` as `{"value": …}` and is written to
 * the device only if all of these hold:
 *
 * - it is live: a retained message is refused, since it would be applied
 *   again on every reconnect;
 * - the point exists and is `writable` in the config;
 * - the payload decodes, and the value has the point's type (true or false
 *   for a binary point, a finite number otherwise; `null` releases a BACnet
 *   point's priority slot and nothing else);
 * - a number lies within the point's `limits`, in engineering units.
 *
 * The value is then unscaled into device units and written once, with a
 * deadline: never retried, so a command never happens twice or late. Every
 * command gets one result on the request's response topic (or
 * `…/$set/result`), with its correlation data, is logged and counted in
 * `plenum_commands`. Results are transient: delivered now or not at all.
 */
import { Clock, Duration, Effect, Metric, Schema, type Scope } from "effect"
import type { Device } from "./Config.ts"
import type { Driver, WriteValue } from "./Driver.ts"
import type { AnyPoint } from "./Point.ts"
import { Publisher } from "./Publisher.ts"
import { commands } from "./Telemetry.ts"

export interface InboundCommand {
  readonly topic: string
  readonly payload: string
  /** A retained message, sent by the broker on subscribing: never applied. */
  readonly retain: boolean
  readonly responseTopic?: string
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
  | "unknown-point"
  | "not-writable"
  | "invalid-payload"
  | "wrong-type"
  | "out-of-range"

export type CommandOutcome =
  | { readonly status: "written"; readonly value: WriteValue }
  | { readonly status: "rejected"; readonly reason: RejectReason; readonly message: string }
  | { readonly status: "failed"; readonly reason: string; readonly message: string }

/** The command payload; it is MQTT input, so it is decoded, not trusted. */
const CommandPayload = Schema.fromJsonString(
  Schema.Struct({ value: Schema.Union([Schema.Finite, Schema.Boolean, Schema.Null]) })
)
const decodePayload = Schema.decodeUnknownExit(CommandPayload)

/** Whether a point takes true and false (a coil, a bool register, a binary object's present value). */
export const isBinaryPoint = (device: Device, point: AnyPoint): boolean => {
  switch (device.protocol) {
    case "modbus-tcp": {
      const modbus = device.points.find((candidate) => candidate.id === point.id)
      return modbus?.table === "coil" || modbus?.table === "discrete" || modbus?.dataType === "bool"
    }
    case "bacnet-ip": {
      const bacnet = device.points.find((candidate) => candidate.id === point.id)
      return bacnet?.objectType.startsWith("binary-") === true && bacnet.property === "present-value"
    }
    case "simulator":
      return false
  }
}

const rejected = (reason: RejectReason, message: string): CommandOutcome => ({ status: "rejected", reason, message })

export interface CommandGuardOptions {
  readonly site: string
  readonly building: string
  readonly devices: ReadonlyArray<Device>
  readonly drivers: DriverRegistry
  /** How long one write may take before it counts as failed (default 10 s). */
  readonly writeTimeout?: Duration.Input
  /** Told what became of every command on this gateway's topics (the status page lists them). */
  readonly onOutcome?: (command: { readonly device: string; readonly point: string }, outcome: CommandOutcome) => void
}

export const makeCommandGuard = (options: CommandGuardOptions) => {
  const writeTimeout = options.writeTimeout ?? "10 seconds"
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
    if (value === null) {
      if (device.protocol !== "bacnet-ip") return rejected("wrong-type", "only a BACnet point can be released")
    } else if (isBinaryPoint(device, point) !== (typeof value === "boolean")) {
      return rejected(
        "wrong-type",
        isBinaryPoint(device, point) ? "the point takes true or false" : "the point takes a number"
      )
    } else if (typeof value === "number") {
      const limits = point.limits
      if (limits === undefined || value < limits.min || value > limits.max) {
        return rejected("out-of-range", `${value} is outside ${limits?.min} to ${limits?.max}`)
      }
    }
    const driver = options.drivers.get(device.id)
    if (driver === undefined) {
      return { status: "failed", reason: "device-unavailable", message: "the device is not running" } as const
    }
    // The device takes raw units: undo the point's scaling (value = raw * factor + offset).
    const scaling = point.scaling
    const raw = typeof value === "number" && scaling !== undefined ? (value - scaling.offset) / scaling.factor : value
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

  /** Check, write, answer, log and count one command. Never fails: a command's problems are its result. */
  const handle = Effect.fn("Command")(function* (command: InboundCommand) {
    const publisher = yield* Publisher
    const levels = command.topic.startsWith(prefix) ? command.topic.slice(prefix.length).split("/") : []
    const [deviceId = "", pointId = "", suffix] = levels
    if (levels.length !== 3 || suffix !== "$set") return
    const device = options.devices.find((candidate) => candidate.id === deviceId)
    yield* Effect.annotateCurrentSpan({ "plenum.device": deviceId, "plenum.point": pointId })
    const outcome = yield* decide(command, device, pointId)
    options.onOutcome?.({ device: deviceId, point: pointId }, outcome)
    const annotations = { device: deviceId, point: pointId, payload: command.payload.slice(0, 200) }
    yield* Metric.update(
      Metric.withAttributes(commands, {
        outcome: outcome.status,
        ...(outcome.status === "written" ? {} : { reason: outcome.reason })
      }),
      1
    )
    yield* outcome.status === "written"
      ? Effect.logInfo("command written").pipe(Effect.annotateLogs(annotations))
      : Effect.logWarning(`command ${outcome.status}`).pipe(
          Effect.annotateLogs({ ...annotations, reason: outcome.reason, message: outcome.message })
        )
    const ts = yield* Clock.currentTimeMillis
    const result = outcome.status === "written" ? { status: "written", value: outcome.value } : outcome
    yield* publisher
      .publish(command.responseTopic ?? `${command.topic}/result`, JSON.stringify({ ...result, ts }), {
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
