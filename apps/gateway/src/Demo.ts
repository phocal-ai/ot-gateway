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
import { networkInterfaces } from "node:os"
import { fileURLToPath } from "node:url"
import { lanInterfaces } from "./Init.ts"
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

/** The example config, with the outbox and history in `directory`, the status page on `listen` and the broker it is told. */
export const demoConfig = (example: GatewayConfig, directory: string, options: DemoOptions): GatewayConfig => {
  const { buffer, history, status, ...rest } = example
  const site = options.public?.site ?? example.site
  return {
    ...rest,
    site,
    ...(options.public === undefined
      ? {}
      : {
          mqtt: {
            url: `mqtt://${options.public.broker.host}:${options.public.broker.port}`,
            clientId: `ot-gateway-${site}`,
            version: "auto"
          }
        }),
    ...(buffer === undefined ? {} : { buffer: { ...buffer, path: `${directory}/buffer.sqlite` } }),
    ...(history === undefined ? {} : { history: { ...history, path: `${directory}/history.sqlite` } }),
    ...(status === undefined ? {} : { status: { ...status, bindAddress: options.listen } })
  }
}

/** A site id of its own for each public demo, so two people's demos never share topics. */
export const randomDemoSite = Effect.map(
  Random.nextIntBetween(0, 0xffffff),
  (n) => `demo-${n.toString(16).padStart(6, "0")}`
)

/** What the demo prints before the first message. */
const protocolNames = { "modbus-tcp": "Modbus TCP", "bacnet-ip": "BACnet/IP", simulator: "built in" } as const

const isLoopback = (address: string) => address === "localhost" || address === "::1" || address.startsWith("127.")

/**
 * Where another computer reaches a status page that listens on `listen`: nowhere on loopback, at most two of
 * this machine's LAN addresses (`lanAddresses`) on every interface, else the one address it listens on.
 */
export const remoteStatusHosts = (listen: string, lanAddresses: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (isLoopback(listen)) return []
  if (listen === "0.0.0.0" || listen === "::") return [...new Set(lanAddresses)].slice(0, 2)
  return [listen]
}

/** Interfaces of container and VM networks: the host side of Docker's bridges, their veth pairs, libvirt's. */
const virtualInterface = /^(docker|br-|veth|virbr|cni|flannel|cali)/

/**
 * The IPv4 LAN addresses among `interfaces` (`os.networkInterfaces()`) that another computer can reach: loopback,
 * container bridges and Docker's default bridge network (172.17.0.0/16, which is also what a container without
 * host networking sees as its own address) left out.
 */
export const reachableLanAddresses = (interfaces: Parameters<typeof lanInterfaces>[0]): ReadonlyArray<string> =>
  lanInterfaces(interfaces)
    .filter((lan) => !virtualInterface.test(lan.name) && !lan.address.startsWith("172.17."))
    .map((lan) => lan.address)

/** This machine's reachable LAN addresses: what `runDemo` gives the banner unless told otherwise. */
export const lanAddresses = (): ReadonlyArray<string> => reachableLanAddresses(networkInterfaces())

/**
 * What the demo prints first: what is running, then where to look, in the order a newcomer needs it, and the
 * next step towards their own building. `addresses` are this machine's LAN addresses, named next to localhost
 * when the status page listens beyond loopback (in the container image, so on a Pi reached over SSH too).
 */
export const demoBanner = (config: GatewayConfig, options: DemoOptions, addresses: ReadonlyArray<string> = []) => {
  const port = config.status?.port ?? 8080
  const remoteUrls = remoteStatusHosts(options.listen, addresses).map(
    (host) => `http://${host.includes(":") ? `[${host}]` : host}:${port}`
  )
  const fromElsewhere = remoteUrls.length === 0 ? "" : ` (from another computer: ${remoteUrls.join(" or ")})`
  const topics = `${config.site}/${config.building}/#`
  const devices = config.devices.map((device) => `${device.id} (${protocolNames[device.protocol]})`).join(", ")
  const remote = options.public
  const intro =
    remote === undefined
      ? [
          "OT Gateway demo: a small simulated building on this computer. Nothing leaves this machine.",
          "",
          `  Devices   ${devices}, all simulated`,
          `  Gateway   reads them on schedule and sends each value to the broker`,
          `  Broker    a test MQTT broker in this process, ${config.mqtt.url}`
        ]
      : [
          `OT Gateway demo: a small simulated building, published to the public test broker ${remote.broker.host}.`,
          "Anyone can read what is published there. This is simulated data; never point a real device at it.",
          "",
          `  Devices   ${devices}, all simulated`,
          `  Gateway   reads them on schedule and sends each value to the broker`,
          `  Broker    ${config.mqtt.url}, under the site ${config.site}`
        ]
  const watchHere =
    remote === undefined
      ? ["  2. Read     the lines below: what the broker receives, as topic and value"]
      : [
          "  2. Watch    from any MQTT client, on any machine:",
          `              mosquitto_sub -h ${remote.broker.host} -p ${remote.broker.port} -t '${topics}' -v`,
          `              MQTT Explorer (mqtt-explorer.com): host ${remote.broker.host}, port ${remote.broker.port}, topic ${topics}`
        ]
  return [
    "",
    ...intro,
    "",
    `  1. Look     http://localhost:${port}${fromElsewhere}: every device, its latest values and the messages sent`,
    ...watchHere,
    "              topics are site/building/device/point; .../$meta describes a point, .../$gateway/<id>/health the gateway",
    `  3. Next     ${remote === undefined ? "demo --public to watch the same data from any MQTT app, or " : ""}init to describe your own building`,
    "",
    remote === undefined ? "Ctrl-C stops the demo. The messages follow." : "Ctrl-C stops the demo.",
    ""
  ].join("\n")
}

/**
 * Runs the demo until interrupted. `runGateway` runs the gateway for a config, as `ot-gateway run` does;
 * `addresses` lists this machine's LAN addresses for the banner.
 */
export const runDemo = Effect.fn("runDemo")(function* <E, R>(
  options: DemoOptions,
  runGateway: (config: GatewayConfig) => Effect.Effect<void, E, R>,
  addresses: () => ReadonlyArray<string> = lanAddresses
) {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ot-gateway-demo-" })
  const config = demoConfig(yield* loadConfig(exampleConfigPath), directory, options)
  yield* Console.log(demoBanner(config, options, addresses()))
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
