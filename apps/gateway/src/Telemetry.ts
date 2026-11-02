/**
 * OTLP export of the gateway's traces, metrics and logs.
 *
 * Configured only through the standard OpenTelemetry environment variables,
 * read by Effect's `Otlp.layerFromConfig`; nothing secret lives in the gateway
 * config file. With no `OTEL_EXPORTER_OTLP_ENDPOINT`, or a signal whose
 * `OTEL_<SIGNAL>_EXPORTER` is not `otlp`, that signal is not exported and the
 * gateway runs exactly as before. See `observability/README.md`.
 */
import { hostname } from "node:os"
import type { GatewayConfig } from "@plenum/core"
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Otlp, OtlpSerialization } from "effect/observability"
import packageJson from "../package.json" with { type: "json" }

export const serviceName = "plenum-gateway"

/**
 * Defaults that keep a gateway inside the Grafana Cloud free plan, which
 * includes 1 data point per minute per series. Effect's own default metric
 * interval is 10 s, which would bill every series about 6 times. An
 * explicitly set environment variable always wins.
 */
export const budgetDefaults = {
  OTEL_METRIC_EXPORT_INTERVAL: "60000"
} as const

export const withBudgetDefaults = ConfigProvider.layerAdd(ConfigProvider.fromUnknown(budgetDefaults))

/**
 * Share of polling cycles exported as traces, from the standard
 * `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` variables. Supports
 * `always_on` (default), `always_off` and `traceidratio` (and their
 * `parentbased_` forms, since cycles are root spans).
 */
export const traceSampleRatio = Effect.gen(function* () {
  const sampler = yield* Config.String("OTEL_TRACES_SAMPLER").pipe(Config.withDefault("always_on"))
  switch (sampler.replace(/^parentbased_/, "")) {
    case "always_off":
      return 0
    case "traceidratio": {
      const ratio = yield* Config.Number("OTEL_TRACES_SAMPLER_ARG").pipe(Config.withDefault(1))
      return Math.min(1, Math.max(0, ratio))
    }
    default:
      return 1
  }
})

/**
 * The HTTP client the OTLP exporters send with, with a deadline on every
 * request: `OTEL_EXPORTER_OTLP_TIMEOUT` ms (default 10 s, as in the
 * OpenTelemetry spec). Effect's exporter only uses that variable for the
 * shutdown flush, so without this a collector that accepts the connection
 * and never answers holds each request, and its socket, forever: about one
 * leaked socket a minute, until the gateway runs out of file descriptors.
 * A request that times out is aborted, which closes its socket.
 */
export const otlpHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const timeoutMs = yield* Config.Int("OTEL_EXPORTER_OTLP_TIMEOUT").pipe(Config.withDefault(10_000))
    return (yield* HttpClient.HttpClient).pipe(HttpClient.timeout(timeoutMs))
  })
).pipe(Layer.provide(FetchHttpClient.layer))

export const telemetryLayer = (config: GatewayConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const envAttributes = yield* Config.String("OTEL_RESOURCE_ATTRIBUTES").pipe(Config.withDefault(""))
      const envServiceName = yield* Config.String("OTEL_SERVICE_NAME").pipe(Config.withDefault(serviceName))
      return Otlp.layerFromConfig({
        resource: {
          serviceName: envServiceName,
          serviceVersion: packageJson.version,
          attributes: {
            "plenum.site": config.site,
            "plenum.building": config.building,
            // One cumulative series per running gateway; OTEL_RESOURCE_ATTRIBUTES can set its own.
            ...(envAttributes.includes("service.instance.id=") ? {} : { "service.instance.id": hostname() })
          }
        }
      })
    })
  ).pipe(
    Layer.provide(OtlpSerialization.layerProtobuf),
    Layer.provide(otlpHttpClient),
    Layer.provide(withBudgetDefaults)
  )
