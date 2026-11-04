/**
 * Generates `dashboards/plenum-gateway.json`, the "phocal / Plenum gateway" dashboard.
 *
 *   node observability/grafana/plenum-gateway.dashboard.ts
 *
 * Edit this file, not the JSON. Metric names and attributes come from
 * `packages/core/src/Telemetry.ts`; spans and logs from `runDevice` and the
 * gateway's OTLP layer (`apps/gateway/src/Telemetry.ts`).
 */
import { writeFileSync } from "node:fs"

interface Datasource {
  readonly type: string
  readonly uid: string
}

const prom: Datasource = { type: "prometheus", uid: "grafanacloud-prom" }
const loki: Datasource = { type: "loki", uid: "grafanacloud-logs" }
const tempo: Datasource = { type: "tempo", uid: "grafanacloud-traces" }

/** Series selector shared by every PromQL query. */
const sel =
  'service_namespace="plenum", deployment_environment=~"$environment", site=~"$site", building=~"$building", device=~"$device"'
/** For the gateway's own series (process and host), which have no `device`. */
const hostSel =
  'service_namespace="plenum", deployment_environment=~"$environment", site=~"$site", building=~"$building"'
const logSel = '{service_name="plenum-gateway", service_namespace="plenum", deployment_environment=~"$environment"}'

const panels: Array<Record<string, unknown>> = []
let nextId = 0
let y = 0

const row = (title: string) => {
  panels.push({ id: ++nextId, type: "row", title, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] })
  y += 1
}

const stat = (
  title: string,
  expr: string,
  options: {
    readonly unit: string
    readonly x: number
    readonly w?: number
    readonly description?: string
    readonly decimals?: number
    readonly thresholds?: ReadonlyArray<{ readonly color: string; readonly value: number | null }>
  }
) =>
  panels.push({
    id: ++nextId,
    type: "stat",
    title,
    description: options.description ?? "",
    datasource: prom,
    gridPos: { h: 4, w: options.w ?? 4, x: options.x, y },
    targets: [{ refId: "A", datasource: prom, expr, instant: true }],
    fieldConfig: {
      defaults: {
        unit: options.unit,
        decimals: options.decimals ?? 0,
        color: { mode: "thresholds" },
        thresholds: { mode: "absolute", steps: options.thresholds ?? [{ color: "text", value: null }] }
      },
      overrides: []
    },
    options: {
      reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
      colorMode: "value",
      graphMode: "none",
      textMode: "value"
    }
  })

const timeseries = (
  title: string,
  targets: ReadonlyArray<{ readonly expr: string; readonly legendFormat: string }>,
  options: {
    readonly unit: string
    readonly x: number
    readonly w: number
    readonly stack?: boolean
    readonly description?: string
  }
) =>
  panels.push({
    id: ++nextId,
    type: "timeseries",
    title,
    description: options.description ?? "",
    datasource: prom,
    gridPos: { h: 8, w: options.w, x: options.x, y },
    targets: targets.map((target, index) => ({ refId: String.fromCharCode(65 + index), datasource: prom, ...target })),
    fieldConfig: {
      defaults: {
        unit: options.unit,
        custom: {
          drawStyle: "line",
          fillOpacity: 10,
          lineWidth: 2,
          stacking: { mode: options.stack === true ? "normal" : "none" }
        }
      },
      overrides: []
    },
    options: {
      legend: { displayMode: "list", placement: "bottom", showLegend: true },
      tooltip: { mode: "multi", sort: "desc" }
    }
  })

const staleness = (
  title: string,
  expr: string,
  options: { readonly x: number; readonly w: number; readonly description: string }
) =>
  panels.push({
    id: ++nextId,
    type: "table",
    title,
    description: options.description,
    datasource: prom,
    gridPos: { h: 8, w: options.w, x: options.x, y },
    targets: [{ refId: "A", datasource: prom, expr, instant: true, format: "table" }],
    transformations: [
      {
        id: "organize",
        options: { excludeByName: { Time: true }, renameByName: { Value: "Seconds since last read" } }
      },
      { id: "sortBy", options: { sort: [{ field: "Seconds since last read", desc: true }] } }
    ],
    fieldConfig: {
      defaults: {
        unit: "s",
        decimals: 0,
        color: { mode: "thresholds" },
        thresholds: {
          mode: "absolute",
          steps: [
            { color: "green", value: null },
            { color: "orange", value: 60 },
            { color: "red", value: 300 }
          ]
        },
        custom: { cellOptions: { type: "color-text" } }
      },
      overrides: []
    },
    options: { showHeader: true }
  })

