/**
 * The whole gateway, simulated (see `sim/Simulation.ts`). Each seed is a
 * different, reproducible run of faults:
 *
 *   SIM_SEEDS=7,8 SIM_HOURS=168 pnpm --filter @plenum/gateway sim
 *
 * runs a simulated week per seed. A failing run prints its seed; run that
 * seed alone to replay it.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { checkInvariants } from "./sim/Invariants.ts"
import { simulate } from "./sim/Simulation.ts"

const seeds = (process.env["SIM_SEEDS"] ?? "1,2,3").split(",").map(Number)
const hours = Number(process.env["SIM_HOURS"] ?? "6")

describe("simulation: the whole gateway through broker, device and network faults", () => {
  for (const seed of seeds) {
    it.effect(
      `seed ${seed}, ${hours} simulated hours`,
      () =>
        Effect.gen(function* () {
          const run = yield* simulate({ seed, hours })
          const verdict = checkInvariants(run, hours * 3_600_000)
          console.log(`seed ${seed}: ${JSON.stringify(verdict.summary)}`)
          expect(verdict.violations).toEqual([])
        }),
      { timeout: 600_000 }
    )
  }
})
