/**
 * The simulation's test suite, shared by `Simulation.test.ts` and its per-seed
 * siblings: one test per seed, each a reproducible run of faults whose
 * invariants must hold.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { checkInvariants } from "./Invariants.ts"
import { simulate } from "./Simulation.ts"

/** `SIM_SEEDS=7,8`: the seeds a `pnpm sim` run names; undefined in an ordinary test run. */
export const namedSeeds = process.env["SIM_SEEDS"]?.split(",").map(Number)

const hours = Number(process.env["SIM_HOURS"] ?? "6")

/** One test per seed. `skipped` leaves them unrun: a per-seed file when SIM_SEEDS names the seeds. */
export const simulationSuite = (seeds: ReadonlyArray<number>, skipped = false) =>
  describe("simulation: the whole gateway through broker, device and network faults", () => {
    for (const seed of seeds) {
      it.effect.skipIf(skipped)(
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
