import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { createSocket } from "node:dgram"
import { createServer } from "node:net"
import { demoConfig, demoPorts, exampleConfigPath, portInUseMessage } from "../src/Demo.ts"
import { loadConfig } from "../src/LoadConfig.ts"
import { firstPortInUse, type ListenPort } from "../src/TestBench.ts"

/** A TCP port on 127.0.0.1 held by "another program" until the test's scope closes. */
const holdTcp = Effect.acquireRelease(
  Effect.callback<{ readonly port: number; readonly release: () => void }>((resume) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      resume(Effect.succeed({ port, release: () => server.close() }))
    })
  }),
  (held) => Effect.sync(held.release)
).pipe(Effect.map((held) => held.port))

/** A UDP port on 127.0.0.1 held the same way. */
const holdUdp = Effect.acquireRelease(
  Effect.callback<{ readonly port: number; readonly release: () => void }>((resume) => {
    const socket = createSocket("udp4")
    socket.bind(0, "127.0.0.1", () =>
      resume(Effect.succeed({ port: socket.address().port, release: () => socket.close() }))
    )
  }),
  (held) => Effect.sync(held.release)
).pipe(Effect.map((held) => held.port))

const port = (transport: ListenPort["transport"], number: number): ListenPort => ({
  transport,
  host: "127.0.0.1",
  port: number,
  role: "a test port",
  likelyHolder: "this test"
})

describe("the demo's ports", () => {
  it.effect("are every port it listens on: broker, simulated devices, the gateway's BACnet port, the status page", () =>
    Effect.gen(function* () {
      const options = { listen: "127.0.0.1" }
      const config = demoConfig(yield* loadConfig(exampleConfigPath), "/tmp/demo-x", options)
      const ports = (yield* demoPorts(config, options)).map((each) => `${each.transport} ${each.port}`)
      expect(ports).toEqual(["TCP 1883", "TCP 5020", "UDP 47809", "UDP 47808", "TCP 8080"])
      const remote = { listen: "127.0.0.1", public: { broker: { host: "broker.example", port: 1883 }, site: "demo-1" } }
      const published = demoConfig(yield* loadConfig(exampleConfigPath), "/tmp/demo-x", remote)
      expect((yield* demoPorts(published, remote)).map((each) => each.port)).not.toContain(1883)
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.live("finds the first one another program holds, TCP or UDP, and none when all are free", () =>
    Effect.gen(function* () {
      const tcp = yield* holdTcp
      const udp = yield* holdUdp
      expect(yield* firstPortInUse([port("TCP", tcp), port("UDP", udp)])).toMatchObject({ transport: "TCP", port: tcp })
      expect(yield* firstPortInUse([port("UDP", udp)])).toMatchObject({ transport: "UDP", port: udp })
      expect(yield* firstPortInUse([port("TCP", 0), port("UDP", 0)])).toBeUndefined()
    }).pipe(Effect.scoped)
  )

  it("name the port, what it is for, what probably holds it and what to do, in one line", () => {
    const broker: ListenPort = {
      transport: "TCP",
      host: "127.0.0.1",
      port: 1883,
      role: "the test MQTT broker",
      likelyHolder: "another MQTT broker or ot-gateway demo"
    }
    expect(portInUseMessage(broker)).toBe(
      "port 1883 (TCP, the test MQTT broker) is in use, probably by another MQTT broker or ot-gateway demo: stop it and run the demo again, or skip the demo and describe your own building with init"
    )
  })
})
