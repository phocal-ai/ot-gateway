/**
 * The whole gateway, simulated (see `sim/Simulation.ts`). Each seed is a
 * different, reproducible run of faults:
 *
 *   SIM_SEEDS=7,8 SIM_HOURS=168 pnpm --filter @ot-gateway/gateway sim
 *
 * runs a simulated week per seed. A failing run prints its seed; run that
 * seed alone to replay it.
 *
 * Without SIM_SEEDS, `pnpm test` and `pnpm sim` run seeds 1, 2 and 3, one per
 * file (this one and `Simulation.seed2.test.ts`, `Simulation.seed3.test.ts`):
 * a seed takes most of the suite's time on one core, and Vitest runs files
 * side by side but the tests of one file in turn.
 */
import { namedSeeds, simulationSuite } from "./sim/Suite.ts"

simulationSuite(namedSeeds ?? [1])
