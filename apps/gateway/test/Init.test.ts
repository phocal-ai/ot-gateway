/**
 * `init`: every combination of answers makes a config the gateway's schema accepts, and the BACnet broadcast
 * address is the subnet's.
 */
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { Effect } from "effect"
import type { NetworkInterfaceInfo } from "node:os"
import { initConfig, lanInterfaces, nextSteps, simulatedDevice } from "../src/Init.ts"

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
