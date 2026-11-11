# Observability

Two things are observed here, and they share one Grafana Cloud stack (`wimluk.grafana.net`, region `prod-eu-west-2`):

1. **OT Gateway itself**: the gateway exports traces, metrics and logs over OTLP (see `docs/VISION.md`, principle 5). MQTT health topics come with the MQTT transport.
2. **How we build OT Gateway**: Claude Code sessions export OpenTelemetry metrics and events, so usage, API health, tool failures and agent behaviour can be watched and improved.

## Gateway telemetry

The gateway uses Effect's own OTLP exporter (`effect/observability`), so there is no OpenTelemetry SDK dependency. Metrics are defined in `packages/core/src/Telemetry.ts`; `apps/gateway/src/Telemetry.ts` wires the exporter.

**Configuration is only the standard OpenTelemetry environment variables**, so nothing secret goes in the gateway JSON. Without `OTEL_EXPORTER_OTLP_ENDPOINT` nothing is exported and the gateway runs as before. Each signal also needs its exporter set to `otlp` (Effect does not default it).

```bash
# ~/.config/phocal/ot-gateway.env (mode 600), loaded by `pnpm gateway`
# (node --env-file-if-exists; override the path with OT_GATEWAY_ENV_FILE). On a Pi, use it as a systemd EnvironmentFile.
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-eu-west-2.grafana.net/otlp
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64(instanceId:token)>
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_RESOURCE_ATTRIBUTES=service.namespace=ot-gateway,deployment.environment=dev
```

- **Credential:** a token of the access policy `phocal-plenum-gateway-write` (`logs:write`, `metrics:write`, `traces:write`, realm: the `wimluk` stack only). It is separate from the Claude Code policy, so a gateway token on a device in a plant room can be revoked on its own. Use one token per device. The header value is URL-encoded (`%20` for the space).
- **Resource:** `service.name=ot-gateway`, `service.version` from `apps/gateway/package.json`, `ot_gateway.site` and `ot_gateway.building` from the config, and `service.instance.id` = the hostname unless `OTEL_RESOURCE_ATTRIBUTES` sets one. Grafana maps these to `job="ot-gateway/ot-gateway"` and `instance`.
- **Metric attributes:** every series carries `site`, `building` and `device`, so gateways and devices never share a cumulative series.
- **Request timeout:** every export request is abandoned after `OTEL_EXPORTER_OTLP_TIMEOUT` ms (default 10,000), which closes its connection. Effect's exporter uses that variable only for the shutdown flush, so without the gateway's own deadline a collector that accepts connections and never answers would leak a socket per export until the gateway ran out of file descriptors.
- **Units:** Effect exports a metric with no `unit` attribute as unit `1`, which Grafana turns into a `_ratio` suffix on gauges. Metrics measured in seconds set `unit: "seconds"`.

| Signal  | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Query                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Metrics | `ot_gateway_poll_cycles_total{outcome}`, `ot_gateway_poll_duration_seconds`, `ot_gateway_read_failures_total{reason}`, `ot_gateway_publish_failures_total`, `ot_gateway_values_published_total`, `ot_gateway_values_suppressed_total`, `ot_gateway_device_last_success_timestamp_seconds`, `ot_gateway_point_read_failures_total{reason}`, `ot_gateway_pushed_readings_total`, `ot_gateway_pushed_points`, `ot_gateway_device_restarts_total`, `ot_gateway_driver_requests_total{outcome}`, `ot_gateway_driver_connects_total{outcome}`, `ot_gateway_driver_refusals_total{exception}`, `ot_gateway_mqtt_connects_total{outcome}`, `ot_gateway_mqtt_subscribes_total{outcome}`, `ot_gateway_mqtt_connected`, `ot_gateway_buffer_rows`, `ot_gateway_buffer_written_total`, `ot_gateway_buffer_drained_total`, `ot_gateway_buffer_dropped_total{reason}`, `ot_gateway_buffer_failures_total{operation}`, `ot_gateway_buffer_bypassed_total`, `ot_gateway_buffer_disabled`, `ot_gateway_history_written_total`, `ot_gateway_history_dropped_total`, `ot_gateway_history_failures_total{operation}`, `ot_gateway_history_disabled` | `sum by (device, outcome) (rate(ot_gateway_poll_cycles_total[5m]))`      |
| Traces  | One root `Device.pollCycle` span per cycle, with `ot_gateway.site/building/device`; failed cycles add `ot_gateway.outcome` and `ot_gateway.reason`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `{resource.service.name="ot-gateway" && span.ot_gateway.outcome != nil}` |
| Logs    | Effect logs with annotations as structured metadata (`device`, `reason`, …) and the trace and span IDs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `{service_name="ot-gateway"} \| detected_level="warn"`                   |