row("Health")
stat("Devices reporting", `count(max_over_time(plenum_device_last_success_timestamp_seconds{${sel}}[$__range]))`, {
  unit: "short",
  x: 0,
  description: "Devices that completed at least one successful cycle in the range."
})
stat("Stalest device", `max(time() - max_over_time(plenum_device_last_success_timestamp_seconds{${sel}}[$__range]))`, {
  unit: "s",
  x: 4,
  description:
    "Seconds since the device that has gone longest without a successful cycle last succeeded. Uses the last value in the range, so a stopped gateway turns red instead of disappearing.",
  thresholds: [
    { color: "green", value: null },
    { color: "orange", value: 60 },
    { color: "red", value: 300 }
  ]
})
stat(
  "Cycle success",
  `sum(rate(plenum_poll_cycles_total{${sel}, outcome="ok"}[$__range])) / sum(rate(plenum_poll_cycles_total{${sel}}[$__range]))`,
  {
    unit: "percentunit",
    x: 8,
    decimals: 1,
    thresholds: [
      { color: "red", value: null },
      { color: "orange", value: 0.95 },
      { color: "green", value: 0.99 }
    ]
  }
)
stat("Read failures (range)", `sum(increase(plenum_read_failures_total{${sel}}[$__range])) or vector(0)`, {
  unit: "short",
  x: 12,
  description: "Cycles whose device read still failed after retries."
})
stat("Publish failures (range)", `sum(increase(plenum_publish_failures_total{${sel}}[$__range])) or vector(0)`, {
  unit: "short",
  x: 16
})
stat(
  "Cycle p95",
  `histogram_quantile(0.95, sum by (le) (rate(plenum_poll_duration_seconds_bucket{${sel}}[$__range])))`,
  { unit: "s", x: 20, decimals: 3, description: "Includes driver retries and publishing." }
)
y += 4

row("Polling")
timeseries(
  "Cycles by outcome",
  [
    { expr: `sum by (outcome) (rate(plenum_poll_cycles_total{${sel}}[$__rate_interval]))`, legendFormat: "{{outcome}}" }
  ],
  {
    unit: "ops",
    x: 0,
    w: 8,
    stack: true,
    description:
      "timed_out: a cycle hung past the device's cycleTimeoutMs (a device or the broker side that never answers) and was abandoned."
  }
)
timeseries(
  "Read failures by device and reason",
  [
    {
      expr: `sum by (device, reason) (rate(plenum_read_failures_total{${sel}}[$__rate_interval]))`,
      legendFormat: "{{device}} {{reason}}"
    }
  ],
  { unit: "ops", x: 8, w: 8, stack: true }
)
timeseries(
  "Cycle duration p50 / p95 by device",
  [
    {
      expr: `histogram_quantile(0.5, sum by (device, le) (rate(plenum_poll_duration_seconds_bucket{${sel}}[$__rate_interval])))`,
      legendFormat: "p50 {{device}}"
    },
    {
      expr: `histogram_quantile(0.95, sum by (device, le) (rate(plenum_poll_duration_seconds_bucket{${sel}}[$__rate_interval])))`,
      legendFormat: "p95 {{device}}"
    }
  ],
  { unit: "s", x: 16, w: 8 }
)
y += 8
timeseries(
  "Values published vs suppressed by deadband",
  [
    { expr: `sum(rate(plenum_values_published_total{${sel}}[$__rate_interval]))`, legendFormat: "published" },
    { expr: `sum(rate(plenum_values_suppressed_total{${sel}}[$__rate_interval]))`, legendFormat: "suppressed" }
  ],
  {
    unit: "ops",
    x: 0,
    w: 12,
    stack: true,
    description:
      "A high suppressed share means the deadband is saving bandwidth; all published means it may be too tight."
  }
)
timeseries(
  "Seconds since last successful cycle",
  [
    {
      expr: `time() - max by (device) (plenum_device_last_success_timestamp_seconds{${sel}})`,
      legendFormat: "{{device}}"
    }
  ],
  { unit: "s", x: 12, w: 12 }
)
y += 8

