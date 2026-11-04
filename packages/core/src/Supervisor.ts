/**
 * Keeps one device's pipeline running. Expected failures are handled inside
 * `runDevice`; this catches what is left, a defect (a bug, a throw in a
 * driver), so it stops only that device, and restarts it with backoff.
 */
import { Cause, Duration, Effect, Metric } from "effect"
import type { HealthRegistry } from "./Health.ts"
import { monotonicMillis } from "./Monotonic.ts"
import type { Slug } from "./Point.ts"
import { deviceRestarts, withMetricAttributes } from "./Telemetry.ts"

export interface SuperviseOptions {
  readonly deviceId: Slug
  /** Where the crash is recorded (`failing`, reason `crashed`) until the device reads again. */
  readonly health?: HealthRegistry
  /** First delay before a restart, doubled after every crash in a row (default 1 s). */
  readonly initialBackoff?: Duration.Input
  /** Longest delay before a restart (default 5 minutes). A run that lasted this long resets the backoff. */
  readonly maxBackoff?: Duration.Input
}

/** The text of a defect, for the log annotation; the full cause goes with the log entry. */
const describeDefect = (defect: unknown): string => (defect instanceof Error ? defect.message : String(defect))

/**
 * Run `device` and restart it whenever it dies on a defect: logged with the
 * device id and the cause, counted in `ot_gateway_device_restarts_total` and
 * recorded in the health registry. Restarts back off exponentially up to
 * `maxBackoff`, so a device that crashes on every start does not spin. Pass
 * the device as a lazy effect (`Effect.suspend`) so each restart builds its
 * driver again instead of reusing a broken one.
 *
 * Interruption is not a defect: on shutdown the device stops and is not
 * restarted. If `device` returns, the supervisor returns too.
 */
export const superviseDevice = Effect.fn("superviseDevice")(function* <R>(
  device: Effect.Effect<unknown, never, R>,
  options: SuperviseOptions
) {
  const initialMs = Duration.toMillis(options.initialBackoff ?? "1 second")
  const maxMs = Duration.toMillis(options.maxBackoff ?? "5 minutes")
  let crashesInARow = 0
  while (true) {
    const startedAt = yield* monotonicMillis
    const crash = yield* device.pipe(
      Effect.as(undefined),
      Effect.catchDefect((defect) => Effect.succeed({ defect }))
    )
    if (crash === undefined) return
    if ((yield* monotonicMillis) - startedAt >= maxMs) crashesInARow = 0
    const delayMs = Math.min(initialMs * 2 ** Math.min(crashesInARow, 30), maxMs)
    crashesInARow++
    options.health?.recordFailure(options.deviceId, "crashed")
    yield* Metric.update(deviceRestarts, 1).pipe(withMetricAttributes({ device: options.deviceId }))
    yield* Effect.logError("device pipeline crashed, restarting it", Cause.die(crash.defect)).pipe(
      Effect.annotateLogs({
        device: options.deviceId,
        error: describeDefect(crash.defect),
        restartInMs: delayMs,
        crashesInARow
      })
    )
    yield* Effect.sleep(delayMs)
  }
})
