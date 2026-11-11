/**
 * The command line: the forms from before the subcommands keep working, and the demo's config is the example
 * with its outbox and status page moved.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig, publicTestBrokers } from "@ot-gateway/core"
import { Effect, FileSystem } from "effect"
import { TestConsole } from "effect/testing"
import type { NetworkInterfaceInfo } from "node:os"
import type { BrokerReport } from "../src/Broker.ts"
import {
  brokerOutcome,
  configSummary,
  describeConfig,
  messagesArguments,
  pointsListOutcome,
  refuseConfigAsPayload,
  runCli,
  toCliArgs,
  versionLine
} from "../src/Cli.ts"
import {
  demoBanner,
  demoConfig,
  exampleConfigPath,
  pickPublicBroker,
  type PublicBroker,
  publicBrokers,
  randomDemoSite,
  reachableLanAddresses,
  remoteStatusHosts
} from "../src/Demo.ts"
import { loadConfig } from "../src/LoadConfig.ts"

describe("versionLine", () => {
  it("prints a release as its tag", () => {
    expect(versionLine("ot-gateway", "v0.7.0")).toBe("ot-gateway v0.7.0")
    expect(versionLine("ot-gateway", "v0.8.0-rc.1")).toBe("ot-gateway v0.8.0-rc.1")
    expect(versionLine("ot-gateway", "0.9.0")).toBe("ot-gateway v0.9.0")
  })

  it("prints a local build or a commit without a v", () => {
    expect(versionLine("ot-gateway", "dev")).toBe("ot-gateway dev")
    expect(versionLine("ot-gateway", "c78bb4e09-dirty")).toBe("ot-gateway c78bb4e09-dirty")
  })

  it.effect("is what --version prints: a checkout without a VERSION file is dev, with no v", () =>
    Effect.gen(function* () {
      yield* runCli(["--version"])
      expect(yield* TestConsole.logLines).toEqual(["ot-gateway dev"])
    }).pipe(Effect.provide([TestConsole.layer, NodeServices.layer]))
  )
})

describe("toCliArgs", () => {
  it("passes subcommands and flags such as --help through", () => {
    expect(toCliArgs(["demo"])).toEqual(["demo"])
    expect(toCliArgs(["check", "a.json"])).toEqual(["check", "a.json"])
    expect(toCliArgs(["init"])).toEqual(["init"])
    expect(toCliArgs(["watch", "a.json"])).toEqual(["watch", "a.json"])
    expect(toCliArgs(["status", "--url", "http://pi:8080"])).toEqual(["status", "--url", "http://pi:8080"])
    expect(toCliArgs(["--help"])).toEqual(["--help"])
    expect(toCliArgs(["--version"])).toEqual(["--version"])
  })

  it("runs a bare config path, and ot-gateway.json without arguments, as before", () => {
    expect(toCliArgs(["/etc/ot-gateway/gateway.json"])).toEqual(["run", "/etc/ot-gateway/gateway.json"])
    expect(toCliArgs([])).toEqual(["run"])
  })

  it("turns --check and --discover, before or after the path, into their subcommands", () => {
    expect(toCliArgs(["--check", "a.json"])).toEqual(["check", "a.json"])
    expect(toCliArgs(["a.json", "--check"])).toEqual(["check", "a.json"])
    expect(toCliArgs(["--discover", "a.json"])).toEqual(["discover", "a.json"])
  })
})

/** One IPv4 address of a /24 as `os.networkInterfaces()` lists it. */
const info = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  family: "IPv4",
  internal,
  netmask: "255.255.255.0",
  mac: "00:00:00:00:00:00",
  cidr: `${address}/24`
})
const linkLocal: NetworkInterfaceInfo = {
  address: "fe80::1",
  family: "IPv6",
  internal: false,
  netmask: "ffff:ffff:ffff:ffff::",
  mac: "00:00:00:00:00:00",
  cidr: "fe80::1/64",
  scopeid: 2
}

