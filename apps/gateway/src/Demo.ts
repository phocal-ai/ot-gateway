/**
 * `ot-gateway demo`: the gateway with everything it talks to in one process, so a first look takes one command
 * and no hardware. It runs `examples/gateway.json` against the test bench (an MQTT test broker and simulated
 * Modbus and BACnet devices on this machine), prints every message the broker receives and serves the status
 * page. The outbox goes in a temporary directory that is removed when the demo stops.
 *
 * With `--public`, the gateway publishes to a public test broker instead of a local one, under a site id of its
 * own (`demo-` and six hex digits), so the data can be watched from any MQTT client. Public brokers come and go,
 * so the demo takes the first of `publicBrokers` that accepts a connection. Only the simulated devices run: the
 * config refuses a public broker for anything else (see Config.ts).
 */
import type { GatewayConfig } from "@ot-gateway/core"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Console, Deferred, Effect, Fiber, FileSystem, Random, Schema } from "effect"
import { fileURLToPath } from "node:url"
import { loadConfig } from "./LoadConfig.ts"
import { runBench } from "./TestBench.ts"

/** The demo's config: the example, next to this checkout or inside the image. */
export const exampleConfigPath = fileURLToPath(new URL("../../../examples/gateway.json", import.meta.url))

export interface PublicBroker {
  readonly host: string
  readonly port: number
}

/**
 * The public test brokers `demo --public` tries, in order, on plain MQTT: test.mosquitto.org's TLS port needs a
 * CA certificate of its own, and the data is public either way.
 */
export const publicBrokers: ReadonlyArray<PublicBroker> = [
  { host: "broker.hivemq.com", port: 1883 },
  { host: "broker.emqx.io", port: 1883 },
  { host: "test.mosquitto.org", port: 1883 }
]

/** None of the public test brokers accepted a connection. */
export class NoPublicBroker extends Schema.TaggedError<NoPublicBroker>()("NoPublicBroker", {
  message: Schema.String
}) {}

/** Whether `broker` accepts a TCP connection within 3 s. */
export const acceptsConnections = (broker: PublicBroker) =>
  NodeSocket.makeNet({ host: broker.host, port: broker.port, openTimeout: "3 seconds" }).pipe(
    Effect.flatMap((socket) => socket.reader),
    Effect.scoped,
    Effect.as(true),
    Effect.catchTag("SocketError", () => Effect.succeed(false))
  )

/** The first of `publicBrokers` that `reachable` (`acceptsConnections`, or a stand-in in tests) says is up. */
export const pickPublicBroker = Effect.fn("pickPublicBroker")(function* <R>(
  reachable: (broker: PublicBroker) => Effect.Effect<boolean, never, R>
) {
  for (const broker of publicBrokers) if (yield* reachable(broker)) return broker
  return yield* new NoPublicBroker({
    message: `none of the public test brokers (${publicBrokers.map((broker) => broker.host).join(", ")}) answered on port 1883. The network may block MQTT; ot-gateway demo without --public needs no network.`
  })
})

export interface DemoOptions {
  /** Address the status page listens on: `127.0.0.1`, or `0.0.0.0` in a container, so a published port reaches it. */
  readonly listen: string
  /** The public test broker and the site id to publish under there; a local broker when absent. */
  readonly public?: { readonly broker: PublicBroker; readonly site: string } | undefined
}

/** The example config, with the outbox in `directory`, the status page on `listen` and the broker it is told. */
export const demoConfig = (example: GatewayConfig, directory: string, options: DemoOptions): GatewayConfig => {
  const { buffer, status, ...rest } = example
  const site = options.public?.site ?? example.site
  return {
    ...rest,
    site,
    ...(options.public === undefined
      ? {}
      : {
          mqtt: {
            url: `mqtt://${options.public.broker.host}:${options.public.broker.port}`,
            clientId: `ot-gateway-${site}`
          }
        }),
    ...(buffer === undefined ? {} : { buffer: { ...buffer, path: `${directory}/buffer.sqlite` } }),
    ...(status === undefined ? {} : { status: { ...status, bindAddress: options.listen } })
  }
}

/** A site id of its own for each public demo, so two people's demos never share topics. */
export const randomDemoSite = Effect.map(
  Random.nextIntBetween(0, 0xffffff),
  (n) => `demo-${n.toString(16).padStart(6, "0")}`
)

/** What the demo prints before the first message. */
export const demoBanner = (config: GatewayConfig, options: DemoOptions) => {
  const port = config.status?.port ?? 8080
  const topics = `${config.site}/${config.building}/#`
  const common = [
    `  Status page   http://localhost:${port}`,
    `  Topics        ${topics}: values on site/building/device/point, metadata on .../$meta (retained),`,
    "                the gateway's health on .../$gateway/<id>/health"
  ]
  const remote = options.public
  return remote === undefined
    ? [
        "",
        "OT Gateway demo: a test MQTT broker, three simulated devices and the gateway, all in this process.",
        "",
        ...common,
        `  MQTT broker   ${config.mqtt.url}`,
        "",
        "Every message the broker receives follows. Ctrl-C stops the demo.",
        ""
      ].join("\n")
    : [
        "",
        `OT Gateway demo: three simulated devices, published to the public test broker ${remote.broker.host}.`,
        "Anyone can read what is published there. This is simulated data; never point a real device at it.",
        "",
        ...common,
        `  MQTT broker   ${config.mqtt.url}`,
        "",
        "Watch the messages arrive from anywhere, with any MQTT client:",
        `  mosquitto_sub -h ${remote.broker.host} -p ${remote.broker.port} -t '${topics}' -v`,
        `  MQTT Explorer (mqtt-explorer.com): host ${remote.broker.host}, port ${remote.broker.port}, topic ${topics}`,
        "",
        "Ctrl-C stops the demo.",
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
  yield* Console.log(demoBanner(config, options))
  if (options.public !== undefined) {
    const devices = yield* runBench(config, { only: "devices" }).pipe(Effect.forkScoped)
    return yield* Effect.raceFirst(runGateway(config), Fiber.join(devices))
  }
  // The gateway would find the broker on its own, but only after a failed connect and a warning in the log.
  const brokerListening = yield* Deferred.make<void>()
  const bench = yield* runBench(config, { ready: brokerListening }).pipe(Effect.forkScoped)
  // A bench that cannot start (port 1883 taken, say) ends the demo with its error instead of leaving it waiting.
  yield* Effect.raceFirst(Deferred.await(brokerListening), Fiber.join(bench))
  yield* Effect.raceFirst(runGateway(config), Fiber.join(bench))
})
