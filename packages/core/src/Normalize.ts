import { Option } from "effect"
import type { Scaling } from "./Point.ts"

/** Apply linear scaling to a raw numeric value. */
export const applyScaling = (raw: number, scaling: Scaling | undefined): number =>
  scaling === undefined ? raw : raw * scaling.factor + scaling.offset

/**
 * Decide whether a new value should be published.
 * Booleans publish on any change; numbers publish when they move by at least
 * the deadband. The first value always publishes.
 */
export const exceedsDeadband = (
  previous: Option.Option<number | boolean>,
  next: number | boolean,
  deadband: number | undefined
): boolean => {
  if (Option.isNone(previous)) return true
  const prev = previous.value
  if (typeof prev === "boolean" || typeof next === "boolean") return prev !== next
  if (deadband === undefined || deadband <= 0) return prev !== next
  return Math.abs(next - prev) >= deadband
}
