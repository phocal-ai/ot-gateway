/**
 * Gateway health over MQTT (VISION.md, principle 5): a retained message on
 * `site/building/$gateway/<id>/health` that says whether the gateway is
 * online and how each device is doing. The MQTT last will replaces it with
 * `offline` when the gateway disappears without saying goodbye.
 */
import { Effect, Metric, Schedule } from "effect"
import type { DriverError } from "./Errors.ts"
import type { Slug } from "./Point.ts"
import { Publisher } from "./Publisher.ts"
import { publishFailures } from "./Telemetry.ts"

/**
 * Why a device is `failing`: the driver's reason for a failed read,
 * `cycle-timeout` when a polling cycle hung past the device's deadline, or
 * `crashed` when its pipeline died on a bug and is waiting to be restarted.
 */
export type HealthReason = DriverError["reason"] | "cycle-timeout" | "crashed"

export interface DeviceHealth {
  /** `starting` until the first cycle finishes; then whether the last read worked. */
  readonly status: "starting" | "ok" | "failing"
  /** Unix ms of the last successful read. */
  readonly lastSuccess?: number
  /** Why the device is failing, while `failing`. */
  readonly reason?: HealthReason
}

/** Per-device status, written by the polling pipeline and read by the health publisher. */
export interface HealthRegistry {
  readonly devices: ReadonlyMap<Slug, DeviceHealth>
  readonly recordSuccess: (device: Slug, timestamp: number) => void
  readonly recordFailure: (device: Slug, reason: HealthReason) => void
}

export const makeHealthRegistry = (deviceIds: ReadonlyArray<Slug>): HealthRegistry => {
  const devices = new Map<Slug, DeviceHealth>(deviceIds.map((id) => [id, { status: "starting" }]))
  return {
    devices,
    recordSuccess: (device, timestamp) => {
      devices.set(device, { status: "ok", lastSuccess: timestamp })
    },
    recordFailure: (device, reason) => {
      const lastSuccess = devices.get(device)?.lastSuccess
      devices.set(device, { status: "failing", reason, ...(lastSuccess === undefined ? {} : { lastSuccess }) })
    }
  }
}

/**
 * The machine the gateway runs on, as the health message reports it. Fields
 * the host cannot tell (no thermal zone, not a Raspberry Pi) are left out.
 */
export interface HostHealth {
  /** Resident memory of the gateway process. */
  readonly memoryBytes: number
  /** The longest the event loop was late in the last minute. */
  readonly eventLoopLagMs: number
  /** Wall-clock steps (NTP setting the time) since the gateway started. */
  readonly clockSteps: number
  readonly temperatureC?: number
  /** Power or thermal conditions the Raspberry Pi reported in the last four samples (about a minute); empty when there were none. */
  readonly throttled?: ReadonlyArray<string>
  /**
   * The conditions the Pi lets the gateway see, with `throttled`: all four where the kernel still exposes the
   * firmware's mask, `under_voltage` alone on newer kernels. An empty `throttled` is only "fine" for these.
   */
  readonly throttledWatched?: ReadonlyArray<string>
  /** Free space on the outbox's filesystem. */
  readonly diskFreeBytes?: number
}

export interface OnlineMessage {
  readonly status: "online"
  /** Unix ms when the gateway started. */
  readonly since: number
  /** Unix ms when this message was written. */
  readonly ts: number
  readonly devices: Readonly<Record<string, DeviceHealth>>
  /** Absent until the host monitor's first sample, and where the gateway runs without one. */
  readonly host?: HostHealth
}

export interface OfflineMessage {
  readonly status: "offline"
  /** `shutdown` when the gateway stopped cleanly; `connection-lost` from the last will. */
  readonly reason: "shutdown" | "connection-lost"
}

export type HealthMessage = OnlineMessage | OfflineMessage

export const onlinePayload = (registry: HealthRegistry, since: number, now: number, host?: HostHealth): string =>
  JSON.stringify({
    status: "online",
    since,
    ts: now,
    devices: Object.fromEntries(registry.devices),
    ...(host === undefined ? {} : { host })
  } satisfies OnlineMessage)

export const offlinePayload = (reason: OfflineMessage["reason"]): string =>
  JSON.stringify({ status: "offline", reason } satisfies OfflineMessage)

export interface HealthReporterOptions {
  readonly topic: string
  readonly intervalMs: number
  /** Renders the current online message. */
  readonly online: Effect.Effect<string>
}

/**
 * Refresh the retained online message every `intervalMs`, so subscribers see
 * device status change and `ts` advance. The publisher announces the gateway
 * on connect; this keeps the message current between connects. Every failed
 * refresh is counted, and the next interval tries again. Only the first
 * failure of a run is logged, and the recovery after it: a broker outage is
 * two lines, not one per interval.
 */
export const runHealthReporter = Effect.fn("runHealthReporter")(function* (options: HealthReporterOptions) {
  const publisher = yield* Publisher
  let failing = false
  const refresh = Effect.gen(function* () {
    yield* publisher.publish(options.topic, yield* options.online, { retain: true })
    if (failing) {
      failing = false
      yield* Effect.logInfo("health publish recovered")
    }
  }).pipe(
    Effect.catchTag("PublishError", (error) =>
      Effect.gen(function* () {
        yield* Metric.update(publishFailures, 1)
        if (failing) return
        failing = true
        yield* Effect.logWarning("health publish failed").pipe(Effect.annotateLogs({ error: error.message }))
      })
    )
  )
  return yield* Effect.sleep(options.intervalMs).pipe(Effect.andThen(refresh), Effect.repeat(Schedule.forever))
})
