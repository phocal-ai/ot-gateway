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
import { monotonicMillis } from "./Monotonic.ts"

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
 * Points a cycle did not get a value for while the device was reachable, by
 * `reason`: `refused` (the device answered without one, e.g. an unknown
 * object or a value that is not a number), `not_read` (it stopped answering
 * or was busy partway through the cycle) or `not_finite` (NaN or Infinity,
 * also after scaling; never published). A device that does not answer at all
 * is a read failure, not a point failure. Without a `point`
 * attribute, to keep the series count flat; the log says which point.
 */
export const pointReadFailures = Metric.counter("plenum_point_read_failures", {
  description: "Points a reachable device did not deliver in a cycle, by reason",
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
 * Seconds spent waiting for field devices, summed over every request (any
 * outcome, connecting included). One series per device:
 * `rate(plenum_driver_request_seconds_total) / rate(plenum_driver_requests_total)`
 * is the mean time a request takes, which tells a slow device from a cycle
 * that is slow because it sends many requests.
 */
export const driverRequestSeconds = Metric.counter("plenum_driver_request_seconds", {
  description: "Time spent on requests to field devices",
  attributes: seconds,
  incremental: true
})

/** Add the time `effect` took to `plenum_driver_request_seconds`, whatever its outcome. */
export const timeRequest = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(monotonicMillis, (start) =>
    Effect.ensuring(
      effect,
      Effect.flatMap(monotonicMillis, (end) => Metric.update(driverRequestSeconds, Math.max(0, end - start) / 1000))
    )
  )

/**
 * Reads a device refused, by `exception` (for Modbus the exception name, e.g.
 * `illegal_data_address`). Counted once per refused block and read, after
 * retries; the driver logs a refusal only when it starts and when it ends.
 */
export const driverRefusals = Metric.counter("plenum_driver_refusals", {
  description: "Reads a field device refused, by exception",
  incremental: true
})

/**
 * Connection attempts to a device, by `outcome`: `ok` or `failed`. A rising `ok` count means the link keeps
 * dropping. Devices behind one Modbus gateway share a connection; it is counted under the device whose request
 * opened it.
 */
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

/**
 * Commands received on `.../$set`, by `outcome`: `written`, `rejected` (the
 * command guard refused it: not writable, out of range, wrong type, a
 * retained message) or `failed` (the device could not be written), and by
 * `reason` for the last two. Every command is also logged.
 */
export const commands = Metric.counter("plenum_commands", {
  description: "Commands received over MQTT, by outcome and reason",
  incremental: true
})

/*
 * The gateway process and the machine it runs on: one series each per gateway
 * (no `device`), sampled every 15 seconds by the gateway's host monitor. What
 * the machine cannot tell (no thermal zone, no Raspberry Pi firmware, not
 * Linux) is not exported, rather than exported as 0.
 */

const bytes = { unit: "bytes" } as const

/** Memory of the gateway process, by `kind`: `rss` (resident) or `heap` (V8 heap in use). */
export const processMemory = Metric.gauge("plenum_process_memory_bytes", {
  description: "Memory of the gateway process, by kind",
  attributes: bytes
})

/** CPU time the gateway process used, user and system together. */
export const processCpu = Metric.counter("plenum_process_cpu_seconds", {
  description: "CPU time used by the gateway process",
  attributes: seconds,
  incremental: true
})

/** Open file descriptors (sockets included); a steady rise is a leak. Linux only. */
export const processOpenFds = Metric.gauge("plenum_process_open_fds", {
  description: "File descriptors the gateway process holds open",
  attributes: { unit: "{fd}" }
})

/**
 * Bytes the gateway process caused to be written to storage (`write_bytes` in
 * `/proc/self/io`): what wears out an SD card. Linux only.
 */
export const processDiskWritten = Metric.counter("plenum_process_disk_written_bytes", {
  description: "Bytes the gateway process wrote to storage",
  attributes: bytes,
  incremental: true
})

/**
 * Unix time the gateway started, with `version` (the gateway's) and `node`
 * attributes: a restart shows as a new value, an upgrade as a new series.
 */
export const processStart = Metric.gauge("plenum_process_start_time_seconds", {
  description: "Unix time the gateway process started, by version",
  attributes: seconds
})

/**
 * How late the event loop ran timers, by `quantile`: `p99` and `max`, the
 * worst over the last minute. Everything in the gateway shares one loop, so
 * a lag of seconds delays every device, keepalive and deadline.
 */
export const eventLoopLag = Metric.gauge("plenum_event_loop_lag_seconds", {
  description: "Event loop delay over the last minute, by quantile",
  attributes: seconds
})

/**
 * Steps of the wall clock against the monotonic one, by `direction`
 * (`forward` or `backward`): NTP setting the time of a machine without a
 * real-time clock. Each step is also logged with its size.
 */
export const clockSteps = Metric.counter("plenum_clock_steps", {
  description: "Steps of the wall clock, by direction",
  incremental: true
})

/** Temperature of the SoC (the first thermal zone). */
export const hostTemperature = Metric.gauge("plenum_host_temperature_celsius", {
  description: "Temperature of the host's SoC",
  attributes: { unit: "celsius" }
})

/**
 * 1 while the Raspberry Pi firmware reports a `condition`, else 0:
 * `under_voltage`, `frequency_capped`, `throttled` or `soft_temperature_limit`.
 * Only on a Raspberry Pi kernel.
 */
export const hostThrottled = Metric.gauge("plenum_host_throttled", {
  description: "Whether the Raspberry Pi firmware reports a power or thermal condition",
  attributes: { unit: "{state}" }
})

/** Free space on the filesystem that holds the outbox, for the gateway's user. Only with a buffer. */
export const bufferDiskFree = Metric.gauge("plenum_buffer_disk_free_bytes", {
  description: "Free space on the outbox's filesystem",
  attributes: bytes
})

/** Add attributes to every metric updated inside `effect`, keeping the ones already set. */
export const withMetricAttributes =
  (attributes: Metric.Metric.AttributeSet) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.updateService(effect, Metric.CurrentMetricAttributes, (current) => ({ ...current, ...attributes }))
