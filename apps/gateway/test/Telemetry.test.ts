import { describe, expect, it } from "@effect/vitest"
import { Config, ConfigProvider, Effect } from "effect"
import { traceSampleRatio, withBudgetDefaults } from "../src/Telemetry.ts"

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
