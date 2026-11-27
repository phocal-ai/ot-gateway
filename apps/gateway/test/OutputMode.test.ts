/**
 * One rule for people and agents: a terminal gets the concise view and a pipe the full one, `--json` (or
 * `OT_GATEWAY_JSON=1`) the full structure and no questions, `--all` every row in a terminal. An agent is only
 * pointed at `--json` and `ot-gateway mcp`; what it gets stays what a pipe gets.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { CommandSpec } from "effect/cli"
import { TestConsole } from "effect/testing"
import { cli, commandPath, runCli, takesJson, withJsonFromEnvironment } from "../src/Cli.ts"
import { AgentHints, agentHint, jsonFromEnvironment, runsUnderAgent, withAgentHint } from "../src/Output.ts"

/** Every command that runs (no subcommands), as its words after `ot-gateway`, with the flags it takes. */
const leafCommands = () => {
  const found: Array<{ readonly words: string; readonly flags: ReadonlySet<string> }> = []
  const walk = (path: ReadonlyArray<string>) => {
    const spec = Option.getOrThrow(CommandSpec.resolve(cli, path))
    if (spec.subcommands.length === 0) {
      found.push({ words: path.slice(1).join(" "), flags: new Set(spec.flags.map((flag) => flag.name)) })
    }
    for (const sub of spec.subcommands) walk([...path, sub.name])
  }
  walk([cli.name])
  return found
}

describe("the output rule across commands", () => {
  it("gives every one-shot command --json; the exceptions run until stopped or print a points list already", () => {
    const withoutJson = leafCommands()
      .filter((command) => !command.flags.has("json"))
      .map((command) => command.words)
    // A new command takes --json, or joins this list on purpose.
    expect(withoutJson.toSorted()).toEqual([
      "demo",
      "mcp",
      "points from-ede",
      "points template",
      "run",
      "simulate bacnet"
    ])
  })

  it("gives --all only to commands that also take --json, since a pipe and --json always get every row", () => {
    const allWithoutJson = leafCommands()
      .filter((command) => command.flags.has("all") && !command.flags.has("json"))
      .map((command) => command.words)
    expect(allWithoutJson).toEqual([])
  })
})

describe("OT_GATEWAY_JSON", () => {
  it("is on when set to anything but an off word", () => {
    expect(jsonFromEnvironment({ OT_GATEWAY_JSON: "1" })).toBe(true)
    expect(jsonFromEnvironment({ OT_GATEWAY_JSON: "true" })).toBe(true)
    for (const off of [undefined, "", "0", "false", "no", "OFF"]) {
      expect(jsonFromEnvironment({ OT_GATEWAY_JSON: off })).toBe(false)
    }
  })

  it("adds --json to a command that takes it, before a `--`", () => {
    const env = { OT_GATEWAY_JSON: "1" }
    expect(withJsonFromEnvironment(["status"], env)).toEqual(["status", "--json"])
    expect(withJsonFromEnvironment(["gateways", "list", "--broker", "mqtt://pi"], env)).toEqual([
      "gateways",
      "list",
      "--broker",
      "mqtt://pi",
      "--json"
    ])
    expect(withJsonFromEnvironment(["publish", "a/b", "--", "-1"], env)).toEqual([
      "publish",
      "a/b",
      "--json",
      "--",
      "-1"
    ])
    expect(withJsonFromEnvironment(["check", "--json"], env)).toEqual(["check", "--json"])
  })

  it("leaves a command without --json, a group and an unset variable as typed", () => {
    const env = { OT_GATEWAY_JSON: "1" }
    expect(withJsonFromEnvironment(["run", "gateway.json"], env)).toEqual(["run", "gateway.json"])
    expect(withJsonFromEnvironment([], env)).toEqual([])
    expect(withJsonFromEnvironment(["points"], env)).toEqual(["points"])
    expect(withJsonFromEnvironment(["demo"], env)).toEqual(["demo"])
    expect(withJsonFromEnvironment(["status"], {})).toEqual(["status"])
  })

  it("finds the command through flags and arguments", () => {
    expect(commandPath(["gateways", "status", "--wait", "3", "site/b/pi"])).toEqual([
      "ot-gateway",
      "gateways",
      "status"
    ])
    expect(commandPath(["check", "ot-gateway.json"])).toEqual(["ot-gateway", "check"])
    expect(takesJson(["ot-gateway", "check"])).toBe(true)
    expect(takesJson(["ot-gateway", "run"])).toBe(false)
    expect(takesJson(["ot-gateway"])).toBe(false)
  })
})

describe("agent hints", () => {
  it("recognises the variables coding agents set", () => {
    expect(runsUnderAgent({ AI_AGENT: "some-agent" })).toBe(true)
    expect(runsUnderAgent({ CLAUDECODE: "1" })).toBe(true)
    expect(runsUnderAgent({ CURSOR_AGENT: "1" })).toBe(true)
    expect(runsUnderAgent({ CLAUDECODE: "0" })).toBe(false)
    expect(runsUnderAgent({ TERM: "xterm" })).toBe(false)
  })

  it("adds the hint below a failure only when asked", () => {
    expect(withAgentHint("error: no config", true)).toBe(`error: no config\n  ${agentHint}`)
    expect(withAgentHint("error: no config", false)).toBe("error: no config")
  })

  it.effect("ends a command's help with the hint under an agent, and leaves it out otherwise", () =>
    Effect.gen(function* () {
      yield* runCli(["check", "--help"]).pipe(Effect.provideService(AgentHints, true))
      const withHint = (yield* TestConsole.logLines).join("\n")
      expect(withHint).toContain(agentHint)

      yield* runCli(["check", "--help"])
      const lines = yield* TestConsole.logLines
      expect(lines.filter((line) => String(line).includes(agentHint))).toHaveLength(1)
    }).pipe(Effect.provide([TestConsole.layer, NodeServices.layer]))
  )
})
