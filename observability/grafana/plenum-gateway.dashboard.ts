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
  { unit: "ops", x: 0, w: 8, stack: true }
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
    w: 12,
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
    x: 12,
    w: 12,
    stack: true,
    description:
      "A healthy link connects once. Repeated ok connects mean it keeps dropping; failed means it cannot connect."
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
      "1 while the gateway holds a broker connection. Publishes fail while it is 0, and values are retried next cycle."
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

row("Points")
staleness(
  "Point freshness",
  `time() - max by (device, point) (max_over_time(plenum_point_last_read_timestamp_seconds{${sel}}[$__range]))`,
  {
    x: 0,
    w: 24,
    description: "Seconds since each point was last read successfully. Orange after 1 minute, red after 5."
  }
)
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
