/**
 * `init`: every combination of answers makes a config the gateway's schema accepts, and the BACnet broadcast
 * address is the subnet's.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem } from "effect"
import type { NetworkInterfaceInfo } from "node:os"
import { configSummary } from "../src/Cli.ts"
import { type InitFlags, initConfig, lanInterfaces, nextSteps, runInit, simulatedDevice } from "../src/Init.ts"
import { pointsListTemplate } from "../src/PointsSchema.ts"

const answers = { site: "vienna-hq", building: "main", brokerUrl: "mqtt://broker.lan:1883" }

const decode = (config: ReturnType<typeof initConfig>) => parseConfig(JSON.stringify(config))

const ipv4 = (address: string, netmask: string, internal = false): NetworkInterfaceInfo => ({
  family: "IPv4",
  address,
  netmask,
  internal,
  mac: "00:00:00:00:00:00",
  cidr: null
})

describe("initConfig", () => {
  it.effect("makes a valid config with a simulated device, no device, or a login", () =>
    Effect.gen(function* () {
      const simulated = yield* decode(initConfig(answers, [simulatedDevice]))
      expect(simulated.mqtt).toEqual({ url: "mqtt://broker.lan:1883", clientId: "ot-gateway-vienna-hq-main" })
      expect(simulated.devices.map((device) => device.id)).toEqual(["sim-1"])
      expect(simulated.buffer?.path).toBe("./ot-gateway-buffer.sqlite")

      const empty = yield* decode(initConfig(answers, []))
      expect(empty.devices).toEqual([])

      const login = { username: "gateway", passwordEnv: "MQTT_PASSWORD" }
      const withLogin = yield* decode(initConfig({ ...answers, login }, []))
      expect(withLogin.mqtt.username).toBe("gateway")
      expect(withLogin.mqtt.passwordEnv).toBe("MQTT_PASSWORD")
      expect(JSON.stringify(initConfig({ ...answers, login }, []))).not.toContain('password"')
    })
  )

  it.effect("takes discovered drafts (as discover drafts them) and the broadcast address they were found through", () =>
    Effect.gen(function* () {
      const drafts = [
        {
          protocol: "bacnet-ip" as const,
          id: "ahu-2",
          deviceInstance: 2001,
          address: "192.168.1.40",
          points: [{ id: "supply-temp", name: "Supply Temp", objectType: "analog-input" as const, instance: 1 }]
        }
      ]
      const config = yield* decode(initConfig({ ...answers, broadcastAddress: "192.168.1.255" }, drafts))
      expect(config.bacnet.broadcastAddress).toBe("192.168.1.255")
      expect(config.devices).toMatchObject([{ protocol: "bacnet-ip", id: "ahu-2", deviceInstance: 2001 }])
    })
  )
})

describe("lanInterfaces", () => {
  it("gives each LAN's broadcast address and leaves loopback, IPv6 and point-to-point links out", () => {
    expect(
      lanInterfaces({
        lo0: [ipv4("127.0.0.1", "255.0.0.0", true)],
        en0: [
          ipv4("192.168.1.23", "255.255.255.0"),
          { ...ipv4("fe80::1", "ffff:ffff:ffff:ffff::"), family: "IPv6", scopeid: 4 }
        ],
        en1: [ipv4("10.20.3.4", "255.255.240.0")],
        utun0: [ipv4("100.64.0.2", "255.255.255.255")]
      })
    ).toEqual([
      { name: "en0", address: "192.168.1.23", broadcast: "192.168.1.255" },
      { name: "en1", address: "10.20.3.4", broadcast: "10.20.15.255" }
    ])
  })
})

describe("nextSteps", () => {
  it.effect("names the password variable, the missing devices and the commands to run next", () =>
    Effect.gen(function* () {
      const config = yield* decode(initConfig({ ...answers, login: { username: "u", passwordEnv: "BROKER_PW" } }, []))
      const steps = nextSteps("site.json", config)
      expect(steps).toContain("set BROKER_PW")
      expect(steps).toContain("add your devices")
      expect(steps).toContain("ot-gateway run site.json")
      expect(steps).toContain("ot-gateway watch site.json")
    })
  )
})

/** `body` with a temporary folder, removed afterwards. */
const inFolder = <A, E>(
  body: (folder: string) => Effect.Effect<A, E, FileSystem.FileSystem | NodeServices.NodeServices>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* body(yield* fs.makeTempDirectoryScoped())
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe("runInit with flags", () => {
  it.effect("asks nothing with --yes, takes the flags' answers and the defaults for the rest", () =>
    inFolder((folder) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${folder}/points.csv`, pointsListTemplate())
        const path = `${folder}/ot-gateway.json`
        const config = yield* runInit(path, {
          yes: true,
          site: "vienna-hq",
          broker: "mqtts://broker.example:8883",
          username: "gateway",
          points: `${folder}/points.csv`
        })
        expect(config?.building).toBe("main")
        expect(config?.mqtt.passwordEnv).toBe("MQTT_PASSWORD")
        expect(config?.devices.map((device) => device.id)).toEqual(["main-meter", "ahu-2"])
        expect(yield* fs.exists(path)).toBe(true)

        const again = yield* runInit(path, { yes: true }).pipe(Effect.flip)
        expect(again.message).toBe(`${path} exists; --force replaces it`)
        const replaced = yield* runInit(path, { yes: true, force: true })
        expect(replaced?.devices.map((device) => device.id)).toEqual(["sim-1"])
      })
    )
  )

  it.effect("checks each flag as its question would, and says which flag is wrong", () =>
    inFolder((folder) =>
      Effect.gen(function* () {
        const path = `${folder}/ot-gateway.json`
        const failure = (flags: InitFlags) => runInit(path, { yes: true, ...flags }).pipe(Effect.flip)
        expect((yield* failure({ site: "Vienna HQ" })).message).toContain("--site Vienna HQ: lowercase letters")
        expect((yield* failure({ broker: "http://broker" })).message).toContain("--broker http://broker:")
        expect((yield* failure({ passwordEnv: "PW" })).message).toBe("--password-env needs --username")
        expect((yield* failure({ username: "u", passwordEnv: "pw" })).message).toContain(
          "--password-env pw: upper case"
        )
        expect((yield* failure({ points: "p.csv", devices: "simulated" })).message).toContain("leave out --devices")
        expect((yield* failure({ points: `${folder}/absent.csv` })).message).toContain("no points list at")
      })
    )
  )
})

describe("configSummary", () => {
  it.effect("is what check prints, as data", () =>
    Effect.gen(function* () {
      const config = yield* decode(initConfig(answers, [simulatedDevice]))
      expect(configSummary(config)).toEqual({
        ok: true,
        site: "vienna-hq",
        building: "main",
        gateway: "main",
        broker: "mqtt://broker.lan:1883",
        buffer: "./ot-gateway-buffer.sqlite",
        warnings: [],
        devices: [{ id: "sim-1", protocol: "simulator", points: 2, writable: 0, pollIntervalMs: 2000 }]
      })
    })
  )
})
