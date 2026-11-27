/**
 * `ot-gateway mcp`: the protocol over stdio, the tools' arguments as command lines, and tool calls that run the
 * real CLI with --json.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Console, Effect, Exit, Predicate, Sink, Stream } from "effect"
import * as Stdio from "effect/Stdio"
import { runCli } from "../src/Cli.ts"
import { boundedLines, lineConsole, PROTOCOL_VERSIONS, runTool, serveMcp, type RunCommand } from "../src/Mcp.ts"
import { mcpTools, toolNamesUnique } from "../src/McpTools.ts"
import { printJson } from "../src/Output.ts"

const silent = lineConsole(() => {})

const toolNamed = (name: string) => {
  const tool = mcpTools.find((each) => each.name === name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool
}

const argvOf = (name: string, input: unknown) => Effect.runSync(Effect.exit(toolNamed(name).argv(input)))

/** Serves the lines as stdin until they end, and returns each line the server wrote, parsed. */
const serve = (lines: ReadonlyArray<unknown>, run: RunCommand<never>) =>
  Effect.gen(function* () {
    const written: Array<string> = []
    const stdio = Stdio.layerTest({
      stdin: Stream.make(...lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`)).pipe(
        Stream.encodeText
      ),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.sync(() => {
            written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
          })
        )
    })
    yield* serveMcp({ tools: mcpTools, version: "1.2.3", run, log: silent }).pipe(Effect.provide(stdio))
    return written
      .join("")
      .split("\n")
      .filter((line) => line !== "")
      .map((line): unknown => JSON.parse(line))
  })

const byId = (messages: ReadonlyArray<unknown>, id: number) =>
  messages.find((message) => Predicate.isObject(message) && "id" in message && message.id === id)

const request = (id: number, method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params })
})

/** A stand-in CLI that prints what it was asked as its JSON result. */
const echo: RunCommand<never> = (argv) => printJson({ ok: true, argv })

describe("mcp tools", () => {
  it("discover_modbus makes the discover modbus command line, read-only and without a file to write", () => {
    expect(argvOf("discover_modbus", { range: "192.168.1.0/24", unitIds: "1-247", rate: 5 })).toEqual(
      Exit.succeed(["discover", "modbus", "192.168.1.0/24", "--unit-ids=1-247", "--rate=5"])
    )
    expect(Exit.isFailure(argvOf("discover_modbus", { range: "--points-list=x.csv" }))).toBe(true)
    expect(Exit.isFailure(argvOf("discover_modbus", { range: "10.0.0.1", pointsList: "x.csv" }))).toBe(true)
    expect(toolNamed("discover_modbus").annotations.readOnlyHint).toBe(true)
  })

  it("have one name each, an object input schema and a description", () => {
    expect(toolNamesUnique(mcpTools)).toBe(true)
    for (const tool of mcpTools) {
      expect(tool.name).toMatch(/^[a-z_]+$/)
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema).toMatchObject({ type: "object" })
    }
  })

  it("pass flag values as --name=value and leave out what is not given", () => {
    expect(argvOf("status", { config: "site/ot-gateway.json", failOnAlarm: true })).toEqual(
      Exit.succeed(["status", "--config=site/ot-gateway.json", "--fail-on-alarm"])
    )
    expect(argvOf("status", {})).toEqual(Exit.succeed(["status"]))
    expect(argvOf("history", { points: "meter/power", since: "1h", buckets: 4 })).toEqual(
      Exit.succeed(["history", "meter/power", "--since=1h", "--buckets=4"])
    )
    expect(argvOf("watch", { seconds: 10, check: true })).toEqual(Exit.succeed(["watch", "--seconds=10", "--check"]))
  })

  it("write a number, a switch or a release as the CLI takes them", () => {
    expect(argvOf("write", { point: "room/setpoint", value: -2.5 })).toEqual(
      Exit.succeed(["write", "room/setpoint", "-2.5"])
    )
    expect(argvOf("write", { point: "plant/pump", value: true })).toEqual(Exit.succeed(["write", "plant/pump", "true"]))
    expect(argvOf("write", { point: "ahu/damper", value: null })).toEqual(Exit.succeed(["write", "ahu/damper", "null"]))
  })

  it("refuse unknown keys, wrong types and arguments that would be flags", () => {
    for (const [name, input] of [
      ["check", { confg: "x.json" }],
      ["check", { config: "--points-list=/etc/passwd" }],
      ["read", { points: "-x" }],
      ["write", { point: "a/b", value: "--retain" }],
      ["write", { point: "a/b", value: Number.NaN }],
      ["write", { point: "a/b" }],
      ["watch", {}],
      ["watch", { seconds: 0 }],
      ["history", { points: "a/b", buckets: 1.5 }],
      ["contract", { message: "nope" }]
    ] as const) {
      const exit = argvOf(name, input)
      expect(Exit.isFailure(exit), `${name} ${JSON.stringify(input)}`).toBe(true)
    }
  })

  it("import only checks unless told otherwise", () => {
    expect(argvOf("import", { pointsList: "points.csv" })).toEqual(Exit.succeed(["import", "points.csv", "--dry-run"]))
    expect(argvOf("import", { pointsList: "points.csv", dryRun: false })).toEqual(
      Exit.succeed(["import", "points.csv"])
    )
  })

  it("mark write, making a point writable, removing a device, and stopping, restarting or upgrading the gateway, as the tools that may break something", () => {
    const changing = mcpTools.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name)
    expect(changing).toEqual([
      "write",
      "points_allow_commands",
      "config_remove",
      "config_undo",
      "restart",
      "down",
      "upgrade"
    ])
  })

  it("config_set only checks unless told otherwise, and passes the value as JSON in a flag", () => {
    expect(argvOf("config_set", { key: "devices.meter.pollIntervalMs", value: 10_000 })).toEqual(
      Exit.succeed(["config", "set", "devices.meter.pollIntervalMs", "--value=10000", "--dry-run"])
    )
    // A text stays a text, digits and a leading - too.
    expect(argvOf("config_set", { key: "mqtt.clientId", value: "5000", dryRun: false })).toEqual(
      Exit.succeed(["config", "set", "mqtt.clientId", '--value="5000"'])
    )
    expect(
      argvOf("config_set", {
        key: "devices.meter.points.t.scaling",
        value: { offset: -40 },
        config: "a/ot-gateway.json"
      })
    ).toEqual(
      Exit.succeed([
        "config",
        "set",
        "devices.meter.points.t.scaling",
        '--value={"offset":-40}',
        "--config=a/ot-gateway.json",
        "--dry-run"
      ])
    )
    expect(argvOf("config_set", { key: "devices.meter.pollIntervalMs", unset: true })).toEqual(
      Exit.succeed(["config", "unset", "devices.meter.pollIntervalMs", "--dry-run"])
    )
    expect(Exit.isFailure(argvOf("config_set", { key: "--config=/etc/passwd", value: 1 }))).toBe(true)
    expect(argvOf("config_remove", { target: "meter/power" })).toEqual(
      Exit.succeed(["config", "remove", "meter/power", "--dry-run"])
    )
    expect(argvOf("config_get", {})).toEqual(Exit.succeed(["config", "get"]))
    expect(argvOf("config_undo", {})).toEqual(Exit.succeed(["config", "undo", "--dry-run"]))
    expect(argvOf("config_undo", { dryRun: false })).toEqual(Exit.succeed(["config", "undo"]))
  })

  it("points_allow_commands only checks unless told otherwise, and passes limits as flags, negative ones too", () => {
    expect(argvOf("points_allow_commands", { point: "heat-pump/setpoint", min: -5, max: 25 })).toEqual(
      Exit.succeed(["points", "allow-commands", "heat-pump/setpoint", "--min=-5", "--max=25", "--dry-run"])
    )
    expect(
      argvOf("points_allow_commands", { point: "plant/enable", config: "site/ot-gateway.json", dryRun: false })
    ).toEqual(Exit.succeed(["points", "allow-commands", "plant/enable", "site/ot-gateway.json"]))
    expect(Exit.isFailure(argvOf("points_allow_commands", { point: "--config=/etc/passwd" }))).toBe(true)
    expect(argvOf("points_read_only", { point: "heat-pump/setpoint" })).toEqual(
      Exit.succeed(["points", "read-only", "heat-pump/setpoint"])
    )
  })

  it("passes up and upgrade's flags as flags", () => {
    expect(argvOf("up", { config: "site/ot-gateway.json", timeout: 60 })).toEqual(
      Exit.succeed(["up", "site/ot-gateway.json", "--timeout=60"])
    )
    expect(argvOf("upgrade", { check: true, to: "v0.16.0" })).toEqual(
      Exit.succeed(["upgrade", "--check", "--to=v0.16.0"])
    )
    expect(Exit.isFailure(argvOf("upgrade", { to: "--force" }))).toBe(true)
  })
})

describe("mcp server", () => {
  it.effect("answers initialize with the version asked for, or its newest", () =>
    Effect.gen(function* () {
      const messages = yield* serve(
        [
          request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} }),
          { jsonrpc: "2.0", method: "notifications/initialized" },
          request(2, "initialize", { protocolVersion: "1999-01-01" }),
          request(3, "ping")
        ],
        echo
      )
      expect(byId(messages, 1)).toMatchObject({
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "ot-gateway", version: "1.2.3" }
        }
      })
      expect(byId(messages, 2)).toMatchObject({ result: { protocolVersion: PROTOCOL_VERSIONS[0] } })
      expect(byId(messages, 3)).toEqual({ jsonrpc: "2.0", id: 3, result: {} })
      // The notification has no answer.
      expect(messages).toHaveLength(3)
    })
  )

  it.effect("lists the tools with their schemas and annotations", () =>
    Effect.gen(function* () {
      const messages = yield* serve([request(1, "tools/list")], echo)
      const listed = byId(messages, 1)
      expect(listed).toMatchObject({ result: { tools: expect.any(Array) } })
      const tools = Predicate.isObject(listed) && "result" in listed ? listed.result : undefined
      expect(tools).toMatchObject({
        tools: mcpTools.map((tool) => ({
          name: tool.name,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations
        }))
      })
    })
  )

  it.effect("runs a tool as its command with --json, the JSON as structured content", () =>
    Effect.gen(function* () {
      const messages = yield* serve(
        [request(1, "tools/call", { name: "read", arguments: { points: "room", timeout: 5 } })],
        echo
      )
      expect(byId(messages, 1)).toMatchObject({
        result: {
          isError: false,
          structuredContent: { ok: true, argv: ["read", "room", "--timeout=5", "--json"] }
        }
      })
    })
  )

  it.effect("answers wrong arguments as a tool error, and an unknown tool or method as a protocol error", () =>
    Effect.gen(function* () {
      const messages = yield* serve(
        [
          request(1, "tools/call", { name: "check", arguments: { confg: "x" } }),
          request(2, "tools/call", { name: "nope" }),
          request(3, "resources/list"),
          "not json",
          { jsonrpc: "1.0", id: 4, method: "ping" }
        ],
        echo
      )
      expect(byId(messages, 1)).toMatchObject({ result: { isError: true, structuredContent: { code: "usage" } } })
      expect(byId(messages, 2)).toMatchObject({ error: { code: -32_602 } })
      expect(byId(messages, 3)).toMatchObject({ error: { code: -32_601 } })
      expect(messages).toContainEqual({ jsonrpc: "2.0", id: null, error: { code: -32_700, message: "not JSON" } })
      expect(byId(messages, 4)).toMatchObject({ error: { code: -32_600 } })
    })
  )

  it.effect("stops a call the client cancels, and answers nothing for it", () =>
    Effect.gen(function* () {
      const messages = yield* serve(
        [
          request(1, "tools/call", { name: "status", arguments: {} }),
          { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
          request(2, "ping")
        ],
        () => Effect.never
      )
      expect(messages).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }])
    })
  )

  it.effect("answers a call that failed as isError, with what the command printed", () =>
    Effect.gen(function* () {
      const messages = yield* serve([request(1, "tools/call", { name: "status", arguments: {} })], () =>
        Console.log("progress, not the result").pipe(
          Effect.andThen(printJson({ ok: false, code: "unreachable" })),
          Effect.andThen(Effect.fail("no"))
        )
      )
      expect(byId(messages, 1)).toMatchObject({
        result: { isError: true, structuredContent: { ok: false, code: "unreachable" } }
      })
    })
  )
})

describe("mcp server limits", () => {
  it.effect("cuts lines across chunks and drops one that is too long without keeping it", () =>
    Effect.gen(function* () {
      const lines = yield* Stream.make("ab", "c\r\nde", "fghij", "k\nxy\n", "z").pipe(
        boundedLines(4),
        Stream.runCollect
      )
      expect(lines.map((line) => (typeof line === "string" ? line : "TOO LONG"))).toEqual([
        "abc",
        "TOO LONG",
        "xy",
        "z"
      ])
    })
  )

  it.effect("refuses a second call under an id still running, and runs changing tools one at a time", () =>
    Effect.gen(function* () {
      let running = 0
      let most = 0
      const counting: RunCommand<never> = (argv) =>
        Effect.gen(function* () {
          running += 1
          most = Math.max(most, running)
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          running -= 1
          yield* printJson({ ok: true, argv })
        })
      const messages = yield* serve(
        [
          request(1, "tools/call", { name: "import", arguments: { pointsList: "a.csv", dryRun: false } }),
          request(2, "tools/call", { name: "import", arguments: { pointsList: "b.csv", dryRun: false } }),
          request(2, "tools/call", { name: "import", arguments: { pointsList: "c.csv", dryRun: false } })
        ],
        counting
      )
      expect(most).toBe(1)
      expect(byId(messages, 1)).toMatchObject({ result: { isError: false } })
      expect(messages.filter((message) => Predicate.isObject(message) && "error" in message)).toHaveLength(1)
    })
  )
})

const run: RunCommand<NodeServices.NodeServices> = (argv) => runCli(argv)
const cli = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  effect.pipe(Effect.provide(NodeServices.layer))

describe("mcp tool calls through the CLI", () => {
  it.effect("contract: the command's JSON, and nothing but it", () =>
    cli(
      Effect.gen(function* () {
        const result = yield* runTool(run, ["contract", "health"], silent)
        expect(result.isError).toBe(false)
        expect(result.structuredContent).toMatchObject({ $id: expect.stringContaining("health.schema.json") })
      })
    )
  )

  it.effect("check: a config that is not there is an error with its code", () =>
    cli(
      Effect.gen(function* () {
        const result = yield* runTool(run, ["check", "no-such-config.json"], silent)
        expect(result.isError).toBe(true)
        expect(result.structuredContent).toMatchObject({ ok: false, code: "no-config" })
      })
    )
  )

  it.effect("a usage mistake the CLI finds is a JSON failure too", () =>
    cli(
      Effect.gen(function* () {
        const result = yield* runTool(run, ["status", "--no-such-flag"], silent)
        expect(result.isError).toBe(true)
        expect(result.structuredContent).toMatchObject({ ok: false, code: "usage" })
      })
    )
  )
})
