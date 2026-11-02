---
name: health
description: Check Plenum's observability through the Grafana MCP. Covers gateway health (stale devices, failing reads or publishes, warnings), Claude Code sessions in this repo (token usage, failing tools and hooks), and a projection of Grafana Cloud free-plan usage against its quotas. Use for "/health", "is everything healthy", "check the dashboards", "are we within the free tier", "grafana usage".
allowed-tools: mcp__grafana__query_prometheus, mcp__grafana__query_loki_logs, mcp__grafana__query_tempo_metrics, mcp__grafana__search_tempo_traces, mcp__grafana__list_prometheus_metric_names, mcp__grafana__list_prometheus_label_values
---

Check health through the read-only Grafana MCP and report findings, not raw query dumps. Run the queries in each section in parallel. All of them were verified against the stack. If one returns nothing, say what that means (see the notes) rather than guessing.

Datasource UIDs: `grafanacloud-prom` (metrics), `grafanacloud-logs` (Loki), `grafanacloud-traces` (Tempo), `grafanacloud-usage` (billing).

The window is the last 24h unless the user names another. Use `$W` below for that window.

## 1. Free-plan budget (always run; this is the priority)

The stack is on the Grafana Cloud free plan (`observability/README.md`, "Free-plan budget"). Logs and traces usage is month-to-date GB and resets on the 1st.

Instant query on `grafanacloud-usage`:

```promql
label_replace(max_over_time(grafanacloud_instance_active_series[1d]) / on() group_left grafanacloud_org_metrics_included_series, "q", "series_peak_ratio", "", "")
or label_replace(avg_over_time(sum(grafanacloud_instance_samples_per_second)[1d:5m]) * 60 / avg_over_time(sum(grafanacloud_instance_active_series)[1d:5m]), "q", "dpm_per_series_1d_avg", "", "")
or label_replace(grafanacloud_org_metrics_billable_series, "q", "billable_series", "", "")
or label_replace(grafanacloud_org_logs_usage / scalar((day_of_month() - 1) + hour() / 24 + minute() / 1440) * scalar(days_in_month()), "q", "logs_gb_month_projection", "", "")
or label_replace(clamp_min(delta(grafanacloud_org_logs_usage[1d]), 0) * scalar(days_in_month()), "q", "logs_gb_month_at_24h_rate", "", "")
or label_replace(grafanacloud_org_traces_usage / scalar((day_of_month() - 1) + hour() / 24 + minute() / 1440) * scalar(days_in_month()), "q", "traces_gb_month_projection", "", "")
or label_replace(clamp_min(delta(grafanacloud_org_traces_usage[1d]), 0) * scalar(days_in_month()), "q", "traces_gb_month_at_24h_rate", "", "")
or label_replace(grafanacloud_org_metrics_overage + grafanacloud_org_logs_overage + grafanacloud_org_traces_overage, "q", "overage", "", "")
```

Limits: 10,000 series, 1 DPM per series, 50 GB logs, 50 GB traces. **Project with the higher of the two log/trace numbers.** On days 1–2 of the month the month-to-date number is noisy, and the 24h rate is the better signal.

| Projection of a quota | Verdict                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| < 70%                 | OK                                                                                                              |
| 70–90%                | **Warn.** Name the top consumer and the cheapest fix                                                            |
| ≥ 90%, or overage > 0 | **Act now.** Propose the fix as a change; the user's rule is to optimize _before_ the quota runs out, not after |

`billable_series` is what Grafana bills; it already folds DPM in, so compare it against 10,000 too. `dpm_per_series_1d_avg` is a 1-day average because the instant sample rate is bursty (peaks above 1 are normal). An average above 1 means some job exports faster than once a minute and is billed multiple times. Find the top consumers on `grafanacloud-prom`:

- Series: `topk(10, count by (job) ({__name__=~".+"}))`
- Per-metric for one job: `topk(10, count by (__name__) ({job="<job>"}))`

Fixes, cheapest first:

1. Export interval of 60s (`OTEL_METRIC_EXPORT_INTERVAL`).
2. Trace sampling (`OTEL_TRACES_SAMPLER=traceidratio`, `OTEL_TRACES_SAMPLER_ARG`).
3. Drop a high-cardinality attribute or the histogram buckets.
4. Fewer warning logs for a device that stays down.

## 2. Gateway health

Metrics are `plenum_*` on `grafanacloud-prom`, labelled `site`, `building`, `device` and `deployment_environment`. Instant queries:

- **Running gateways:** `count by (instance, deployment_environment) (plenum_device_last_success_timestamp_seconds)`. Empty means no gateway has exported in the last ~5 min; then report "not running" (normal on a dev laptop), not "unhealthy". Then check `max_over_time(plenum_device_last_success_timestamp_seconds[$W])` to say when it was last seen.
- **Stale devices** (no successful read for over 2 min): `time() - max by (site, building, device) (plenum_device_last_success_timestamp_seconds) > 120`
- **Cycle outcomes:** `sum by (device, outcome) (increase(plenum_poll_cycles_total[$W]))`. Any non-`ok` outcome is a finding; give its share of the device's cycles.
- **Read failures by reason:** `sum by (device, reason) (increase(plenum_read_failures_total[$W]))`
- **Publish failures:** `sum by (device) (increase(plenum_publish_failures_total[$W]))`
- **Slow polls:** `histogram_quantile(0.95, sum by (device, le) (rate(plenum_poll_duration_seconds_bucket[$W])))`. Flag p95 above half the poll interval.

Logs on `grafanacloud-logs` (`service_name="plenum-gateway"`; `device`, `reason` and `error` are structured metadata):

- **Warning counts:** `sum by (detected_level) (count_over_time({service_name="plenum-gateway"} [$W]))`
- **The latest warnings**, limit 10: `{service_name="plenum-gateway"} | detected_level=~"warn|error"`

Traces on `grafanacloud-traces`: failed cycles carry `span.plenum.outcome`. To get an example trace ID for a finding, run `{resource.service.name="plenum-gateway" && span.plenum.outcome != nil}`. Traces are sampled, so a missing trace is not proof that nothing failed; use the metrics for that.

## 3. Claude Code in this repo

Loki, `{service_name="claude-code"}`. The repo is structured metadata (`vcs_repository_name="plenum"`), so filter after the selector:

- **Failing tools:** `sum by (tool_name, success) (count_over_time({service_name="claude-code"} | event_name="tool_result" | vcs_repository_name="plenum" [$W]))`. Report the failure rate per tool. For failures, pull a few lines with `| success="false"` to show the error.
- **Hooks:** `sum by (hook_name) (count_over_time({service_name="claude-code"} | event_name="hook_execution_complete" | vcs_repository_name="plenum" [$W]))`. A Stop hook that keeps blocking means `pnpm check` keeps failing at the end of turns.
- **Usage by model:** `sum by (model) (sum_over_time({service_name="claude-code"} | event_name="api_request" | vcs_repository_name="plenum" | unwrap output_tokens [$W]))`. Swap in `input_tokens`, `cache_read_tokens` or `cache_creation_tokens` for the other token types.
  We use Claude Code on an Anthropic subscription, so nothing is billed per token. What a subscription limits is usage per time window, which tokens measure. Each event's `cost_usd` is Claude Code's estimate at pay-as-you-go API prices. If you report it, label it "API-equivalent estimate, not billed", never as spend.
- **API errors:** `count_over_time({service_name="claude-code"} | event_name="api_error" | vcs_repository_name="plenum" [$W])`

## Report

Lead with a single verdict line: **OK**, **Warn** or **Act now**, plus the reason. Then three short sections:

- **Budget:** one row per quota showing usage, projection and the percentage.
- **Gateway**
- **Claude Code**

Each finding states the evidence (the number, plus the query or a trace ID) and the next step. Leave out sections that are fine beyond one line. Do not change code or config from this skill; propose the change and let the user (or the calling agent) decide.
