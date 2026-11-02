/**
 * Time for deadlines, backoffs and ordering, which must not follow the wall
 * clock: a Raspberry Pi has no real-time clock, so NTP steps it at boot and
 * whenever the network comes back. Wall time is only for timestamps that
 * leave the gateway (`ts` in messages, metric timestamps).
 */
import { Clock, Effect } from "effect"

/** Milliseconds on a clock that never steps; only differences between two readings mean anything. */
export const monotonicMillis: Effect.Effect<number> = Effect.map(Clock.monotonicTimeNanos, (nanos) =>
  Number(nanos / 1_000_000n)
)
