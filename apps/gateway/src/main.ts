#!/usr/bin/env -S node --max-semi-space-size=4
/**
 * Plenum gateway entry point.
 *
 *   node apps/gateway/src/main.ts path/to/gateway.json
 *   node apps/gateway/src/main.ts --check path/to/gateway.json
 *
 * `--check` validates the config and prints what it would run, without
 * connecting to anything: exit 0 when it is valid, 1 with the problem when not.
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
import { type GatewayConfig, parseConfig } from "@plenum/core"
import { Console, Effect, FileSystem } from "effect"
import { runGateway } from "./Gateway.ts"
import { gatewayTeardown } from "./Shutdown.ts"
import { telemetryLayer } from "./Telemetry.ts"

/** What `--check` prints: the gateway the config describes, one line per device. */
const describe = (config: GatewayConfig) =>
  [
    `config ok: ${config.site}/${config.building}, gateway ${config.id}, broker ${config.mqtt.url}`,
    config.buffer === undefined
      ? "  no buffer: values read while the broker is down are lost"
      : `  buffer ${config.buffer.path}`,
    ...config.devices.map((device) => {
      const where =
        device.protocol === "modbus-tcp"
          ? `${device.host}:${device.port} unit ${device.unitId}`
          : device.protocol === "bacnet-ip"
            ? `device ${device.deviceInstance}${device.address === undefined ? " (discovered)" : ` at ${device.address}`}`
            : "simulated"
      const writable = device.points.filter((point) => point.writable).length
      return `  ${device.id}: ${device.protocol} ${where}, ${device.points.length} point(s)${writable > 0 ? `, ${writable} writable` : ""}, every ${device.pollIntervalMs} ms`
    })
  ].join("\n")

const program = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const check = args.includes("--check")
  const path = args.find((arg) => arg !== "--check") ?? "plenum.json"
  const fs = yield* FileSystem.FileSystem
  const config = yield* parseConfig(yield* fs.readFileString(path))
  if (check) return yield* Console.log(describe(config))
  yield* runGateway(config).pipe(Effect.provide(telemetryLayer(config)))
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain({ teardown: gatewayTeardown }))
