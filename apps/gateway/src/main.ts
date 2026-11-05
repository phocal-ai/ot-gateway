#!/usr/bin/env -S node --max-semi-space-size=4
/**
 * OT Gateway entry point.
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
import { type GatewayConfig, mqttPasswordWarning } from "@ot-gateway/core"
import { Cause, Console, Effect, Result } from "effect"
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net"
import { discover } from "./Discover.ts"
import { runGateway } from "./Gateway.ts"
import { liveHostSources } from "./Host.ts"
import { loadConfig } from "./LoadConfig.ts"
import { gatewayTeardown } from "./Shutdown.ts"
import { telemetryLayer } from "./Telemetry.ts"
import { readVersion } from "./Version.ts"

/** What `--check` prints: the gateway the config describes, one line per device, and what start-up would warn about. */
const describe = (config: GatewayConfig) => {
  const passwordWarning = mqttPasswordWarning(config.mqtt)
  return [
    `config ok: ${config.site}/${config.building}, gateway ${config.id}, broker ${config.mqtt.url}`,
    ...(passwordWarning === undefined ? [] : [`  warning: ${passwordWarning}`]),
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
}

// A broker or device named by host name may have several addresses (localhost: 127.0.0.1 and ::1). Node tries
// them in turn and abandons each but the last after 250 ms, which a busy event loop (a loaded Pi, emulation)
// can pass before it has even seen the connection succeed; the gateway then never reaches a broker that
// listens on the first address. Two seconds per address, well inside the 10 s connect timeout.
setDefaultAutoSelectFamilyAttemptTimeout(2000)

/**
 * How a failed run ends. An expected failure (a config mistake, a port in use) prints its message and nothing
 * else: a stack trace into Effect's internals does not help anyone fix a config. A defect, which is a bug, is
 * logged with its whole cause. The exit code is 1 either way.
 */
const reportFailure = <E extends { readonly message: string }>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void
  const error = Cause.findError(cause)
  return Result.isSuccess(error) && !Cause.hasDies(cause)
    ? Console.error(`ot-gateway: ${error.success.message}`)
    : Effect.logError(cause)
}

const program = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const flags = new Set(["--check", "--discover"])
  const path = args.find((arg) => !flags.has(arg)) ?? "ot-gateway.json"
  const config = yield* loadConfig(path)
  if (args.includes("--check")) return yield* Console.log(describe(config))
  if (args.includes("--discover")) return yield* discover(config)
  const version = yield* readVersion
  yield* Effect.scoped(Effect.flatMap(liveHostSources, (host) => runGateway(config, { host, version }))).pipe(
    Effect.provide(telemetryLayer(config, version))
  )
})

program.pipe(
  Effect.tapCause(reportFailure),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ teardown: gatewayTeardown, disableErrorReporting: true })
)