Staleness is `time() - ot_gateway_device_last_success_timestamp_seconds`, per device. Query it with `max_over_time(...[range])`: a stopped gateway stops sending the gauge, and an instant query would show nothing instead of a growing age. There is no per-point age: one series per point was most of a large gateway's budget (6,000 of 8,474 series at 120 devices × 50 points). A point that stops reading inside a working device is counted in `ot_gateway_point_read_failures_total` and named in the log.

### Sampling

`OTEL_TRACES_SAMPLER=traceidratio` with `OTEL_TRACES_SAMPLER_ARG=0.1` exports a tenth of the polling cycles as traces (`always_off` exports none; the default exports all). Metrics and logs still cover every cycle, so failure counts stay exact.

### Dashboard

`grafana/ot-gateway.dashboard.ts` generates `grafana/dashboards/ot-gateway.json`, the **phocal / OT Gateway** dashboard (`/d/phocal-ot-gateway`, folder `phocal`). Edit the script, run `node observability/grafana/ot-gateway.dashboard.ts`, then re-import the JSON with `overwrite: true`.

## Free-plan budget

The stack is on the Grafana Cloud **free plan**. Anything is fine inside its limits; when a projection gets close to one, optimize before shipping more.

| Quota (per month)      | Included                                   | In use on 2026-11-02                                    |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------- |
| Metrics: active series | 10,000 at **1 data point per minute** each | ~1,160 (mostly the phocal repo's jobs; Claude Code ~70) |
| Logs                   | 50 GB                                      | 0.01 GB                                                 |
| Traces                 | 50 GB                                      | 0.006 GB                                                |
| Retention              | 14 days for metrics, logs and traces       |                                                         |

A series exported more often than once a minute counts several times: at Effect's default 10 s interval, each counts about 6 times. The gateway therefore defaults to `OTEL_METRIC_EXPORT_INTERVAL=60000` (`budgetDefaults` in `apps/gateway/src/Telemetry.ts`), and Claude Code's default is already 60 s.

**What one gateway costs**, roughly:

- **Metric series:** about 20 per device, none per point (the cycle-duration histogram is 8 of them: 5 buckets, `+Inf`, sum and count), plus up to 10 per device for driver requests, connects and point read failures by reason (BACnet devices share one socket, so their connects are 2 series per gateway under `$bacnet`), plus 2 per BACnet device with change of value (values and points pushed), plus 1 per refused exception code on a device that refuses reads (usually none, at most a few), plus up to 2 per device that hangs or crashes (`timed_out` cycles, pipeline restarts; none while healthy), plus 1 per device for request time, plus up to 4 per gateway for the broker connection, up to 13 for the buffer (rows, written, drained, 5 dropped reasons, 4 failure operations, bypassed, disabled) and up to 16 for the process and the host (memory 2, CPU, open files, storage writes, start time, event-loop lag 2, clock steps 2, temperature, 4 Raspberry Pi conditions, outbox disk free; fewer off a Pi or off Linux). A chaos run with 120 devices × 50 points measured 8,474 series when every point had its own gauge and the histogram 15 series; without those it is about 1,600 (8,474 − 6,000 point gauges − 7 × 120 histogram series), so several large buildings fit in the free plan.
- **Traces:** one span per device per poll interval, about 1 KB each. 20 devices polled every 5 s is about 10 GB a month. Above roughly 10 devices, set `OTEL_TRACES_SAMPLER_ARG=0.1`. The history and the outbox export no spans for their SQLite statements; their failures are in the metrics.
- **Logs:** quiet while healthy. A device or broker that stays down logs one warning when the failure starts (or its reason changes) and one line when it ends; every failed cycle is still counted in the metrics. A device whose reason keeps alternating logs at most once per cycle. Drivers log a device that stops answering or turns busy once per change, never once per point, so a 1,000-point BACnet device costs the same as a small one.

Check the numbers instead of guessing: the `grafanacloud-usage` datasource has `grafanacloud_org_metrics_billable_series`, `grafanacloud_org_logs_usage` and `grafanacloud_org_traces_usage` (GB this month), next to the matching `*_included_*` limits. `count by (job) ({__name__=~".+"})` on `grafanacloud-prom` shows which job owns the series.

## Claude Code telemetry

Claude Code ignores telemetry variables in a repo's `.claude/settings*.json`, so a cloned repo can never redirect your session data. Telemetry is therefore enabled per developer, in `~/.claude/settings.json`, and applies to every repo; each signal carries `vcs_repository_name` so dashboards filter by repo.

```jsonc
// ~/.claude/settings.json
{
  "otelHeadersHelper": "/Users/<you>/.claude/otel-headers.sh",
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_TRACES_EXPORTER": "otlp",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://otlp-gateway-prod-eu-west-2.grafana.net/otlp",
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "cumulative",
    "OTEL_RESOURCE_ATTRIBUTES": "service.namespace=phocal,deployment.environment=devloop",
    "OTEL_METRICS_INCLUDE_REPOSITORY": "true",
    "OTEL_METRICS_INCLUDE_VERSION": "true",
    "OTEL_METRICS_INCLUDE_ENTRYPOINT": "true"
  }
}
```

- **Credential:** `~/.config/phocal/claude-code-otlp.env` (mode 600) holds `CLAUDE_OTLP_ENDPOINT`, `CLAUDE_OTLP_INSTANCE_ID` and `CLAUDE_OTLP_TOKEN`: a token of the Grafana Cloud access policy `phocal-claude-code-write` (`logs:write`, `metrics:write`, `traces:write`, realm: the `wimluk` stack only). It is separate from the phocal repo's dev-loop token, which ADR-0130 there keeps to logs and metrics. Each developer adds their own token to that policy (grafana.com → Access Policies → Add token). `~/.claude/otel-headers.sh` turns it into the `Authorization: Basic base64(instanceId:token)` header at session start, so the token never sits in a settings file.
- **Cumulative temporality is required.** Claude Code's default delta temporality is dropped by Grafana Cloud's Mimir: only `target_info` arrives.
- **Keep `session_id` on metrics** (the default). Counters restart with each session; without the label, concurrent sessions write to the same series and corrupt each other.
- **Content stays local.** Prompts, responses and tool inputs are redacted by default (`<REDACTED>`; only lengths are sent). Do not set `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` or `OTEL_LOG_TOOL_CONTENT`. Identity attributes (`user_email`, account ids) are still attached by Claude Code.
- **Traces are beta** (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`). Each prompt is one `claude_code.interaction` trace with `claude_code.llm_request`, `claude_code.tool`, `claude_code.tool.execution` and `claude_code.tool.blocked_on_user` spans; the last one shows where a session waited on a human.

### Where the data lands

| Signal                                                                                                     | Datasource            | Query                                                                     |
| ---------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------- |
| Metrics (`claude_code_*`: cost, tokens, sessions, active time, commits, PRs, lines changed)                | `grafanacloud-prom`   | `claude_code_cost_usage_USD_total{service_namespace="phocal"}`            |
| Traces (`claude_code.interaction` and child spans)                                                         | `grafanacloud-traces` | `{resource.service.name="claude-code" && name="claude_code.interaction"}` |
| Events (`api_request`, `api_error`, `tool_result`, `tool_decision`, `user_prompt`, hooks, MCP connections) | `grafanacloud-logs`   | `{service_name="claude-code"} \| event_name="api_request"`                |

Per-request `api_request` events carry `cost_usd`, token counts, `duration_ms` and `ttft_ms`; they are the exact source for usage over time. On an Anthropic subscription (our setup) nothing is billed per token: `cost_usd` and `claude_code_cost_usage_USD_total` are Claude Code's estimate at pay-as-you-go API prices. Read them as relative weight, not spend; the subscription's limit is usage per time window. Metric counters are better for per-session totals (`max_over_time`), since `increase()` misses a short session's first and only sample.

### Dashboard

`grafana/dashboards/claude-code.json` is the source of the **phocal / Claude Code** dashboard (`/d/phocal-claude-code`, folder `phocal`). Edit the JSON, then re-import it with `overwrite: true` (Dashboards → New → Import, or `POST /api/dashboards/db`).

### Querying from Claude

`.mcp.json.example` configures the read-only Grafana MCP server (`mcp-grafana --disable-write`). Copy it to `.mcp.json` (gitignored); it reads `GRAFANA_MCP_URL` and `GRAFANA_MCP_READ_TOKEN` from your shell (`~/.config/grafana-mcp/env`).

The `/health` skill (`.claude/skills/health/SKILL.md`) runs the standard checks through it. It covers stale devices and failing cycles, failing tools and hooks, and token usage in this repo's Claude Code sessions. It also projects month-end Grafana usage against the free-plan quotas, with the thresholds for when to optimize.

The `Health` GitHub workflow runs the budget and gateway checks every day at 06:17 UTC (and on demand from the Actions tab), using Claude Code in print mode with Sonnet. It opens one `health` issue per finding, comments when the numbers change and closes the issue once the finding is gone. The Claude Code section is left out because the repository is public. The workflow needs three repository secrets: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), `GRAFANA_MCP_URL`, and `GRAFANA_MCP_READ_TOKEN` (a Viewer service-account token used only by this job). Without them it skips with a warning. Cost: Actions minutes are free on a public repository, a run takes about 30 s of Claude time, and its Grafana reads are a few MB a day against the Loki query allowance (100× ingest).
