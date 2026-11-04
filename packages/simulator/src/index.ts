/**
 * Simulated devices. Every real driver should be testable against one of
 * these, so CI never needs hardware.
 */
import { Clock, Effect } from "effect"
import type { Driver, Reading, SimulatedPoint, SimulatorDevice } from "@ot-gateway/core"
import { DriverError } from "@ot-gateway/core"

/** The value of a simulated point at a given time. Pure, so it is easy to test. */
export const waveformValue = (point: SimulatedPoint, timeMs: number): number => {
  const span = point.max - point.min
  const phase = ((timeMs / 1000) % point.periodSeconds) / point.periodSeconds
  switch (point.waveform) {
    case "constant":
      return point.min
    case "ramp":
      return point.min + span * phase
    case "sine":
      return point.min + span * (0.5 + 0.5 * Math.sin(2 * Math.PI * phase))
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
