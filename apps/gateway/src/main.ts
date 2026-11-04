#!/usr/bin/env -S node --max-semi-space-size=4
/**
 * Plenum gateway entry point.
 *
 *   node apps/gateway/src/main.ts path/to/gateway.json
 *   node apps/gateway/src/main.ts --check path/to/gateway.json
 *   node apps/gateway/src/main.ts --discover path/to/gateway.json
 *
 * `--check` validates the config and prints what it would run, without
 * connecting to anything: exit 0 when it is valid, 1 with the problem when not.
 * `--discover` finds the BACnet devices through the config's `bacnet`
 * settings and prints a draft of their `devices` entries (see Discover.ts).
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
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net"
import { discover } from "./Discover.ts"
import { runGateway } from "./Gateway.ts"
import { liveHostSources } from "./Host.ts"
import { gatewayTeardown } from "./Shutdown.ts"
import { telemetryLayer } from "./Telemetry.ts"
import { readVersion } from "./Version.ts"

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

// A broker or device named by host name may have several addresses (localhost: 127.0.0.1 and ::1). Node tries
// them in turn and abandons each but the last after 250 ms, which a busy event loop (a loaded Pi, emulation)
// can pass before it has even seen the connection succeed; the gateway then never reaches a broker that
// listens on the first address. Two seconds per address, well inside the 10 s connect timeout.
setDefaultAutoSelectFamilyAttemptTimeout(2000)

const program = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const flags = new Set(["--check", "--discover"])
  const path = args.find((arg) => !flags.has(arg)) ?? "plenum.json"
  const fs = yield* FileSystem.FileSystem
  const config = yield* parseConfig(yield* fs.readFileString(path))
  if (args.includes("--check")) return yield* Console.log(describe(config))
  if (args.includes("--discover")) return yield* discover(config)
  const version = yield* readVersion
  yield* Effect.scoped(Effect.flatMap(liveHostSources, (host) => runGateway(config, { host, version }))).pipe(
    Effect.provide(telemetryLayer(config, version))
  )
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain({ teardown: gatewayTeardown }))
