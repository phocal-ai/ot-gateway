/**
 * Gateway metrics (VISION.md, principle 5: observable by default).
 *
 * Plain Effect metrics with no exporter dependency: the gateway app decides
 * where they go (OTLP today). Every series carries the attributes in
 * `Metric.CurrentMetricAttributes`: `site` and `building` from the gateway,
 * `device` from `runDevice`. Names follow the Prometheus conventions that
 * Grafana's OTLP endpoint maps to: counters gain `_total`, units are suffixes.
 */
import { Effect, Metric } from "effect"

/**
 * Effect exports a metric without a `unit` attribute as unit "1", which
 * Grafana turns into a `_ratio` name suffix on gauges. Set it explicitly on
 * every metric measured in seconds.
 */
const seconds = { unit: "seconds" } as const

/** Polling cycles finished, by `outcome`: `ok`, `read_failed` or `publish_failed`. */
export const pollCycles = Metric.counter("plenum_poll_cycles", {
  description: "Polling cycles finished, by outcome",
  incremental: true
})

/** Wall time of one cycle, including driver retries and publishing. */
export const pollDuration = Metric.histogram("plenum_poll_duration_seconds", {
  description: "Duration of one polling cycle, including retries",
  attributes: seconds,
  boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]
})

/** Driver read failures after retries were exhausted, by `reason` (the `DriverError` reason). */
export const readFailures = Metric.counter("plenum_read_failures", {
  description: "Device reads that failed after retries, by reason",
  incremental: true
})

/** Messages that could not be published northbound. */
export const publishFailures = Metric.counter("plenum_publish_failures", {
  description: "Messages that failed to publish",
  incremental: true
})

/** Point values published because they changed by more than the deadband. */
export const valuesPublished = Metric.counter("plenum_values_published", {
  description: "Point values published",
  incremental: true
})

/** Point values read but not published because they stayed inside the deadband. */
export const valuesSuppressed = Metric.counter("plenum_values_suppressed", {
  description: "Point values suppressed by the deadband",
  incremental: true
})

/**
 * Unix time of the last successful read, per `point`. Staleness is
 * `time() - plenum_point_last_read_timestamp_seconds`; one series per point.
 */
export const pointLastRead = Metric.gauge("plenum_point_last_read_timestamp_seconds", {
  description: "Unix time of the last successful read of a point",
  attributes: seconds
})

/** Unix time of the last cycle that read the device successfully. */
export const deviceLastSuccess = Metric.gauge("plenum_device_last_success_timestamp_seconds", {
  description: "Unix time of the last successful polling cycle of a device",
  attributes: seconds
})

/** Add attributes to every metric updated inside `effect`, keeping the ones already set. */
export const withMetricAttributes =
  (attributes: Metric.Metric.AttributeSet) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.updateService(effect, Metric.CurrentMetricAttributes, (current) => ({ ...current, ...attributes }))
