/**
 * `ot-gateway mcp`: the CLI's commands as tools for agents that do not run a shell, as a Model Context Protocol
 * server over stdio (JSON-RPC 2.0, one message per line; MCP 2025-11-25, older versions accepted).
 *
 * A tool call runs the command it names in this process with `--json`, as `ot-gateway <command> --json` would:
 * the tool's result is the JSON the command prints, `isError` when it exits with 1 or 2, and its guards are the
 * command's own. What a command says besides its result (progress, warnings, logs) goes to stderr, which MCP
 * clients keep as the server's log; stdout carries the protocol and nothing else.
 *
 * Calls run side by side, at most `MAX_CALLS` at a time, each within `CALL_DEADLINE`; a call the client cancels
 * is interrupted, its broker connection and sockets closed by their scopes. The server ends when stdin closes,
 * after the calls in flight have answered.
 *
 * The tools are in McpTools.ts.
 */
import {
  Cause,
  Console,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Option,
  Predicate,
  Queue,
  Schema,
  Semaphore,
  Stream
} from "effect"
import { CliError } from "effect/cli"
import { Stdio } from "effect/Stdio"
import { format } from "node:util"
import { type McpTool, toolNamesUnique } from "./McpTools.ts"
import { failureFields, isUsageError, ResultConsole, usageFailure } from "./Output.ts"

/** The protocol versions this server speaks, newest first; a client asking another gets the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const

/** Tool calls running at once; the rest wait their turn. A Pi has little to spare. */
export const MAX_CALLS = 4

/** The longest a tool call may take, its turn included: the commands' own limits fit well inside it. */
export const CALL_DEADLINE = Duration.minutes(15)

/** The longest message a client may send; a line beyond it is answered as a parse error. */
export const MAX_LINE = 1024 * 1024

/** JSON-RPC 2.0 error codes. */
export const RpcError = {
  parse: -32_700,
  invalidRequest: -32_600,
  methodNotFound: -32_601,
  invalidParams: -32_602
} as const

const RequestId = Schema.Union([Schema.String, Schema.Number])
type RequestId = typeof RequestId.Type

/** A message from the client: a request when it has an id, a notification when not. */
const Message = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(RequestId),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown)
})
type Message = typeof Message.Type

const InitializeParams = Schema.Struct({ protocolVersion: Schema.optionalKey(Schema.String) })
const CallParams = Schema.Struct({ name: Schema.String, arguments: Schema.optionalKey(Schema.Unknown) })
const CancelledParams = Schema.Struct({ requestId: RequestId })

const decodeLine = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown))
const decodeMessage = Schema.decodeUnknownExit(Message)
const decodeInitialize = Schema.decodeUnknownOption(InitializeParams)
const decodeCall = Schema.decodeUnknownOption(CallParams)
const decodeCancelled = Schema.decodeUnknownOption(CancelledParams)

/** A JSON-RPC response, as one line on stdout. */
export type Response =
  | { readonly jsonrpc: "2.0"; readonly id: RequestId | null; readonly result: unknown }
  | {
      readonly jsonrpc: "2.0"
      readonly id: RequestId | null
      readonly error: { readonly code: number; readonly message: string }
    }

const result = (id: RequestId, value: unknown): Response => ({ jsonrpc: "2.0", id, result: value })
const failure = (id: RequestId | null, code: number, message: string): Response => ({
  jsonrpc: "2.0",
  id,
  error: { code, message }
})

/** A tool call's result, as MCP has it. */
export interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
  readonly structuredContent?: Readonly<Record<string, unknown>>
  readonly isError: boolean
}

/** Runs the CLI for some arguments: `runCli` in the gateway, a stand-in in tests. */
export type RunCommand<R> = (argv: ReadonlyArray<string>) => Effect.Effect<unknown, unknown, R>

const nothing = () => {}

/** A `Console` that hands each line it is asked to print to `sink`, whatever the method. */
export const lineConsole = (sink: (line: string) => void): Console.Console => {
  const print = (...args: ReadonlyArray<unknown>) => sink(format(...args))
  return {
    assert: (condition, ...args) => {
      if (!condition) print("Assertion failed:", ...args)
    },
    clear: nothing,
    count: nothing,
    countReset: nothing,
    debug: print,
    dir: (item) => print(item),
    dirxml: print,
    error: print,
    group: print,
    groupCollapsed: print,
    groupEnd: nothing,
    info: print,
    log: print,
    table: (data) => print(data),
    time: nothing,
    timeEnd: nothing,
    timeLog: nothing,
    trace: print,
    warn: print
  }
}

