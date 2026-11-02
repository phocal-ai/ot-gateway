# Observability

Two things are observed here, and they share one Grafana Cloud stack (`wimluk.grafana.net`, region `prod-eu-west-2`):

1. **Plenum itself**: health topics, point freshness, error counts and traces (see `docs/VISION.md`, principle 5). Not wired yet.
2. **How we build Plenum**: Claude Code sessions export OpenTelemetry metrics and events, so cost, API health, tool failures and agent behaviour can be watched and improved.

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

- **Credential:** `~/.config/phocal/devloop-otlp.env` (mode 600) holds `DEVLOOP_OTLP_ENDPOINT`, `DEVLOOP_OTLP_INSTANCE_ID` and `DEVLOOP_OTLP_TOKEN`, a write-only Grafana Cloud access policy token (`logs:write`, `metrics:write`). `~/.claude/otel-headers.sh` turns it into the `Authorization: Basic base64(instanceId:token)` header at session start, so the token never sits in a settings file.
- **Cumulative temporality is required.** Claude Code's default delta temporality is dropped by Grafana Cloud's Mimir: only `target_info` arrives.
- **Keep `session_id` on metrics** (the default). Counters restart with each session; without the label, concurrent sessions write to the same series and corrupt each other.
- **Content stays local.** Prompts, responses and tool inputs are redacted by default (`<REDACTED>`; only lengths are sent). Do not set `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` or `OTEL_LOG_TOOL_CONTENT`. Identity attributes (`user_email`, account ids) are still attached by Claude Code.
- **Traces are not enabled.** They need `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, `OTEL_TRACES_EXPORTER=otlp` and a token with `traces:write`; the current token answers `401` on `/v1/traces`.

### Where the data lands

| Signal | Datasource | Query |
| --- | --- | --- |
| Metrics (`claude_code_*`: cost, tokens, sessions, active time, commits, PRs, lines changed) | `grafanacloud-prom` | `claude_code_cost_usage_USD_total{service_namespace="phocal"}` |
| Events (`api_request`, `api_error`, `tool_result`, `tool_decision`, `user_prompt`, hooks, MCP connections) | `grafanacloud-logs` | `{service_name="claude-code"} \| event_name="api_request"` |

Per-request `api_request` events carry `cost_usd`, token counts, `duration_ms` and `ttft_ms`; they are the exact source for cost over time. Metric counters are better for per-session totals (`max_over_time`), since `increase()` misses a short session's first and only sample.

### Dashboard

`grafana/dashboards/claude-code.json` is the source of the **phocal / Claude Code** dashboard (`/d/phocal-claude-code`, folder `phocal`). Edit the JSON, then re-import it with `overwrite: true` (Dashboards → New → Import, or `POST /api/dashboards/db`).

### Querying from Claude

`.mcp.json.example` configures the read-only Grafana MCP server (`mcp-grafana --disable-write`). Copy it to `.mcp.json` (gitignored); it reads `GRAFANA_MCP_URL` and `GRAFANA_MCP_READ_TOKEN` from your shell (`~/.config/grafana-mcp/env`).
