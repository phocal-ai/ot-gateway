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
import {
  defaultFolder,
  type InitFlags,
  initConfig,
  initNext,
  initTarget,
  isInteractive,
  lanInterfaces,
  nextSteps,
  runInit,
  simulatedDevice,
  sshSession
} from "../src/Init.ts"
import { pointsListTemplate } from "../src/PointsSchema.ts"

const answers = { site: "site-1", building: "building-a", brokerUrl: "mqtt://broker.lan:1883" }

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
      expect(simulated.mqtt).toEqual({
        url: "mqtt://broker.lan:1883",
        clientId: "ot-gateway-site-1-building-a",
        version: "auto"
      })
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
          id: "ventilation-2",
          deviceInstance: 2001,
          address: "192.168.1.40",
          points: [{ id: "supply-temp", name: "Supply Temp", objectType: "analog-input" as const, instance: 1 }]
        }
      ]
      const config = yield* decode(initConfig({ ...answers, broadcastAddress: "192.168.1.255" }, drafts))
      expect(config.bacnet.broadcastAddress).toBe("192.168.1.255")
      expect(config.devices).toMatchObject([{ protocol: "bacnet-ip", id: "ventilation-2", deviceInstance: 2001 }])
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
  it.effect("names the password variable, then adding devices before the commands that run them", () =>
    Effect.gen(function* () {
      const config = yield* decode(initConfig({ ...answers, login: { username: "u", passwordEnv: "BROKER_PW" } }, []))
      const steps = nextSteps("site.json", config)
      expect(steps).toContain("set BROKER_PW")
      expect(steps).toContain("ot-gateway points template > points.csv")
      expect(steps.indexOf("ot-gateway import points.csv site.json")).toBeLessThan(steps.indexOf("ot-gateway run"))
      expect(steps).toContain("ot-gateway run site.json")
      expect(steps).toContain("ot-gateway watch site.json")
    })
  )
})

describe("sshSession", () => {
  it("is undefined outside SSH", () => {
    expect(sshSession({})).toBeUndefined()
    expect(sshSession({ SSH_CONNECTION: "", USER: "pi" })).toBeUndefined()
  })

  it("takes the host from SSH_CONNECTION's server address and the user from USER, else LOGNAME", () => {
    expect(sshSession({ SSH_CONNECTION: "192.168.1.20 53412 192.168.1.50 22", USER: "pi" })).toEqual({
      host: "192.168.1.50",
      user: "pi"
    })
    expect(sshSession({ SSH_CONNECTION: "fe80::2 53412 fe80::1 22", LOGNAME: "admin" })).toEqual({
      host: "fe80::1",
      user: "admin"
    })
  })

  it("leaves out what SSH_CLIENT does not say, and anything unsafe in a command line", () => {
    expect(sshSession({ SSH_CLIENT: "192.168.1.20 53412 22" })).toEqual({ host: undefined, user: undefined })
    expect(sshSession({ SSH_CONNECTION: "a 1 $(reboot) 22", USER: "-oProxyCommand=x" })).toEqual({
      host: undefined,
      user: undefined
    })
  })
})