/** The command's JSON as `structuredContent` when it printed one object; NDJSON and arrays stay text. */
const structured = (text: string): Readonly<Record<string, unknown>> | undefined => {
  const decoded = decodeLine(text)
  return Exit.isSuccess(decoded) && Predicate.isObject(decoded.value) && !Array.isArray(decoded.value)
    ? decoded.value
    : undefined
}

/** A tool result from a text and whether it is an error. */
export const toolResult = (text: string, isError: boolean): ToolResult => {
  const object = structured(text)
  return { content: [{ type: "text", text }], ...(object === undefined ? {} : { structuredContent: object }), isError }
}

/**
 * Waits for a call's turn before its command runs (a permit of `MAX_CALLS`, and one change at a time for a tool
 * that changes something). The wait is inside the call's deadline.
 */
export type Turn = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

const noWait: Turn = (effect) => effect

/** What a call that ran out of time ends with: not an error of the command's own. */
const deadlineReached = Symbol("deadlineReached")

/** The JSON for a call stopped at the deadline. */
const deadlineFailure = (argv: ReadonlyArray<string>) => ({
  ok: false,
  code: "deadline",
  error: `${argv.join(" ")} took longer than ${Duration.format(CALL_DEADLINE)}, its turn included, and was stopped`
})

/**
 * Runs one command with `--json` and returns what it printed as a tool result. Its result lines are collected;
 * everything else it prints goes to `log` (stderr). A command that printed nothing on stdout (a usage mistake, a
 * defect) gets a JSON failure in the same shape as the CLI's, `{ok: false, code, error, hint}`; one stopped at the
 * deadline gets it after what it printed.
 */
export const runTool = <R>(
  run: RunCommand<R>,
  argv: ReadonlyArray<string>,
  log: Console.Console,
  turn: Turn = noWait
): Effect.Effect<ToolResult, never, R> =>
  Effect.suspend(() => {
    const out: Array<string> = []
    return turn(
      run([...argv, "--json"]).pipe(
        Effect.provideService(
          ResultConsole,
          lineConsole((line) => out.push(line))
        ),
        Effect.provideService(Console.Console, log)
      )
    ).pipe(
      Effect.timeoutOrElse({ duration: CALL_DEADLINE, orElse: () => Effect.succeed(deadlineReached) }),
      Effect.exit,
      Effect.map((exit) => {
        if (Exit.isSuccess(exit) && exit.value === deadlineReached) {
          return toolResult([...out, JSON.stringify(deadlineFailure(argv))].join("\n"), true)
        }
        if (out.length > 0) return toolResult(out.join("\n"), Exit.isFailure(exit))
        if (Exit.isSuccess(exit)) return toolResult(JSON.stringify({ ok: true }), false)
        return toolResult(JSON.stringify(silentFailure(exit.cause)), true)
      })
    )
  })

/** The JSON for a command that failed without printing it: a usage mistake, or a bug. */
const silentFailure = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause)
  if (Option.isSome(error)) {
    if (CliError.isCliError(error.value) && isUsageError(error.value)) return usageFailure(error.value)
    if (Predicate.hasProperty(error.value, "message") && typeof error.value.message === "string") {
      return { ok: false, ...failureFields(error.value), error: error.value.message }
    }
  }
  return {
    ok: false,
    code: "bug",
    error: `an unexpected failure, a bug in ot-gateway; please report it with this:\n${Cause.pretty(cause)}`
  }
}

/** What the server knows about itself and the tools it offers. */
export interface McpServer<R> {
  readonly tools: ReadonlyArray<McpTool>
  readonly version: string
  readonly run: RunCommand<R>
  /** Where commands' progress, warnings and logs go: stderr. */
  readonly log: Console.Console
}