row("Device links")
timeseries(
  "Device requests by outcome",
  [
    {
      expr: `sum by (device, outcome) (rate(plenum_driver_requests_total{${sel}}[$__rate_interval]))`,
      legendFormat: "{{device}} {{outcome}}"
    }
  ],
  {
    unit: "reqps",
    x: 0,
    w: 8,
    stack: true,
    description:
      "Every request a driver sent. exception = the device refused (check the point address); timeout and connection = it is unreachable."
  }
)
timeseries(
  "Connections opened by device",
  [
    {
      expr: `sum by (device, outcome) (increase(plenum_driver_connects_total{${sel}}[$__rate_interval]))`,
      legendFormat: "{{device}} {{outcome}}"
    }
  ],
  {
    unit: "short",
    x: 8,
    w: 8,
    stack: true,
    description:
      "A healthy link connects once. Repeated ok connects mean it keeps dropping; failed means it cannot connect. $bacnet is the one UDP socket every BACnet device shares."
  }
)
timeseries(
  "Pipeline restarts by device",
  [
    {
      expr: `sum by (device) (increase(plenum_device_restarts_total{${sel}}[$__rate_interval]))`,
      legendFormat: "{{device}}"
    }
  ],
  {
    unit: "short",
    x: 16,
    w: 8,
    description:
      "A device's pipeline died on a bug (a defect, not a device or broker failure) and was restarted with backoff, up to every 5 minutes. Any restart is a bug to report; the gateway log has the cause. Other devices keep running."
  }
)
y += 8
timeseries(
  "Device refusals by exception",
  [
    {
      expr: `sum by (device, exception) (increase(plenum_driver_refusals_total{${sel}}[$__rate_interval]))`,
      legendFormat: "{{device}} {{exception}}"
    }
  ],
  {
    unit: "short",
    x: 0,
    w: 12,
    stack: true,
    description:
      "Reads a device refused, after retries. illegal_data_address on every cycle means a point address is wrong; busy and gateway exceptions come and go. The log has one warning when a refusal starts, not one per cycle."
  }
)
timeseries(
  "Mean request time by device",
  [
    {
      expr: `sum by (device) (rate(plenum_driver_request_seconds_total{${sel}}[$__rate_interval])) / sum by (device) (rate(plenum_driver_requests_total{${sel}}[$__rate_interval]))`,
      legendFormat: "{{device}}"
    }
  ],
  {
    unit: "s",
    x: 12,
    w: 12,
    description:
      "How long one request takes, from sending (and connecting, if need be) to the answer. A slow device or Modbus gateway shows here; a cycle that is slow because it sends many requests does not. Timeouts count at their full length."
  }
)
y += 8

row("Broker")
timeseries(
  "Connected to the MQTT broker",
  [
    {
      expr: `max by (service_instance_id) (plenum_mqtt_connected{${sel}})`,
      legendFormat: "{{service_instance_id}}"
    }
  ],
  {
    unit: "bool_yes_no",
    x: 0,
    w: 12,
    description:
      "1 while the gateway holds a broker connection. While it is 0, values go to the store-and-forward buffer if one is configured, and are lost otherwise."
  }
)
timeseries(
  "Broker connection attempts by outcome",
  [
    {
      expr: `sum by (outcome) (increase(plenum_mqtt_connects_total{${sel}}[$__rate_interval]))`,
      legendFormat: "{{outcome}}"
    }
  ],
  {
    unit: "short",
    x: 12,
    w: 12,
    stack: true,
    description:
      "A healthy gateway connects once. Repeated ok means the connection keeps dropping; failed means the broker is unreachable; rejected means it refused (check credentials)."
  }
)
y += 8

row("Commands")
timeseries(
  "Commands by outcome",
  [
    {
      expr: `sum by (outcome) (increase(plenum_commands_total{${sel}}[$__rate_interval]))`,
      legendFormat: "{{outcome}}"
    }
  ],
  {
    unit: "short",
    x: 0,
    w: 12,
    stack: true,
    description:
      "Commands received on site/building/device/point/$set. written reached the device; rejected was refused by the command guard (not writable, out of range, wrong type, retained, expired after waiting too long) and never reached it; failed could not be written (device down, refused, no answer); dropped arrived while too many were already waiting (a flood) and got no result."
  }
)
timeseries(
  "Rejected and failed commands by reason",
  [
    {
      expr: `sum by (outcome, reason) (increase(plenum_commands_total{${sel}, outcome!="written"}[$__rate_interval]))`,
      legendFormat: "{{outcome}}: {{reason}}"
    }
  ],
  {
    unit: "short",
    x: 12,
    w: 12,
    stack: true,
    description:
      "Why commands did not get through. retained on every reconnect means a retained message sits on a $set topic: clear it on the broker. Every command is also in the logs."
  }
)
y += 8