describe("initNext over SSH", () => {
  it.effect("adds the tunnel to the status page after the command that starts it, in text and as steps", () =>
    Effect.gen(function* () {
      const config = yield* decode(initConfig(answers, [simulatedDevice]))
      const ssh = { host: "192.168.1.50", user: "pi" }
      const tunnel = "ssh -L 8080:127.0.0.1:8080 pi@192.168.1.50"
      const { next } = initNext("site.json", config, { written: [], kept: [] }, ssh)
      const commands = next.map((step) => step.command)
      expect(commands.indexOf(tunnel)).toBe(commands.indexOf("ot-gateway run site.json") + 1)
      expect(next.find((step) => step.command === tunnel)?.description).toContain("http://localhost:8080")
      const text = nextSteps("site.json", config, { written: [], kept: [] }, ssh)
      expect(text).toContain(tunnel)
      expect(nextSteps("site.json", config)).not.toContain("ssh -L")
    })
  )

  it.effect("forwards the configured status port, with placeholders for what the environment does not say", () =>
    Effect.gen(function* () {
      const config = yield* decode({ ...initConfig(answers, [simulatedDevice]), status: { port: 8181 } })
      const { next } = initNext("site.json", config, { written: [], kept: [] }, { host: undefined, user: undefined })
      expect(next.map((step) => step.command)).toContain("ssh -L 8080:127.0.0.1:8181 <user>@<host>")
    })
  )

  it.effect("mirrors the text's commands and notes, for --json", () =>
    Effect.gen(function* () {
      const config = yield* decode(initConfig({ ...answers, login: { username: "u", passwordEnv: "BROKER_PW" } }, []))
      const { notes, next } = initNext("site.json", config)
      const text = nextSteps("site.json", config)
      expect(notes).toEqual(["set BROKER_PW to the broker password before you start the gateway"])
      for (const step of next) expect(text).toContain(step.command)
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
  it.effect("works out the config on a dry run and writes nothing, not even the folder", () =>
    inFolder((folder) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = `${folder}/site-1/ot-gateway.json`
        const config = yield* runInit(path, { yes: true, dryRun: true, site: "site-1", username: "gateway" })
        expect(config?.site).toBe("site-1")
        expect(config?.mqtt.passwordEnv).toBe("MQTT_PASSWORD")
        expect(yield* fs.exists(`${folder}/site-1`)).toBe(false)
      })
    )
  )

  it.effect("asks nothing with --yes, takes the flags' answers and the defaults for the rest", () =>
    inFolder((folder) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${folder}/points.csv`, pointsListTemplate())
        const path = `${folder}/ot-gateway.json`
        const config = yield* runInit(path, {
          yes: true,
          site: "site-1",
          broker: "mqtts://broker.example:8883",
          username: "gateway",
          points: `${folder}/points.csv`
        })
        expect(config?.building).toBe("main")
        expect(config?.mqtt.passwordEnv).toBe("MQTT_PASSWORD")
        expect(config?.devices.map((device) => device.id)).toEqual(["energy-meter", "sub-meter", "heat-pump"])
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
        expect((yield* failure({ site: "Site 1" })).message).toContain("--site Site 1: lowercase letters")
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

const twoLans = () => [
  { name: "eth0", address: "10.0.0.5", broadcast: "10.0.0.255" },
  { name: "eth1", address: "192.168.7.5", broadcast: "192.168.7.255" }
]
/** Fails the test (a defect) if init reads the networks when it should not need them. */
const noLans = () => {
  throw new Error("the networks are read only when no --broadcast is given and a device needs one")
}

describe("runInit --broadcast", () => {
  it.effect("goes into the config with no devices yet, for a discover later", () =>
    inFolder((folder) =>
      Effect.gen(function* () {
        const flags = { yes: true, devices: "none", broadcast: "192.168.1.255" } as const
        const config = yield* runInit(`${folder}/ot-gateway.json`, flags, noLans)
        expect(config?.bacnet.broadcastAddress).toBe("192.168.1.255")
      })
    )
  )

  it.effect("goes into the config with the simulated device", () =>
    inFolder((folder) =>
      Effect.gen(function* () {
        const flags = { yes: true, devices: "simulated", broadcast: "192.168.1.255" } as const
        const config = yield* runInit(`${folder}/ot-gateway.json`, flags, noLans)
        expect(config?.bacnet.broadcastAddress).toBe("192.168.1.255")
      })
    )
  )

  it.effect("goes into the config with a points list's BACnet device", () =>
    inFolder((folder) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${folder}/points.csv`, pointsListTemplate())
        const flags = { yes: true, points: `${folder}/points.csv`, broadcast: "192.168.1.255" }
        const config = yield* runInit(`${folder}/ot-gateway.json`, flags, noLans)
        expect(config?.devices.some((device) => device.protocol === "bacnet-ip")).toBe(true)
        expect(config?.bacnet.broadcastAddress).toBe("192.168.1.255")
      })
    )
  )

  it.effect("without it, writes no bacnet key when no device is found by broadcast", () =>
    inFolder((folder) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = `${folder}/ot-gateway.json`
        yield* runInit(path, { yes: true, devices: "none" }, noLans)
        expect(JSON.parse(yield* fs.readFileString(path))).not.toHaveProperty("bacnet")
      })
    )
  )

  it.effect("without it, picks the network for a points list's BACnet device that has no address", () =>
    inFolder((folder) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${folder}/points.csv`, pointsListTemplate())
        const config = yield* runInit(
          `${folder}/ot-gateway.json`,
          { yes: true, points: `${folder}/points.csv` },
          twoLans
        )
        expect(config?.bacnet.broadcastAddress).toBe("10.0.0.255")
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
        site: "site-1",
        building: "building-a",
        gateway: "main",
        broker: "mqtt://broker.lan:1883",
        buffer: "./ot-gateway-buffer.sqlite",
        warnings: [],
        devices: [
          {
            id: "sim-1",
            protocol: "simulator",
            points: 2,
            writable: 0,
            pollIntervalMs: 2000,
            covPoints: [],
            reading: "every 2000 ms"
          }
        ]
      })
    })
  )
})

describe("initTarget", () => {
  it.effect("takes a folder as create-next-app does, the default one with --yes, and a .json path as the config", () =>
    Effect.gen(function* () {
      expect(yield* initTarget("site-1", false)).toBe("site-1/ot-gateway.json")
      expect(yield* initTarget(".", false)).toBe("ot-gateway.json")
      expect(yield* initTarget(undefined, true)).toBe(`${defaultFolder}/ot-gateway.json`)
      expect(yield* initTarget("site.json", false)).toBe("site.json")
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("makes a missing folder, and the next steps start with cd and need no config argument", () =>
    inFolder((folder) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* initTarget(`${folder}/new/site-1`, true)
        const config = yield* runInit(path, { yes: true })
        expect(yield* fs.exists(path)).toBe(true)
        if (config === undefined) return expect.unreachable()
        const steps = nextSteps(path, config, { written: [path, `${folder}/new/site-1/compose.yaml`], kept: [] })
        expect(steps).toContain(`cd ${folder}/new/site-1`)
        expect(steps).toMatch(/ot-gateway check {2,}validate/)
      })
    )
  )
})

describe("isInteractive", () => {
  it("asks only with a terminal and without --yes", () => {
    expect(isInteractive(false, true)).toBe(true)
    expect(isInteractive(true, true)).toBe(false)
    expect(isInteractive(false, false)).toBe(false)
    expect(isInteractive(false, undefined)).toBe(false)
  })
})