const instructions = [
  "OT Gateway reads Modbus TCP and BACnet/IP devices and publishes their values to MQTT, and takes guarded writes back.",
  "Each tool is an ot-gateway command with --json; its result is that command's JSON, and isError when the command failed (with code and hint, what to do next).",
  "Start with doctor when something is wrong, status for a running gateway, read to read points once without one.",
  "Paths are relative to the folder the server was started in; config defaults to ./ot-gateway.json.",
  "write changes a device: only writable points, within their limits, through the running gateway.",
  "points_allow_commands makes one point writable: only when the user asked for that point by name, with the limits they gave, never guessed.",
  "config_set, config_remove and config_undo change the config file (a dry run unless told otherwise), checked before it is written; restart makes the running gateway read it.",
  "init writes a new gateway's folder (a dry run unless told otherwise); import takes a points list as a file, text or rows.",
  "No tool takes a secret: secret_list says which are missing, and the user runs ot-gateway secret set <name> and types it there. Never ask for a password.",
  "up, restart, down and upgrade run the gateway under Docker Compose on this machine, and wait until values flow."
].join(" ")

/** The tool as `tools/list` has it. */
const listed = (tool: McpTool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: { title: tool.title, ...tool.annotations }
})

/**
 * The answer to a request other than `tools/call`, or `undefined` for a notification. `tools/call` runs a command
 * and is answered by `callTool`.
 */
export const answer = <R>(server: McpServer<R>, message: Message & { readonly id: RequestId }): Response => {
  switch (message.method) {
    case "initialize": {
      const asked = Option.flatMap(decodeInitialize(message.params ?? {}), (params) =>
        Option.fromNullishOr(params.protocolVersion)
      )
      const protocolVersion = Option.match(asked, {
        onNone: () => PROTOCOL_VERSIONS[0],
        onSome: (version) => PROTOCOL_VERSIONS.find((known) => known === version) ?? PROTOCOL_VERSIONS[0]
      })
      return result(message.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ot-gateway", title: "OT Gateway", version: server.version },
        instructions
      })
    }
    case "ping":
      return result(message.id, {})
    case "tools/list":
      return result(message.id, { tools: server.tools.map(listed) })
    default:
      return failure(message.id, RpcError.methodNotFound, `no method ${message.method}`)
  }
}

/** The answer to `tools/call`: the command's result, or an error for a call that names no tool. */
export const callTool = <R>(
  server: McpServer<R>,
  id: RequestId,
  params: unknown,
  turnFor: (tool: McpTool) => Turn = () => noWait
): Effect.Effect<Response, never, R> =>
  Effect.gen(function* () {
    const call = decodeCall(params ?? {})
    if (Option.isNone(call)) return failure(id, RpcError.invalidParams, "tools/call takes {name, arguments}")
    const tool = server.tools.find((each) => each.name === call.value.name)
    if (tool === undefined) {
      return failure(
        id,
        RpcError.invalidParams,
        `no tool ${call.value.name}; the tools: ${server.tools.map((each) => each.name).join(", ")}`
      )
    }
    // Wrong arguments are the tool's answer, not a protocol error, so the agent reads them and corrects the call.
    const argv = yield* tool.argv(call.value.arguments ?? {}).pipe(Effect.result)
    if (argv._tag === "Failure") {
      return result(
        id,
        toolResult(JSON.stringify({ ok: false, code: "usage", error: `${tool.name}: ${argv.failure.message}` }), true)
      )
    }
    const outcome = yield* runTool(server.run, argv.success, server.log, turnFor(tool)).pipe(
      Effect.tap((done) => Effect.annotateCurrentSpan({ "mcp.isError": done.isError })),
      Effect.withSpan("mcp.tools/call", { attributes: { "mcp.tool": tool.name } })
    )
    return result(id, outcome)
  })

/** A line longer than `MAX_LINE`, dropped without being kept whole. */
const tooLong = Symbol("tooLong")

/**
 * Text cut into lines (`\n` or `\r\n`), each at most `max` characters: a longer one is dropped as it arrives and
 * stands as `tooLong`, so a client that never sends a newline cannot fill memory.
 */
