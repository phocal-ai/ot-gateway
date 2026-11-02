/**
 * The contract every protocol driver implements.
 *
 * A driver owns its connection (socket, UDP binding) inside a Scope, so it is
 * always released, even when a fiber is interrupted.
 */
import type { Effect } from "effect"
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
  /** Write a value to a writable point. The core enforces safety before calling this. */
  readonly write: (pointId: string, value: PointValue) => Effect.Effect<void, DriverError>
}
