/** Seed 2 of the default simulation run, in a file of its own so it runs beside the others (see `Simulation.test.ts`). */
import { namedSeeds, simulationSuite } from "./sim/Suite.ts"

// A run that names its seeds (SIM_SEEDS) runs them all from `Simulation.test.ts`.
simulationSuite([2], namedSeeds !== undefined)