row("Buffer")
timeseries(
  "Messages waiting in the buffer",
  [
    {
      expr: `max by (service_instance_id) (plenum_buffer_rows{${sel}})`,
      legendFormat: "{{service_instance_id}}"
    }
  ],
  {
    unit: "short",
    x: 0,
    w: 12,
    description:
      "Rows in the SQLite outbox. It grows during a broker outage and falls back to 0 once the gateway has delivered them. A line that stays above 0 while the broker is connected means draining is stuck."
  }
)
timeseries(
  "Buffer traffic",
  [
    {
      expr: `sum(increase(plenum_buffer_written_total{${sel}}[$__rate_interval]))`,
      legendFormat: "stored"
    },
    {
      expr: `sum(increase(plenum_buffer_drained_total{${sel}}[$__rate_interval]))`,
      legendFormat: "delivered"
    },
    {
      expr: `sum by (reason) (increase(plenum_buffer_dropped_total{${sel}}[$__rate_interval]))`,
      legendFormat: "dropped: {{reason}}"
    }
  ],
  {
    unit: "short",
    x: 12,
    w: 12,
    description:
      "Stored during an outage, delivered after it. Dropped means data was lost: overflow when the outbox passed buffer.maxRows, rejected when the broker refused a stored message, unreadable when a stored row no longer decoded, undeliverable when a row broke the connection three times in a row, lost when the buffer file was corrupt or replaced."
  }
)
y += 8
timeseries(
  "Buffer store failures",
  [
    {
      expr: `sum by (operation) (increase(plenum_buffer_failures_total{${sel}}[$__rate_interval]))`,
      legendFormat: "{{operation}}"
    },
    {
      expr: `sum(increase(plenum_buffer_bypassed_total{${sel}}[$__rate_interval]))`,
      legendFormat: "published past the buffer"
    }
  ],
  {
    unit: "short",
    x: 0,
    w: 12,
    stack: true,
    description:
      "Failed SQLite operations on the outbox (a full disk, a busy or broken file). While inserts fail, live values go straight to the broker instead (published past the buffer); while deletes fail, delivered rows are remembered in memory and not sent again."
  }
)
timeseries(
  "Running without a buffer",
  [
    {
      expr: `max by (service_instance_id) (plenum_buffer_disabled{${sel}})`,
      legendFormat: "{{service_instance_id}}"
    }
  ],
  {
    unit: "bool_yes_no",
    x: 12,
    w: 12,
    description:
      "1 while the buffer file cannot be opened, so values published during a broker outage are lost. The gateway retries every 30 seconds; the error log says why."
  }
)
y += 8

row("Freshness")
staleness(
  "Device freshness",
  `time() - max by (device) (max_over_time(plenum_device_last_success_timestamp_seconds{${sel}}[$__range]))`,
  {
    x: 0,
    w: 12,
    description:
      "Seconds since each device last completed a successful cycle. Orange after 1 minute, red after 5. There is no per-point age (one series per point would not fit the free plan); a point that stops reading inside a working device shows in Points not read and in the log."
  }
)
timeseries(
  "Points not read by device",
  [
    {
      expr: `sum by (device, reason) (increase(plenum_point_read_failures_total{${sel}}[$__rate_interval]))`,
      legendFormat: "{{device}} {{reason}}"
    }
  ],
  {
    unit: "short",
    x: 12,
    w: 12,
    description:
      "Points a device did not deliver, by reason. refused: it answered without a value (unknown object or property, a value that is not a number). not_finite: the value was NaN or Infinity, also after scaling, and was not published. The gateway log names each point once when it starts and stops failing. not_read: the device stopped answering or was busy partway through a cycle, so the rest waited for the next one. A device that does not answer at all is counted under read failures, not per point."
  }
)
y += 8
timeseries(
  "Values pushed by device",
  [
    {
      expr: `sum by (device) (increase(plenum_pushed_readings_total{${sel}}[$__rate_interval]))`,
      legendFormat: "{{device}}"
    }
  ],
  {
    unit: "short",
    x: 0,
    w: 12,
    description:
      "Values devices sent on their own between polls (BACnet change-of-value notifications), before the deadband. Each subscription also sends its current value when it is made or renewed."
  }
)
timeseries(
  "Points pushed instead of polled",
  [
    {
      expr: `max by (device) (plenum_pushed_points{${sel}})`,
      legendFormat: "{{device}}"
    }
  ],
  {
    unit: "short",
    x: 12,
    w: 12,
    description:
      "Points kept up to date by a live change-of-value subscription, which the polling cycle skips. A drop means the device refused or stopped sending notifications, and those points are polled again."
  }
)
y += 8

