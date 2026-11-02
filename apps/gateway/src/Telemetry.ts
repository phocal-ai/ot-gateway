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
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp, OtlpSerialization } from "effect/observability"
import packageJson from "../package.json" with { type: "json" }

export const serviceName = "plenum-gateway"

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
  ).pipe(Layer.provide(OtlpSerialization.layerProtobuf), Layer.provide(FetchHttpClient.layer))