export const boundedLines =
  (max: number) =>
  <E, R>(text: Stream.Stream<string, E, R>): Stream.Stream<string | typeof tooLong, E, R> =>
    text.pipe(
      Stream.mapAccum(
        (): { readonly buffer: string; readonly overflow: boolean } => ({ buffer: "", overflow: false }),
        (state, chunk) => {
          const pieces = chunk.split("\n")
          const lines: Array<string | typeof tooLong> = []
          let { buffer, overflow } = state
          for (const [index, piece] of pieces.entries()) {
            if (index === pieces.length - 1) {
              buffer = overflow ? "" : buffer + piece
              if (buffer.length > max) {
                buffer = ""
                overflow = true
              }
              continue
            }
            const line = (buffer + piece).replace(/\r$/, "")
            lines.push(overflow || line.length > max ? tooLong : line)
            buffer = ""
            overflow = false
          }
          return [{ buffer, overflow }, lines] as const
        },
        {
          onHalt: ({ buffer, overflow }) => (overflow ? [tooLong] : buffer === "" ? [] : [buffer.replace(/\r$/, "")])
        }
      )
    )

/**
 * Serves `server` on stdin and stdout until stdin closes, then waits for the calls in flight. Each response is one
 * line on stdout; everything else goes to `server.log`.
 */
export const serveMcp = <R>(server: McpServer<R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (!toolNamesUnique(server.tools)) return yield* Effect.die(new Error("two MCP tools share a name"))
      const stdio = yield* Stdio
      const outbox = yield* Queue.unbounded<string, Cause.Done>()
      const send = (response: Response) => Queue.offer(outbox, `${JSON.stringify(response)}\n`)
      // A client gone (stdout closed) leaves nobody to answer: the server ends with stdin, which goes with it.
      const writer = yield* Stream.fromQueue(outbox).pipe(
        Stream.run(stdio.stdout({ endOnDone: false })),
        Effect.catchTag("PlatformError", (error) =>
          Effect.sync(() => server.log.error(`ot-gateway mcp: stdout failed: ${error.message}`))
        ),
        Effect.forkScoped
      )
      const calls = yield* FiberMap.make<RequestId, void, never>()
      const turns = yield* Semaphore.make(MAX_CALLS)
      // Tools that change something (import into the config, write) run one at a time: two imports at once would
      // both write the config's temporary file and one could undo the other.
      const changes = yield* Semaphore.make(1)
      const turnFor =
        (tool: McpTool): Turn =>
        (effect) =>
          tool.annotations.readOnlyHint ? turns.withPermit(effect) : turns.withPermit(changes.withPermit(effect))

      const receive = (line: string | typeof tooLong): Effect.Effect<void, never, R> => {
        if (line === tooLong) {
          return send(failure(null, RpcError.parse, `a message longer than ${MAX_LINE} characters`))
        }
        if (line.trim() === "") return Effect.void
        const json = decodeLine(line)
        if (Exit.isFailure(json)) return send(failure(null, RpcError.parse, "not JSON"))
        const decoded = decodeMessage(json.value)
        if (Exit.isFailure(decoded)) {
          // A response to a request of ours (there are none) or something else: answer only what has an id.
          const id = Predicate.hasProperty(json.value, "id") ? json.value.id : undefined
          return typeof id === "string" || typeof id === "number"
            ? send(failure(id, RpcError.invalidRequest, "not a JSON-RPC 2.0 request"))
            : Effect.void
        }
        const message = decoded.value
        if (message.id === undefined) {
          if (message.method !== "notifications/cancelled") return Effect.void
          return Option.match(decodeCancelled(message.params ?? {}), {
            onNone: () => Effect.void,
            onSome: ({ requestId }) => FiberMap.remove(calls, requestId)
          })
        }
        const id = message.id
        if (message.method !== "tools/call") return send(answer(server, { ...message, id }))
        // Another call in flight under the same id would be interrupted and never answered: refuse this one.
        return Effect.flatMap(FiberMap.has(calls, id), (inFlight) =>
          inFlight
            ? send(failure(id, RpcError.invalidRequest, `a call with id ${id} is still running`))
            : // Interrupted when cancelled: MCP has no response for a cancelled request.
              FiberMap.run(calls, id, callTool(server, id, message.params, turnFor).pipe(Effect.flatMap(send))).pipe(
                Effect.asVoid
              )
        )
      }

      yield* stdio.stdin.pipe(
        Stream.decodeText(),
        boundedLines(MAX_LINE),
        Stream.runForEach(receive),
        Effect.catchTag("PlatformError", (error) =>
          Effect.sync(() => server.log.error(`ot-gateway mcp: stdin failed: ${error.message}`))
        )
      )
      yield* FiberMap.awaitEmpty(calls)
      yield* Queue.end(outbox)
      yield* Fiber.join(writer)
    })
  )