/** A config with one BACnet device of three points (two present values), with `device` merged in. */
const bacnetConfig = (device: Record<string, unknown>) =>
  parseConfig(
    JSON.stringify({
      site: "s",
      building: "b",
      mqtt: { url: "mqtt://broker" },
      devices: [
        {
          protocol: "bacnet-ip",
          id: "heat-pump",
          deviceInstance: 2001,
          address: "127.0.0.1:47809",
          points: [
            { id: "flow-temperature", name: "Flow", objectType: "analog-input", instance: 1 },
            { id: "running", name: "Running", objectType: "binary-input", instance: 2 },
            { id: "flow-name", name: "Flow name", objectType: "analog-input", instance: 1, property: "object-name" }
          ],
          ...device
        }
      ]
    })
  )

describe("check", () => {
  it.effect("says which BACnet points are asked for by change of value, with the poll interval as the fallback", () =>
    Effect.gen(function* () {
      const config = yield* bacnetConfig({})
      expect(describeConfig(config)).toContain(
        "heat-pump: bacnet-ip device 2001 at 127.0.0.1:47809, 3 point(s): 2 by COV where the device supports it, polled every 5000 ms otherwise"
      )
      expect(configSummary(config).devices).toEqual([
        {
          id: "heat-pump",
          protocol: "bacnet-ip",
          points: 3,
          writable: 0,
          pollIntervalMs: 5000,
          covPoints: ["flow-temperature", "running"],
          alarmPoints: [],
          reading: "2 by COV where the device supports it, polled every 5000 ms otherwise"
        }
      ])
      const allPushed = yield* bacnetConfig({
        points: [{ id: "flow", name: "Flow", objectType: "analog-input", instance: 1 }]
      })
      expect(describeConfig(allPushed)).toContain(
        "1 point(s): COV where the device supports it, polled every 5000 ms otherwise"
      )
      const polled = yield* bacnetConfig({ cov: false })
      expect(describeConfig(polled)).toContain("3 point(s), every 5000 ms")
      expect(configSummary(polled).devices[0]?.covPoints).toEqual([])
    })
  )
})

