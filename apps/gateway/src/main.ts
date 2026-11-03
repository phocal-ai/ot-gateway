#!/usr/bin/env -S node --max-semi-space-size=4
/**
 * Plenum gateway entry point.
 *
 *   node apps/gateway/src/main.ts path/to/gateway.json
 *
 * Polls simulator, Modbus TCP and BACnet/IP devices and publishes to the MQTT
 * broker in `mqtt`, with the gateway's status on its retained health topic.
 *
 * Run it with `--max-semi-space-size=4` (the shebang and `pnpm gateway` do):
 * V8's default young generation reserves about 40 MB more memory than the
 * gateway's allocation rate needs, at no measurable CPU cost.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { parseConfig } from "@plenum/core"
import { Effect, FileSystem } from "effect"
import { runGateway } from "./Gateway.ts"
import { gatewayTeardown } from "./Shutdown.ts"
import { telemetryLayer } from "./Telemetry.ts"

const program = Effect.gen(function* () {
  const path = process.argv[2] ?? "plenum.json"
  const fs = yield* FileSystem.FileSystem
  const config = yield* parseConfig(yield* fs.readFileString(path))
  yield* runGateway(config).pipe(Effect.provide(telemetryLayer(config)))
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain({ teardown: gatewayTeardown }))
