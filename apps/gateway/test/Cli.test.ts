/**
 * The command line: the forms from before the subcommands keep working, and the demo's config is the example
 * with its outbox and status page moved.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { describeConfig, toCliArgs } from "../src/Cli.ts"
import { demoBanner, demoConfig, exampleConfigPath } from "../src/Demo.ts"
import { loadConfig } from "../src/LoadConfig.ts"

describe("toCliArgs", () => {
  it("passes subcommands and flags such as --help through", () => {
    expect(toCliArgs(["demo"])).toEqual(["demo"])
    expect(toCliArgs(["check", "a.json"])).toEqual(["check", "a.json"])
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
      expect(demoBanner(config)).toContain("http://localhost:8080")
      expect(describeConfig(config)).toContain("config ok: demo-site/b1")
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
