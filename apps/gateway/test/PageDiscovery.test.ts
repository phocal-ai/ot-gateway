/**
 * BACnet discovery from the status page when Who-Is cannot go out: the socket opens, but the machine refuses the
 * send (a container or a host without a route to the broadcast address). The page gets a result with no device and
 * a note in plain words that says what to do instead, not the socket's own words alone.
 */
import { describe, expect, it } from "@effect/vitest"
import { makeMemoryNetwork, parseConfig } from "@ot-gateway/core"
import { Effect } from "effect"
import * as DatagramSocket from "effect/socket/DatagramSocket"
import { makePageDiscovery } from "../src/PageDiscovery.ts"

const configText = JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://10.0.0.2:1883" }, devices: [] })

/** A network whose UDP sockets open and read, but refuse every send as unreachable. */
const refusingSends = () => {
  const memory = makeMemoryNetwork().host("10.0.0.1")
  return {
    udp: (options: Parameters<typeof memory.udp>[0]) =>
      Effect.map(memory.udp(options), (socket) =>
        DatagramSocket.make({
          reader: socket.reader,
          writer: Effect.succeed({
            write: () =>
              Effect.fail(
                new DatagramSocket.DatagramSocketError({
                  reason: new DatagramSocket.DatagramSocketWriteError({
                    kind: "Unreachable",
                    cause: new Error("host 255.255.255.255 unreachable")
                  })
                })
              ),
            writeAll: () =>
              Effect.fail(
                new DatagramSocket.DatagramSocketError({
                  reason: new DatagramSocket.DatagramSocketWriteError({ kind: "Unreachable", cause: new Error("x") })
                })
              )
          })
        })
      )
  }
}

describe("BACnet discovery from the page when Who-Is cannot be sent", () => {
  it.effect("says broadcast discovery is not possible here and to enter the device's address", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig(configText)
      const { discoverDevices } = makePageDiscovery({
        gate: (_target, test) => test,
        running: () => config,
        network: refusingSends()
      })
      const found = yield* discoverDevices(undefined, 1)
      expect(found.devices).toEqual([])
      expect(found.note).toContain("Broadcast discovery isn't possible from here")
      expect(found.note).toContain("Enter the device's address instead, e.g. 192.168.1.40:47808")
      expect(found.note).toContain("unreachable")
    })
  )

  it.effect("says an address it could not send to, with what to check", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig(configText)
      const { discoverDevices } = makePageDiscovery({
        gate: (_target, test) => test,
        running: () => config,
        network: refusingSends()
      })
      const found = yield* discoverDevices("10.0.0.40", 1)
      expect(found.devices).toEqual([])
      expect(found.note).toContain("could not send to 10.0.0.40")
    })
  )
})
