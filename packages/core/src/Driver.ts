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

/** A value to write: in the device's units (the core has undone the point's scaling), or `null` to release it. */
export type WriteValue = PointValue | null

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
  /**
   * Write a value to a writable point, once: never retried, since a device
   * that took it and lost the answer would apply it twice. The command guard
   * (`Command.ts`) has checked the point, the type and the range before.
   * `null` releases the gateway's command (BACnet relinquish); a driver
   * without that notion refuses it.
   */
  readonly write: (pointId: string, value: WriteValue) => Effect.Effect<void, DriverError>
}
