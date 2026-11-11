import { Option } from "effect"
import type { Scaling } from "./Point.ts"

/**
 * The shortest decimal that reads back as the same single-precision number, so a float32 register or a BACnet REAL
 * holding 6.73 publishes as 6.73 rather than 6.730000019073486, the float64 that the same 32 bits are exactly.
 * Encoding the result as a float32 again gives the same bits, so nothing the device said is lost. At most 9
 * significant digits are ever needed (IEEE 754-2019, clause 5.12.2); typical readings stop after 3 to 7 tries.
 */
export const shortestFloat32 = (value: number): number => {
  if (!Number.isFinite(value)) return value
  const single = Math.fround(value)
  for (let precision = 1; precision < 10; precision++) {
    const candidate = Number(single.toPrecision(precision))
    if (Math.fround(candidate) === single) return candidate
  }
  return single
}

/**
 * `value` at 15 significant digits, which drops the binary noise of float64 arithmetic (`3 * 0.1` is
 * 0.30000000000000004) without touching anything a device measured: a float64 holds 15 decimal digits exactly, and
 * no field instrument resolves more than 9. Whole numbers are returned as they are, so a 64-bit counter keeps every
 * digit, and so are NaN and ±Infinity, which the pipeline refuses.
 */
export const withoutBinaryNoise = (value: number): number =>
  Number.isInteger(value) || !Number.isFinite(value) ? value : Number(value.toPrecision(15))

/**
 * Apply linear scaling to a raw numeric value, without the binary noise the multiplication can add. The raw value
 * is already what the device sent (a float32 shortened by its driver), so the noise is only the scaling's own.
 */
export const applyScaling = (raw: number, scaling: Scaling | undefined): number =>
  scaling === undefined ? raw : withoutBinaryNoise(raw * scaling.factor + scaling.offset)

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
