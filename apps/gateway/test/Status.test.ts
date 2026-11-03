/**
 * The status page's data: what the snapshot keeps, and the API served over
 * real HTTP and read back with the same typed client the page uses.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { PlenumApi } from "@plenum/api"
import { makeHealthRegistry, parseConfig } from "@plenum/core"
import { Effect, Fiber } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { createServer } from "node:net"
import { makeStatusState, serveStatus } from "../src/Status.ts"

const config = parseConfig(
  JSON.stringify({
    site: "s",
    building: "b",
    mqtt: { url: "mqtt://broker" },
    status: { webRoot: "/nonexistent" },
    devices: [
      {
        protocol: "modbus-tcp",
        id: "meter",
        host: "10.0.1.1",
        points: [
          { id: "power", name: "Power", unit: "unit:KiloW", table: "holding", address: 0, dataType: "float32" },
          {
            id: "setpoint",
            name: "Setpoint",
            table: "holding",
            address: 2,
            dataType: "float32",
            writable: true,
            limits: { min: 0, max: 10 }
          }
        ]
      }
    ]
  })
)

/** A port nothing listens on right now. */
const freePort = Effect.promise(
  () =>
    new Promise<number>((resolve) => {
      const probe = createServer()
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address()
        probe.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0))
      })
    })
)

describe("status", () => {
  it.effect("keeps each point's last value and the newest 50 commands", () =>
    Effect.gen(function* () {
      const parsed = yield* config
      const health = makeHealthRegistry(["meter"])
      health.recordSuccess("meter", 1_000)
      const state = makeStatusState(parsed, health, 500)
      state.recordPublish("s/b/meter/power", '{"value":12.5,"ts":900,"unit":"unit:KiloW"}')
      state.recordPublish("s/b/meter/power/$meta", '{"name":"Power"}')
      state.recordPublish("other/site/meter/power", '{"value":99,"ts":1}')
      state.recordPublish("s/b/meter/power", "not json")
      for (let index = 0; index < 52; index++) {
        state.recordCommand(index, { device: "meter", point: "setpoint" }, { status: "written", value: index })
      }
      state.recordCommand(
        60,
        { device: "meter", point: "setpoint" },
        {
          status: "rejected",
          reason: "out-of-range",
          message: "99 is outside 0 to 10"
        }
      )

      const snapshot = yield* state.snapshot
      expect(snapshot.devices).toEqual([
        {
          id: "meter",
          protocol: "modbus-tcp",
          status: "ok",
          lastSuccess: 1_000,
          points: [
            { id: "power", name: "Power", unit: "unit:KiloW", writable: false, value: 12.5, ts: 900 },
            { id: "setpoint", name: "Setpoint", writable: true }
          ]
        }
      ])
      expect(snapshot.commands).toHaveLength(50)
      expect(snapshot.commands[0]).toEqual({
        at: 60,
        device: "meter",
        point: "setpoint",
        status: "rejected",
        reason: "out-of-range"
      })
      expect(snapshot.broker).toEqual({ url: "mqtt://broker", connected: false })
    })
  )

  it.live("serves the snapshot on /api/status, read back with the page's typed client", () =>
    Effect.gen(function* () {
      const parsed = yield* config
      const port = yield* freePort
      const state = makeStatusState(parsed, makeHealthRegistry(["meter"]), 500)
      state.recordPublish("s/b/meter/power", '{"value":3,"ts":700}')
      const server = yield* serveStatus({ bindAddress: "127.0.0.1", port, webRoot: "/nonexistent" }, state).pipe(
        Effect.provide(NodeServices.layer),
        Effect.forkChild
      )
      yield* Effect.sleep("300 millis")
      const client = yield* HttpApiClient.make(PlenumApi, { baseUrl: `http://127.0.0.1:${port}` })
      const status = yield* client.status.status()
      expect(status.devices[0]?.points[0]?.value).toBe(3)
      // Without a built web app, the root says so instead of failing.
      const root = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/`).then((response) => response.text()))
      expect(root).toContain("/api/status")
      yield* Fiber.interrupt(server)
    }).pipe(Effect.provide(FetchHttpClient.layer))
  )
})
