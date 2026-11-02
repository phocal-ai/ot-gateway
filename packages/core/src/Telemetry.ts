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

/**
 * Polling cycles finished, by `outcome`: `ok`, `read_failed`, `publish_failed`
 * or `timed_out` (the cycle hung past the device's `cycleTimeoutMs` and was abandoned).
 */
export const pollCycles = Metric.counter("plenum_poll_cycles", {
  description: "Polling cycles finished, by outcome",
  incremental: true
})

/** Wall time of one cycle, including driver retries and publishing. */
export const pollDuration = Metric.histogram("plenum_poll_duration_seconds", {
  description: "Duration of one polling cycle, including retries",
  attributes: seconds,
  // Five buckets (8 series per device with sum and count): enough to tell a fast device from one that
  // retries or nears its cycle deadline, at half the cost of a finer histogram.
  boundaries: [0.05, 0.25, 1, 5, 30]
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

/**
 * Times a device's pipeline died on a defect (a bug, not a device or broker
 * failure) and was restarted. Any increase is a bug to report; the log has
 * the cause.
 */
export const deviceRestarts = Metric.counter("plenum_device_restarts", {
  description: "Device pipelines restarted after a defect",
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

/**
 * Reads a device refused, by `exception` (for Modbus the exception name, e.g.
 * `illegal_data_address`). Counted once per refused block and read, after
 * retries; the driver logs a refusal only when it starts and when it ends.
 */
export const driverRefusals = Metric.counter("plenum_driver_refusals", {
  description: "Reads a field device refused, by exception",
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
 * past `buffer.maxRows`), `rejected` (the broker refused the message),
 * `unreadable` (a row that no longer decodes), `undeliverable` (a row that
 * was in flight each time the connection broke, three times in a row: a
 * poison message) or `lost` (rows in a file that was replaced or corrupted
 * while the gateway ran).
 */
export const bufferDropped = Metric.counter("plenum_buffer_dropped", {
  description: "Messages dropped from the outbox, by reason",
  incremental: true
})

/**
 * Outbox operations that failed, by `operation`: `insert`, `delete`, `read`
 * or `open`. A full or locked disk shows up here first.
 */
export const bufferFailures = Metric.counter("plenum_buffer_failures", {
  description: "Outbox operations that failed, by operation",
  incremental: true
})

/** Messages sent straight to the broker because the outbox could not store them (disk full, say). */
export const bufferBypassed = Metric.counter("plenum_buffer_bypassed", {
  description: "Messages published past the outbox because it could not store them",
  incremental: true
})

/**
 * 1 while the gateway runs without its outbox because the file could not be
 * opened, else 0. Values published during an outage are lost meanwhile.
 */
export const bufferDisabled = Metric.gauge("plenum_buffer_disabled", {
  description: "Whether the gateway runs without its store-and-forward outbox",
  attributes: { unit: "{state}" }
})

/** Add attributes to every metric updated inside `effect`, keeping the ones already set. */
export const withMetricAttributes =
  (attributes: Metric.Metric.AttributeSet) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.updateService(effect, Metric.CurrentMetricAttributes, (current) => ({ ...current, ...attributes }))
