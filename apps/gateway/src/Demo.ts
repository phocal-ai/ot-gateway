/**
 * `ot-gateway demo`: the gateway with everything it talks to in one process, so a first look takes one command
 * and no hardware. It runs `examples/gateway.json` against the test bench (an MQTT test broker and simulated
 * Modbus and BACnet devices on this machine), prints every message the broker receives and serves the status
 * page. The outbox goes in a temporary directory that is removed when the demo stops.
 */
import type { GatewayConfig } from "@ot-gateway/core"
import { Console, Deferred, Effect, Fiber, FileSystem } from "effect"
import { fileURLToPath } from "node:url"
import { loadConfig } from "./LoadConfig.ts"
import { runBench } from "./TestBench.ts"

/** The demo's config: the example, next to this checkout or inside the image. */
export const exampleConfigPath = fileURLToPath(new URL("../../../examples/gateway.json", import.meta.url))

export interface DemoOptions {
  /** Address the status page listens on: `127.0.0.1`, or `0.0.0.0` in a container, so a published port reaches it. */
  readonly listen: string
}

/** The example config, with the outbox in `directory` and the status page on `listen`. */
export const demoConfig = (example: GatewayConfig, directory: string, options: DemoOptions): GatewayConfig => {
  const { buffer, status, ...rest } = example
  return {
    ...rest,
    ...(buffer === undefined ? {} : { buffer: { ...buffer, path: `${directory}/buffer.sqlite` } }),
    ...(status === undefined ? {} : { status: { ...status, bindAddress: options.listen } })
  }
}

/** What the demo prints before the first message. */
export const demoBanner = (config: GatewayConfig) => {
  const port = config.status?.port ?? 8080
  return [
    "",
    "OT Gateway demo: a test MQTT broker, three simulated devices and the gateway, all in this process.",
    "",
    `  Status page   http://localhost:${port}`,
    `  MQTT broker   ${config.mqtt.url}, topics ${config.site}/${config.building}/#`,
    "",
    "Every message the broker receives follows: values on site/building/device/point, metadata on .../$meta",
    "(retained), the gateway's health on .../$gateway/<id>/health. Ctrl-C stops the demo.",
    ""
  ].join("\n")
}

/** Runs the demo until interrupted. `runGateway` runs the gateway for a config, as `ot-gateway run` does. */
export const runDemo = Effect.fn("runDemo")(function* <E, R>(
  options: DemoOptions,
  runGateway: (config: GatewayConfig) => Effect.Effect<void, E, R>
) {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ot-gateway-demo-" })
  const config = demoConfig(yield* loadConfig(exampleConfigPath), directory, options)
  // The gateway would find the broker on its own, but only after a failed connect and a warning in the log.
  const brokerListening = yield* Deferred.make<void>()
  yield* Console.log(demoBanner(config))
  const bench = yield* runBench(config, { ready: brokerListening }).pipe(Effect.forkScoped)
  // A bench that cannot start (port 1883 taken, say) ends the demo with its error instead of leaving it waiting.
  yield* Effect.raceFirst(Deferred.await(brokerListening), Fiber.join(bench))
  yield* Effect.raceFirst(runGateway(config), Fiber.join(bench))
})
