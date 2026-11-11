/**
 * Gateway health over MQTT (VISION.md, principle 5): a retained message on
 * `site/building/$gateway/<id>/health` that says whether the gateway is
 * online and how each device is doing. The MQTT last will replaces it with
 * `offline` when the gateway disappears without saying goodbye.
 */
import { Effect, Metric, Queue, Schedule, Semaphore } from "effect"
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
  /** Unix ms of the first failure in the current run of failures, while `failing`. */
  readonly failingSince?: number
  /** The latest failure in one line, from the typed error (`could not connect: connection refused by …`), while `failing`. */
  readonly lastError?: string
  /** Failed polling cycles in a row (the retries inside a cycle count once), while `failing`; a read resets it. */
  readonly failures?: number
}

/** One failed read, crash or hung cycle, as the registry records it. */
export interface DeviceFailure {
  readonly reason: HealthReason
  /** One line saying what went wrong, from the typed error's message. Never a secret. */
  readonly message: string
  /** Unix ms when it happened, from the gateway's wall clock. */
  readonly at: number
}

/** A device's status or failure reason changed: its health before and after. */
export interface HealthChange {
  readonly device: Slug
  readonly previous: DeviceHealth
  readonly next: DeviceHealth
}

/** Per-device status, written by the polling pipeline and read by the health publisher. */
export interface HealthRegistry {
  readonly devices: ReadonlyMap<Slug, DeviceHealth>
  readonly recordSuccess: (device: Slug, timestamp: number) => void
  readonly recordFailure: (device: Slug, failure: DeviceFailure) => void
  /**
   * Call `listener` whenever a device's `status` or `reason` changes (`starting` to `ok`, `ok` to `failing`,
   * one failure reason to another), not on every successful read. Returns the function that removes it.
   */
  readonly onChange: (listener: (change: HealthChange) => void) => () => void
}

const starting: DeviceHealth = { status: "starting" }

export const makeHealthRegistry = (deviceIds: ReadonlyArray<Slug>): HealthRegistry => {
  const devices = new Map<Slug, DeviceHealth>(deviceIds.map((id) => [id, starting]))
  const listeners = new Set<(change: HealthChange) => void>()
  const record = (device: Slug, previous: DeviceHealth, next: DeviceHealth) => {
    devices.set(device, next)
    if (previous.status === next.status && previous.reason === next.reason) return
    const change: HealthChange = { device, previous, next }
    listeners.forEach((listener) => listener(change))
  }
  return {
    devices,
    recordSuccess: (device, timestamp) =>
      record(device, devices.get(device) ?? starting, { status: "ok", lastSuccess: timestamp }),
    recordFailure: (device, failure) => {
      const previous = devices.get(device) ?? starting
      const continuing = previous.status === "failing"
      record(device, previous, {
        status: "failing",
        reason: failure.reason,
        ...(previous.lastSuccess === undefined ? {} : { lastSuccess: previous.lastSuccess }),
        failingSince: continuing ? (previous.failingSince ?? failure.at) : failure.at,
        lastError: failure.message,
        failures: continuing ? (previous.failures ?? 0) + 1 : 1
      })
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
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
  readonly devices: Readonly<Record<string, DeviceHealthMessage>>
  /** Absent until the host monitor's first sample, and where the gateway runs without one. */
  readonly host?: HostHealth
}

export interface OfflineMessage {
  readonly status: "offline"
  /** `shutdown` when the gateway stopped cleanly; `connection-lost` from the last will. */
  readonly reason: "shutdown" | "connection-lost"
}

export type HealthMessage = OnlineMessage | OfflineMessage

/**
 * A device as the health message carries it: its status, last read, and while failing why and since when. The
 * error text and the failure count stay on the gateway (`/api/status`): the retained message reaches every
 * subscriber of the broker, and an error names addresses on the building's network.
 */
export type DeviceHealthMessage = Pick<DeviceHealth, "status" | "lastSuccess" | "reason" | "failingSince">

const healthMessageOf = (health: DeviceHealth): DeviceHealthMessage => ({
  status: health.status,
  ...(health.lastSuccess === undefined ? {} : { lastSuccess: health.lastSuccess }),
  ...(health.reason === undefined ? {} : { reason: health.reason }),
  ...(health.failingSince === undefined ? {} : { failingSince: health.failingSince })
})

export const onlinePayload = (registry: HealthRegistry, since: number, now: number, host?: HostHealth): string =>
  JSON.stringify({
    status: "online",
    since,
    ts: now,
    devices: Object.fromEntries(Array.from(registry.devices, ([id, health]) => [id, healthMessageOf(health)])),
    ...(host === undefined ? {} : { host })
  } satisfies OnlineMessage)

export const offlinePayload = (reason: OfflineMessage["reason"]): string =>
  JSON.stringify({ status: "offline", reason } satisfies OfflineMessage)

export interface HealthReporterOptions {
  readonly topic: string
  readonly intervalMs: number
  /** Renders the current online message. */
  readonly online: Effect.Effect<string>
  /** Device status changes to publish without waiting for the next interval. */
  readonly registry?: HealthRegistry
  /** How long a change waits for others to join it before it is published: the bound on change-driven publishes. */
  readonly changeWindowMs?: number
}

/** A status change waits this long for others, so health goes out on change at most about once a second. */
export const healthChangeWindowMs = 1_000

/**
 * Refresh the retained online message every `intervalMs`, so subscribers see
 * `ts` advance, and soon after a device's status changes, so the retained
 * message does not say `starting` for a minute after the devices came up.
 * Changes within `changeWindowMs` (on the monotonic timer) of the first one go
 * out in one message, so a flapping device costs at most one publish per
 * window on top of the heartbeat. The publisher announces the gateway on
 * connect; this keeps the message current between connects. Every failed
 * refresh is counted, and the next one tries again. Only the first failure of
 * a run is logged, and the recovery after it: a broker outage is two lines,
 * not one per interval.
 */
export const runHealthReporter = Effect.fn("runHealthReporter")(function* (options: HealthReporterOptions) {
  const publisher = yield* Publisher
  // One refresh at a time, each rendered once it holds the permit: a later retained message is never older.
  const oneAtATime = yield* Semaphore.make(1)
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
    ),
    Semaphore.withPermit(oneAtATime)
  )
  const heartbeat = Effect.sleep(options.intervalMs).pipe(Effect.andThen(refresh), Effect.repeat(Schedule.forever))
  const registry = options.registry
  if (registry === undefined) return yield* heartbeat
  // Capacity one, sliding: any number of changes before the next publish is one pending signal.
  const changed = yield* Queue.sliding<void>(1)
  const onChange = Effect.gen(function* () {
    yield* Queue.take(changed)
    yield* Effect.sleep(options.changeWindowMs ?? healthChangeWindowMs)
    // What changed during the window is in the message about to be rendered.
    yield* Queue.clear(changed)
    yield* refresh
  }).pipe(Effect.repeat(Schedule.forever))
  return yield* Effect.acquireRelease(
    Effect.sync(() => registry.onChange(() => Queue.offerUnsafe(changed, undefined))),
    (unsubscribe) => Effect.sync(unsubscribe)
  ).pipe(Effect.andThen(Effect.all([heartbeat, onChange], { concurrency: 2, discard: true })), Effect.scoped)
})
