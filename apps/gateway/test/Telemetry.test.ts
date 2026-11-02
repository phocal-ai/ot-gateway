import { createServer, type Server, type Socket } from "node:net"
import { describe, expect, it } from "@effect/vitest"
import { Config, ConfigProvider, Effect } from "effect"
import { HttpClient } from "effect/http"
import { otlpHttpClient, traceSampleRatio, withBudgetDefaults } from "../src/Telemetry.ts"

const withEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))

describe("traceSampleRatio", () => {
  it.effect("samples every cycle when no sampler is set", () =>
    Effect.gen(function* () {
      expect(yield* traceSampleRatio.pipe(withEnv({}))).toBe(1)
    })
  )

  it.effect("reads the ratio for traceidratio and its parentbased form", () =>
    Effect.gen(function* () {
      const env = { OTEL_TRACES_SAMPLER_ARG: "0.25" }
      expect(yield* traceSampleRatio.pipe(withEnv({ ...env, OTEL_TRACES_SAMPLER: "traceidratio" }))).toBe(0.25)
      expect(yield* traceSampleRatio.pipe(withEnv({ ...env, OTEL_TRACES_SAMPLER: "parentbased_traceidratio" }))).toBe(
        0.25
      )
    })
  )

  it.effect("clamps the ratio to 0..1 and turns always_off into 0", () =>
    Effect.gen(function* () {
      const ratio = (arg: string) =>
        traceSampleRatio.pipe(withEnv({ OTEL_TRACES_SAMPLER: "traceidratio", OTEL_TRACES_SAMPLER_ARG: arg }))
      expect(yield* ratio("7")).toBe(1)
      expect(yield* ratio("-1")).toBe(0)
      expect(yield* traceSampleRatio.pipe(withEnv({ OTEL_TRACES_SAMPLER: "always_off" }))).toBe(0)
    })
  )
})

describe("withBudgetDefaults", () => {
  const interval = Config.Int("OTEL_METRIC_EXPORT_INTERVAL")

  it.effect("exports metrics once a minute when the interval is not set", () =>
    Effect.gen(function* () {
      const value = yield* interval.pipe(Effect.provide(withBudgetDefaults), withEnv({}))
      expect(value).toBe(60_000)
    })
  )

  it.effect("keeps an interval set in the environment", () =>
    Effect.gen(function* () {
      const value = yield* interval.pipe(
        Effect.provide(withBudgetDefaults),
        withEnv({ OTEL_METRIC_EXPORT_INTERVAL: "30000" })
      )
      expect(value).toBe(30_000)
    })
  )
})

/**
 * A TCP server that accepts connections and never answers, like a hung
 * collector. `pending` counts open connections a request was sent on (fetch
 * also opens spare connections, which close on their own).
 */
const silentServer = Effect.acquireRelease(
  Effect.callback<{
    readonly port: number
    readonly pending: () => number
    readonly sockets: Set<Socket>
    readonly server: Server
  }>((resume) => {
    const sockets = new Set<Socket>()
    const requested = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on("data", () => requested.add(socket))
      socket.on("close", () => {
        sockets.delete(socket)
        requested.delete(socket)
      })
      socket.on("error", () => {})
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      resume(Effect.succeed({ port, pending: () => requested.size, sockets, server }))
    })
  }),
  ({ server, sockets }) =>
    Effect.sync(() => {
      for (const socket of sockets) socket.destroy()
      server.close()
    })
)

describe("otlpHttpClient", () => {
  it.live("gives up on a collector that never answers, and closes the socket", () =>
    Effect.gen(function* () {
      const collector = yield* silentServer
      const client = yield* HttpClient.HttpClient.pipe(
        Effect.provide(otlpHttpClient),
        withEnv({ OTEL_EXPORTER_OTLP_TIMEOUT: "200" })
      )
      for (let request = 0; request < 3; request++) {
        const error = yield* Effect.flip(client.post(`http://127.0.0.1:${collector.port}/v1/metrics`))
        expect(error.message).toContain("timed out")
      }
      // Every abandoned request released its socket; none piles up.
      yield* Effect.sleep("300 millis")
      expect(collector.pending()).toBe(0)
    }).pipe(Effect.scoped)
  )
})
