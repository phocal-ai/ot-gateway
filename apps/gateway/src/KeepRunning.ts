/**
 * Keeps a gateway-wide task (the health reporter) alive. Devices have their
 * own supervisor in `@ot-gateway/core`; this is the same idea without the
 * per-device health and metrics.
 */
import { Cause, type Duration, Effect } from "effect"

/** Restart `task` after a defect (a bug), so the gateway outlives it; interruption still stops it. */
export const keepRunning = Effect.fn("keepRunning")(function* <R>(
  name: string,
  task: Effect.Effect<unknown, never, R>,
  delay: Duration.Input = "5 seconds"
) {
  while (true) {
    const crashed = yield* task.pipe(
      Effect.as(false),
      Effect.catchDefect((defect) =>
        Effect.logError(`${name} crashed, restarting it`, Cause.die(defect)).pipe(Effect.as(true))
      )
    )
    if (!crashed) return
    yield* Effect.sleep(delay)
  }
})