row("Host")
timeseries(
  "Gateway memory",
  [
    {
      expr: `max by (service_instance_id, kind) (plenum_process_memory_bytes{${hostSel}})`,
      legendFormat: "{{service_instance_id}} {{kind}}"
    }
  ],
  {
    unit: "bytes",
    x: 0,
    w: 8,
    description:
      "Resident memory (rss) and V8 heap in use. Both should level off within an hour of a start; a steady climb over days is a leak."
  }
)
timeseries(
  "Event loop lag",
  [
    {
      expr: `max by (service_instance_id, quantile) (plenum_event_loop_lag_seconds{${hostSel}})`,
      legendFormat: "{{service_instance_id}} {{quantile}}"
    }
  ],
  {
    unit: "s",
    x: 8,
    w: 8,
    description:
      "The worst event-loop delay of the last minute. Every device, keepalive and deadline shares the loop: a p99 above 50 ms on a Pi is worth a look, a max above 1 s is logged as a stall."
  }
)
timeseries(
  "Gateway CPU",
  [
    {
      expr: `sum by (service_instance_id) (rate(plenum_process_cpu_seconds_total{${hostSel}}[$__rate_interval]))`,
      legendFormat: "{{service_instance_id}}"
    }
  ],
  {
    unit: "percentunit",
    x: 16,
    w: 8,
    description: "Share of one CPU core the gateway process uses, user and system time together."
  }
)
y += 8
timeseries(
  "SoC temperature",
  [
    {
      expr: `max by (service_instance_id) (plenum_host_temperature_celsius{${hostSel}})`,
      legendFormat: "{{service_instance_id}}"
    }
  ],
  {
    unit: "celsius",
    x: 0,
    w: 6,
    description: "The first thermal zone. A Raspberry Pi 4 starts throttling at 80 °C; the log warns at 80 °C."
  }
)
timeseries(
  "Power and thermal conditions (Raspberry Pi)",
  [
    {
      expr: `max by (service_instance_id, condition) (max_over_time(plenum_host_throttled{${hostSel}}[$__rate_interval]))`,
      legendFormat: "{{service_instance_id}} {{condition}}"
    }
  ],
  {
    unit: "bool_yes_no",
    x: 6,
    w: 6,
    description:
      "What the Raspberry Pi firmware reports: under_voltage (a weak power supply or cable, the most common cause of SD corruption), frequency_capped, throttled, soft_temperature_limit. On kernel 6.18 and later only under_voltage (the kernel shows no more); empty off a Pi."
  }
)
timeseries(
  "Outbox disk free",
  [
    {
      expr: `min by (service_instance_id) (plenum_buffer_disk_free_bytes{${hostSel}})`,
      legendFormat: "{{service_instance_id}}"
    }
  ],
  {
    unit: "bytes",
    x: 12,
    w: 6,
    description: "Free space on the filesystem that holds the store-and-forward outbox. The log warns below 64 MiB."
  }
)
timeseries(
  "Storage writes",
  [
    {
      expr: `sum by (service_instance_id) (rate(plenum_process_disk_written_bytes_total{${hostSel}}[$__rate_interval]))`,
      legendFormat: "{{service_instance_id}}"
    }
  ],
  {
    unit: "Bps",
    x: 18,
    w: 6,
    description:
      "Bytes the gateway writes to storage: what wears an SD card. Near zero while the broker is up (the outbox is only written during outages), high while it buffers."
  }
)
y += 8
timeseries(
  "Open files",
  [
    {
      expr: `max by (service_instance_id) (plenum_process_open_fds{${hostSel}})`,
      legendFormat: "{{service_instance_id}}"
    }
  ],
  {
    unit: "short",
    x: 0,
    w: 8,
    description:
      "File descriptors the gateway holds, sockets included. Flat in a healthy gateway; a slow climb is a leak."
  }
)
timeseries(
  "Wall-clock steps",
  [
    {
      expr: `sum by (service_instance_id, direction) (increase(plenum_clock_steps_total{${hostSel}}[$__rate_interval]))`,
      legendFormat: "{{service_instance_id}} {{direction}}"
    }
  ],
  {
    unit: "short",
    x: 8,
    w: 8,
    stack: true,
    description:
      "NTP setting the time of a machine without a real-time clock: normal once after boot. Timestamps jump with each step; deadlines and backoffs do not, they use the monotonic clock."
  }
)
panels.push({
  id: ++nextId,
  type: "table",
  title: "Gateways: version and start",
  description:
    "Which build each gateway runs, and when it last started. A start time that keeps changing is a gateway that restarts.",
  datasource: prom,
  gridPos: { h: 8, w: 8, x: 16, y },
  targets: [
    {
      refId: "A",
      datasource: prom,
      expr: `max by (service_instance_id, version, node) (plenum_process_start_time_seconds{${hostSel}}) * 1000`,
      instant: true,
      format: "table"
    }
  ],
  transformations: [{ id: "organize", options: { excludeByName: { Time: true }, renameByName: { Value: "Started" } } }],
  fieldConfig: { defaults: { unit: "dateTimeAsIso" }, overrides: [] },
  options: { showHeader: true }
})
y += 8

