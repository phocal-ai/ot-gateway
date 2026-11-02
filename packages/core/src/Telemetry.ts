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

/**
 * Points a cycle could not read although the device answered, e.g. an
 * unknown object, a value that is not a number, or one that is not finite
 * (NaN or Infinity, also after scaling). Without a `point`
 * attribute, to keep the series count flat; the log says which point.
 */
export const pointReadFailures = Metric.counter("plenum_point_read_failures", {
  description: "Points a device could not read in an otherwise successful cycle",
  incremental: true
})

/** Values a device pushed between polls (BACnet change-of-value), before the deadband. */
export const pushedReadings = Metric.counter("plenum_pushed_readings", {
  description: "Values pushed by devices between polls",
  incremental: true
})

/**
 * Points a device currently pushes (a live change-of-value subscription), so
 * the polling cycle skips them. A UCUM annotation unit, so no `_ratio` suffix.
 */
export const pushedPoints = Metric.gauge("plenum_pushed_points", {
  description: "Points kept up to date by device pushes instead of polling",
  attributes: { unit: "{point}" }
})

/**
 * Requests a driver sent to its device, by `outcome`: `ok`, `timeout`,
 * `exception` (the device refused), `invalid_response` or `connection`.
 * Drivers count requests instead of opening a span per request, which would
 * multiply trace volume; the cycle span carries the request count.
 */
export const driverRequests = Metric.counter("plenum_driver_requests", {
  description: "Requests sent to field devices, by outcome",
  incremental: true
})

/** Connection attempts to a device, by `outcome`: `ok` or `failed`. A rising `ok` count means the link keeps dropping. */
export const driverConnects = Metric.counter("plenum_driver_connects", {
  description: "Connection attempts to field devices, by outcome",
  incremental: true
})

/**
 * Connection attempts to the MQTT broker, by `outcome`: `ok`, `failed` (network
 * or timeout) or `rejected` (the broker refused, e.g. bad credentials).
 */
export const mqttConnects = Metric.counter("plenum_mqtt_connects", {
  description: "Connection attempts to the MQTT broker, by outcome",
  incremental: true
})

/**
 * 1 while the gateway holds a broker connection, else 0. The unit is a UCUM
 * annotation, which Grafana's OTLP translation drops, so the name gets no
 * `_ratio` suffix.
 */
export const mqttConnected = Metric.gauge("plenum_mqtt_connected", {
  description: "Whether the gateway is connected to the MQTT broker",
  attributes: { unit: "{connection}" }
})

/** Messages waiting in the store-and-forward outbox. A UCUM annotation unit, so no `_ratio` suffix. */
export const bufferRows = Metric.gauge("plenum_buffer_rows", {
  description: "Messages waiting in the store-and-forward outbox",
  attributes: { unit: "{row}" }
})

/** Messages written to the outbox because the broker was unavailable (or older ones were still waiting). */
export const bufferWritten = Metric.counter("plenum_buffer_written", {
  description: "Messages stored in the outbox",
  incremental: true
})

/** Messages from the outbox that reached the broker. */
export const bufferDrained = Metric.counter("plenum_buffer_drained", {
  description: "Messages from the outbox delivered to the broker",
  incremental: true
})

/**
 * Messages the outbox gave up on, by `reason`: `overflow` (the oldest rows,
 * past `buffer.maxRows`), `rejected` (the broker refused the message) or
 * `unreadable` (a row that no longer decodes).
 */
export const bufferDropped = Metric.counter("plenum_buffer_dropped", {
  description: "Messages dropped from the outbox, by reason",
  incremental: true
})

/** Add attributes to every metric updated inside `effect`, keeping the ones already set. */
export const withMetricAttributes =
  (attributes: Metric.Metric.AttributeSet) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.updateService(effect, Metric.CurrentMetricAttributes, (current) => ({ ...current, ...attributes }))
