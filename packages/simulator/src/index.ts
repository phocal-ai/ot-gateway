/**
 * Simulated devices. Every real driver should be testable against one of
 * these, so CI never needs hardware.
 */
import { Clock, Effect } from "effect"
import type { Driver, Reading, SimulatedPoint, SimulatorDevice } from "@ot-gateway/core"
import { DriverError } from "@ot-gateway/core"

/** Decimals a simulated value keeps: a real device reports a few, never a double's float noise. */
export const SIMULATED_DECIMALS = 3

const decimalScale = 10 ** SIMULATED_DECIMALS

/** `value` rounded to `SIMULATED_DECIMALS`: 7.401776223201452 reads 7.402. */
const deviceRounded = (value: number) => Math.round(value * decimalScale) / decimalScale

/**
 * The value of a simulated point at a given time, with the `SIMULATED_DECIMALS` a device would report. Pure, so it is
 * easy to test.
 */
export const waveformValue = (point: SimulatedPoint, timeMs: number): number => {
  const span = point.max - point.min
  const phase = ((timeMs / 1000) % point.periodSeconds) / point.periodSeconds
  switch (point.waveform) {
    case "constant":
      return point.min
    case "ramp":
      return deviceRounded(point.min + span * phase)
    case "sine":
      return deviceRounded(point.min + span * (0.5 + 0.5 * Math.sin(2 * Math.PI * phase)))
  }
}

/** Build a driver for a simulator device. Values follow the configured waveforms. */
export const makeSimulatorDriver = (device: SimulatorDevice): Driver => ({
  deviceId: device.id,
  points: device.points,
  readAll: Effect.map(Clock.currentTimeMillis, (now) =>
    device.points.map((point): Reading => ({
      pointId: point.id,
      value: waveformValue(point, now),
      timestamp: now
    }))
  ),
  write: (pointId) =>
    Effect.fail(
      new DriverError({
        device: device.id,
        reason: "not-implemented",
        message: `simulated point ${pointId} is read-only`
      })
    )
})
