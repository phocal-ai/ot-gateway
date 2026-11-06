/**
 * The command line: the forms from before the subcommands keep working, and the demo's config is the example
 * with its outbox and status page moved.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig, publicTestBrokers } from "@ot-gateway/core"
import { Effect } from "effect"
import { cliVersion, describeConfig, toCliArgs } from "../src/Cli.ts"
import {
  demoBanner,
  demoConfig,
  exampleConfigPath,
  pickPublicBroker,
  type PublicBroker,
  publicBrokers,
  randomDemoSite
} from "../src/Demo.ts"
import { loadConfig } from "../src/LoadConfig.ts"

describe("cliVersion", () => {
  it("drops a release tag's v, which the CLI prints itself", () => {
    expect(cliVersion("v0.7.0")).toBe("0.7.0")
    expect(cliVersion("v0.8.0-rc.1")).toBe("0.8.0-rc.1")
  })

  it("leaves a dev build or a commit as it is", () => {
    expect(cliVersion("dev")).toBe("dev")
    expect(cliVersion("c78bb4e09-dirty")).toBe("c78bb4e09-dirty")
  })
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
      expect(banner).toContain("main-meter (Modbus TCP)")
      expect(banner).toContain("init to describe your own building")
      expect(describeConfig(config)).toContain("config ok: demo-site/b1")
    }).pipe(Effect.provide(NodeServices.layer))
  )

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
      expect(banner).toContain(`mosquitto_sub -h broker.emqx.io -p 1883 -t '${site}/b1/#' -v`)
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