describe("demo", () => {
  it.effect("runs the example with the outbox in its own directory and the status page where it is asked", () =>
    Effect.gen(function* () {
      const example = yield* loadConfig(exampleConfigPath)
      const config = demoConfig(example, "/tmp/demo-x", { listen: "0.0.0.0" })
      expect(config.buffer?.path).toBe("/tmp/demo-x/buffer.sqlite")
      expect(config.status?.bindAddress).toBe("0.0.0.0")
      expect(config.status?.port).toBe(example.status?.port)
      expect(config.devices).toEqual(example.devices)
      const banner = demoBanner(config, { listen: "0.0.0.0" })
      expect(banner).toContain("http://localhost:8080")
      expect(banner).toContain("energy-meter (Modbus TCP)")
      expect(banner).toContain("init to describe your own building")
      expect(describeConfig(config)).toContain("config ok: demo-site/building-a")
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("names the LAN addresses next to localhost when the status page listens beyond loopback", () =>
    Effect.gen(function* () {
      const example = yield* loadConfig(exampleConfigPath)
      const everywhere = { listen: "0.0.0.0" }
      const lans = ["192.168.0.171", "10.0.0.5", "172.17.0.1"]
      expect(demoBanner(demoConfig(example, "/tmp/demo-x", everywhere), everywhere, lans)).toContain(
        "http://localhost:8080 (from another computer: http://192.168.0.171:8080 or http://10.0.0.5:8080):"
      )
      const loopback = { listen: "127.0.0.1" }
      const local = demoBanner(demoConfig(example, "/tmp/demo-x", loopback), loopback, lans)
      expect(local).toContain("http://localhost:8080: every device")
      expect(local).not.toContain("from another computer")
      expect(remoteStatusHosts("0.0.0.0", [])).toEqual([])
      expect(remoteStatusHosts("::", ["192.168.0.171", "192.168.0.171"])).toEqual(["192.168.0.171"])
      expect(remoteStatusHosts("10.1.2.3", lans)).toEqual(["10.1.2.3"])
      expect(remoteStatusHosts("localhost", lans)).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it("leaves loopback, IPv6 and Docker's own networks out of the addresses another computer can reach", () => {
    const pi = {
      lo: [info("127.0.0.1", true)],
      eth0: [info("192.168.0.171"), linkLocal],
      docker0: [info("172.18.0.1")],
      "br-1a2b": [info("172.19.0.1")],
      wlan0: [info("10.0.0.5")]
    }
    expect(reachableLanAddresses(pi)).toEqual(["192.168.0.171", "10.0.0.5"])
    // A container without host networking sees only its bridge address, which no other computer reaches.
    expect(reachableLanAddresses({ lo: pi.lo, eth0: [info("172.17.0.2")] })).toEqual([])
  })

  it.effect("publishes to a public test broker under a site and client id of its own, which the config accepts", () =>
    Effect.gen(function* () {
      const site = yield* randomDemoSite
      expect(site).toMatch(/^demo-[0-9a-f]{6}$/)
      const options = { listen: "127.0.0.1", public: { broker: { host: "broker.emqx.io", port: 1883 }, site } }
      const config = demoConfig(yield* loadConfig(exampleConfigPath), "/tmp/demo-y", options)
      expect(config.site).toBe(site)
      expect(config.mqtt).toEqual({
        version: "auto",
        url: "mqtt://broker.emqx.io:1883",
        clientId: `ot-gateway-${site}`
      })
      // What the gateway runs is decoded again, as a config file would be: the public-broker guard lets it through.
      expect((yield* parseConfig(JSON.stringify(config))).site).toBe(site)
      const banner = demoBanner(config, options)
      expect(banner).toContain(`mosquitto_sub -h broker.emqx.io -p 1883 -t '${site}/building-a/#' -v`)
      expect(banner).toContain("never point a real device at it")
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("takes the first public broker that answers, and says what to do when none does", () =>
    Effect.gen(function* () {
      const tried: Array<string> = []
      const onlyEmqx = (broker: PublicBroker) => {
        tried.push(broker.host)
        return Effect.succeed(broker.host === "broker.emqx.io")
      }
      expect(yield* pickPublicBroker(onlyEmqx)).toEqual({ host: "broker.emqx.io", port: 1883 })
      expect(tried).toEqual(["broker.hivemq.com", "broker.emqx.io"])
      const error = yield* Effect.flip(pickPublicBroker(() => Effect.succeed(false)))
      expect(error._tag).toBe("NoPublicBroker")
      expect(error.message).toContain("ot-gateway demo without --public")
      // Every broker the demo may pick is one the config guard knows as public.
      for (const broker of publicBrokers) expect(publicTestBrokers.has(broker.host)).toBe(true)
    })
  )
})

describe("discover --points-list", () => {
  it.effect("prints what it wrote as JSON with --json, and nothing on stdout without", () =>
    Effect.gen(function* () {
      const written = { path: "points.csv", devices: 2, points: 14, added: 12, skipped: 2, appended: true }
      yield* pointsListOutcome(false)(written)
      expect(yield* TestConsole.logLines).toEqual([])
      yield* pointsListOutcome(true)(written)
      const [line] = yield* TestConsole.logLines
      expect(JSON.parse(String(line))).toEqual({
        ok: true,
        path: "points.csv",
        devices: 2,
        points: 14,
        added: 12,
        skipped: 2,
        appended: true
      })
    }).pipe(Effect.provide(TestConsole.layer))
  )

  it.effect("fails with {ok: false} when the file exists, before it asks the network, and names --append", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const path = `${directory}/points.csv`
      yield* fs.writeFileString(path, "kept")
      const error = yield* Effect.flip(runCli(["discover", exampleConfigPath, "--points-list", path, "--json"]))
      expect(error.message).toContain(`${path} exists; add --append`)
      const [line] = yield* TestConsole.logLines
      expect(JSON.parse(String(line))).toMatchObject({ ok: false, path: exampleConfigPath })
      expect(yield* fs.readFileString(path)).toBe("kept")
    }).pipe(Effect.scoped, Effect.provide([TestConsole.layer, NodeServices.layer]))
  )

  it.effect("with --append, refuses a file that is not a points list before it asks the network", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const path = `${directory}/points.csv`
      yield* fs.writeFileString(path, "kept")
      const error = yield* Effect.flip(
        runCli(["discover", exampleConfigPath, "--points-list", path, "--append", "--json"])
      )
      expect(error.message).toContain("no device and point columns")
      expect(yield* fs.readFileString(path)).toBe("kept")
    }).pipe(Effect.scoped, Effect.provide([TestConsole.layer, NodeServices.layer]))
  )

  it.effect("refuses --append without --points-list", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(runCli(["discover", exampleConfigPath, "--append"]))
      expect(error.message).toContain("--append adds to the file --points-list names")
    }).pipe(Effect.provide([TestConsole.layer, NodeServices.layer]))
  )
})

describe("broker", () => {
  const noRoundTrip: BrokerReport = {
    ok: false,
    broker: "mqtt://127.0.0.1:1883",
    protocolVersion: "5",
    receiveMaximum: 10,
    maximumQoS: 1,
    retainAvailable: true,
    keepAliveSeconds: 30,
    roundTripTopic: "s/b/$gateway/g/check/abcdef",
    warnings: ["a message to s/b/$gateway/g/check/abcdef did not come back within 5 seconds"]
  }

  it.effect("prints the report, then fails when the message did not come back", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(brokerOutcome(false)(noRoundTrip))
      expect(error._tag).toBe("BrokerCommandError")
      expect(error.message).toContain("did not come back")
      const lines = yield* TestConsole.logLines
      expect(lines).toHaveLength(1)
      expect(String(lines[0])).toContain("round trip: NO ANSWER")
    }).pipe(Effect.provide(TestConsole.layer))
  )

  it.effect("with --json, prints the report with ok false once, and fails", () =>
    Effect.gen(function* () {
      yield* Effect.flip(brokerOutcome(true)(noRoundTrip))
      const lines = yield* TestConsole.logLines
      expect(lines).toHaveLength(1)
      expect(JSON.parse(String(lines[0]))).toMatchObject({ ok: false, roundTripTopic: noRoundTrip.roundTripTopic })
    }).pipe(Effect.provide(TestConsole.layer))
  )

  it.effect("succeeds when the message came back", () =>
    Effect.gen(function* () {
      yield* brokerOutcome(true)({ ...noRoundTrip, ok: true, roundTripMs: 3, warnings: [] })
      const [line] = yield* TestConsole.logLines
      expect(JSON.parse(String(line))).toMatchObject({ ok: true, roundTripMs: 3 })
    }).pipe(Effect.provide(TestConsole.layer))
  )
})

describe("the config argument", () => {
  it("takes the config of messages after the points, alone when it ends in .json, or as --config", () => {
    expect(messagesArguments("meter/power", "site.json", undefined)).toEqual({
      points: "meter/power",
      config: "site.json"
    })
    expect(messagesArguments("site.json", undefined, undefined)).toEqual({ config: "site.json" })
    expect(messagesArguments("meter", undefined, "site.json")).toEqual({ points: "meter", config: "site.json" })
    expect(messagesArguments(undefined, undefined, undefined)).toEqual({})
    expect(messagesArguments("meter", "a.json", "b.json")).toEqual({
      error: "two configs: a.json and --config b.json; name one"
    })
  })

  it.effect("refuses a publish payload that is a JSON file, naming --config, and sends nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const config = `${dir}/ot-gateway.json`
      yield* fs.writeFileString(config, "{}")
      const error = yield* Effect.flip(refuseConfigAsPayload(config))
      expect(error.message).toContain(`--config ${config}`)
      // Through the command line: refused before the config is read or the broker dialled.
      const viaCli = yield* Effect.flip(runCli(["publish", "site/b/x", config, "--retain", "--config", config]))
      expect(viaCli.message).toContain("is a file, not a message")
      // A JSON payload, or a .json name that is no file, goes through.
      yield* refuseConfigAsPayload(`{"value": 1}`)
      yield* refuseConfigAsPayload(`${dir}/missing.json`)
    }).pipe(Effect.scoped, Effect.provide([TestConsole.layer, NodeServices.layer]))
  )
})
