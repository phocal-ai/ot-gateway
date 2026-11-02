/**
 * The contract every protocol driver implements.
 *
 * A driver owns its connection (socket, UDP binding) inside a Scope, so it is
 * always released, even when a fiber is interrupted.
 */
import type { Effect, Stream } from "effect"
import type { DriverError } from "./Errors.ts"
import type { AnyPoint } from "./Point.ts"

export type PointValue = number | boolean

/** One raw value read from a device, before scaling. */
export interface Reading {
  readonly pointId: string
  readonly value: PointValue
  /** Milliseconds since the epoch. */
  readonly timestamp: number
}

export interface Driver {
  readonly deviceId: string
  readonly points: ReadonlyArray<AnyPoint>
  /** Read every configured point once. */
  readonly readAll: Effect.Effect<ReadonlyArray<Reading>, DriverError>
  /**
   * The driver already resends requests that time out, so the pipeline does
   * not retry a `timeout` failure within the cycle; it would only multiply
   * the wait for a device that is offline.
   */
  readonly retriesTimeouts?: boolean
  /**
   * Values the device pushes between polls (BACnet change-of-value). The
   * pipeline handles them like polled readings, one at a time with the
   * polling cycle, for as long as the device runs. The driver deals with its
   * own failures here: a subscription that cannot be made means its points
   * stay polled.
   */
  readonly changes?: Stream.Stream<Reading>
  /** Write a value to a writable point. The core enforces safety before calling this. */
  readonly write: (pointId: string, value: PointValue) => Effect.Effect<void, DriverError>
}