row("Logs and traces")
panels.push({
  id: ++nextId,
  type: "logs",
  title: "Warnings and errors",
  datasource: loki,
  gridPos: { h: 8, w: 24, x: 0, y },
  targets: [{ refId: "A", datasource: loki, expr: `${logSel} | detected_level=~"warn|error|fatal"` }],
  options: { showTime: true, wrapLogMessage: true, enableLogDetails: true, sortOrder: "Descending" }
})
y += 8
panels.push({
  id: ++nextId,
  type: "table",
  title: "Failed polling cycles (traces)",
  description: "Device.pollCycle spans annotated with plenum.outcome. Click a trace ID for the span and its logs.",
  datasource: tempo,
  gridPos: { h: 8, w: 24, x: 0, y },
  targets: [
    {
      refId: "A",
      datasource: tempo,
      queryType: "traceql",
      limit: 50,
      tableType: "traces",
      query: '{resource.service.name="plenum-gateway" && name="Device.pollCycle" && span.plenum.outcome != nil}'
    }
  ],
  fieldConfig: { defaults: {}, overrides: [] },
  options: { showHeader: true, sortBy: [{ displayName: "Start time", desc: true }] }
})

const variable = (name: string, label: string, query: string) => ({
  name,
  label,
  type: "query",
  datasource: prom,
  query: { query, refId: name },
  includeAll: true,
  multi: true,
  current: { text: "All", value: "$__all" },
  allValue: ".*",
  refresh: 2,
  sort: 1
})

const dashboard = {
  uid: "phocal-plenum-gateway",
  title: "phocal / Plenum gateway",
  tags: ["phocal", "plenum", "gateway"],
  description:
    "Plenum gateway telemetry (Effect OTLP -> Grafana Cloud). Source: plenum/observability/grafana/plenum-gateway.dashboard.ts",
  timezone: "browser",
  schemaVersion: 39,
  editable: true,
  refresh: "30s",
  time: { from: "now-6h", to: "now" },
  templating: {
    list: [
      variable(
        "environment",
        "Environment",
        'label_values(plenum_poll_cycles_total{service_namespace="plenum"}, deployment_environment)'
      ),
      variable("site", "Site", 'label_values(plenum_poll_cycles_total{service_namespace="plenum"}, site)'),
      variable(
        "building",
        "Building",
        'label_values(plenum_poll_cycles_total{service_namespace="plenum", site=~"$site"}, building)'
      ),
      variable(
        "device",
        "Device",
        'label_values(plenum_poll_cycles_total{service_namespace="plenum", site=~"$site", building=~"$building"}, device)'
      )
    ]
  },
  panels
}

const target = new URL("dashboards/plenum-gateway.json", import.meta.url)
writeFileSync(target, `${JSON.stringify(dashboard, null, 2)}\n`)
console.log(`wrote ${target.pathname} (${panels.length} panels)`)
