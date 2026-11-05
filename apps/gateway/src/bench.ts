#!/usr/bin/env node
/**
 * The test bench on its own, for `pnpm gateway` in a second terminal, the soak and the interop runs (see
 * TestBench.ts):
 *
 *   node apps/gateway/src/bench.ts path/to/gateway.json
 *
 * `--only broker` or `--only devices` starts one half, so a soak test can stop
 * the broker without stopping the devices. `--speed N` makes the simulated
 * values change N times faster (an accelerated soak polls N times faster too).
 * `ot-gateway demo` runs the same bench and the gateway in one process.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem } from "effect"
import { runBench } from "./TestBench.ts"

const program = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const onlyAt = args.indexOf("--only")
  const only = onlyAt === -1 ? undefined : args.splice(onlyAt, 2)[1]
  if (only !== undefined && only !== "broker" && only !== "devices") {
    return yield* Effect.die(new Error(`--only takes broker or devices, not ${only}`))
  }
  const speedAt = args.indexOf("--speed")
  const speed = speedAt === -1 ? 1 : Number(args.splice(speedAt, 2)[1])
  if (!Number.isFinite(speed) || speed < 1) {
    return yield* Effect.die(new Error("--speed takes a number of at least 1"))
  }
  const path = args[0] ?? "ot-gateway.json"
  const fs = yield* FileSystem.FileSystem
  const config = yield* parseConfig(yield* fs.readFileString(path))
  yield* runBench(config, { only, speed })
})

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain)
