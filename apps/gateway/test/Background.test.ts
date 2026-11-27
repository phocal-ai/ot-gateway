/**
 * `start` and `stop` against scripted processes and a scripted status page: the pid file, the wait for values,
 * a gateway that exits or is someone else, and a pid that a reboot gave to another program.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import type { DeviceStatus } from "@ot-gateway/api"
import { Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach } from "vitest"
import {
  type BackgroundOptions,
  isGatewayOf,
  PID_FILE,
  pidFileOf,
  Processes,
  startBackground,
  stopBackground
} from "../src/Background.ts"
import { DeployFailed, type FetchSnapshot, type GatewaySnapshot } from "../src/Deploy.ts"
import { GatewayUnreachable } from "../src/StatusReport.ts"

const config = {
  site: "s",
  building: "b",
  id: "main",
  mqtt: { url: "mqtt://127.0.0.1:1883" },
  status: { port: 8099 },
  devices: [
    {
      id: "room",
      protocol: "simulator",
      points: [{ id: "temp", name: "Temp", waveform: "sine", min: 18, max: 22, periodSeconds: 60 }]
    }
  ]
}

const directories: Array<string> = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const folder = () => {
  const directory = mkdtempSync(join(tmpdir(), "ot-gateway-background-"))
  directories.push(directory)
  writeFileSync(join(directory, "ot-gateway.json"), JSON.stringify(config))
  return directory
}

const device: DeviceStatus = {
  id: "room",
  protocol: "simulator",
  status: "ok",
  pollIntervalMs: 1000,
  lastSuccess: 1_000,
  pointCount: 1,
  points: [{ id: "temp", name: "Temp", writable: false, value: 20 }]
}

const snapshot = (overrides: Partial<GatewaySnapshot> = {}): GatewaySnapshot => ({
  site: "s",
  building: "b",
  id: "main",
  version: "v0.18.0",
  devices: [device],
  now: 1_500,
  ...overrides
})

const status =
  (answer: GatewaySnapshot | "down"): FetchSnapshot =>
  (url) =>
    answer === "down"
      ? Effect.fail(
          new GatewayUnreachable({ url, message: "connection refused", code: "gateway-unreachable", hint: "running?" })
        )
      : Effect.succeed(answer)

/** Processes that record what happens: `running` holds the live pids and their command lines. */
const scripted = (
  options: { readonly exitsWith?: number; readonly running?: Map<number, string>; readonly ps?: false } = {}
) =>
  Effect.gen(function* () {
    const running = options.running ?? new Map<number, string>()
    const signals: Array<string> = []
    const exit = yield* Deferred.make<number>()
    if (options.exitsWith !== undefined) yield* Deferred.succeed(exit, options.exitsWith)
    const layer = Layer.succeed(
      Processes,
      Processes.of({
        launch: (configPath) =>
          Effect.sync(() => {
            running.set(4242, `node main.ts run ${configPath} --verbose`)
            if (options.exitsWith !== undefined) running.delete(4242)
            return { pid: 4242, exited: Deferred.await(exit) }
          }),
        alive: (pid) => Effect.sync(() => running.has(pid)),
        commandLine: (pid) =>
          Effect.sync(() => (options.ps === false ? Option.none() : Option.fromUndefinedOr(running.get(pid)))),
        signal: (pid, name) =>
          Effect.sync(() => {
            signals.push(`${name} ${pid}`)
            running.delete(pid)
          })
      })
    )
    return { running, signals, layer }
  })

/** The failure of `effect`, which must be a `DeployFailed`. */
const deployFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.flatMap((error) => (error instanceof DeployFailed ? Effect.succeed(error) : Effect.die(error)))
  )

const options = (fetchSnapshot: FetchSnapshot, platform = "darwin"): BackgroundOptions => ({
  platform,
  cli: "ot-gateway",
  cwd: "/elsewhere",
  timeout: "5 seconds",
  fetchSnapshot
})

describe("start", () => {
  it.effect("starts the gateway, writes its pid file and waits until every point has a value", () =>
    Effect.gen(function* () {
      const directory = folder()
      const processes = yield* scripted()
      const report = yield* startBackground(directory, options(status(snapshot()))).pipe(
        Effect.provide(processes.layer)
      )
      expect(report.pid).toBe(4242)
      expect(report.values?.points).toBe(1)
      expect(report.url).toBe("http://127.0.0.1:8099")
      expect(report.warnings[0]).toContain("until stop, a crash or a reboot")
      const record = JSON.parse(readFileSync(join(directory, PID_FILE), "utf8"))
      expect(record).toMatchObject({ pid: 4242, config: join(directory, "ot-gateway.json") })
      // Started again while it runs: refused, with stop as the next command.
      const again = yield* deployFailure(
        startBackground(directory, options(status(snapshot()))).pipe(Effect.provide(processes.layer))
      )
      expect(again.code).toBe("already-running")
      expect(again.next).toContain("ot-gateway stop")
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("says the gateway exited when it does before values flow, and leaves no pid file", () =>
    Effect.gen(function* () {
      const directory = folder()
      const processes = yield* scripted({ exitsWith: 1 })
      const failure = yield* deployFailure(
        startBackground(directory, options(status("down"))).pipe(Effect.provide(processes.layer))
      )
      expect(failure.code).toBe("gateway-exited")
      expect(failure.next).toContain("ot-gateway run")
      expect(existsSync(join(directory, PID_FILE))).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("stops a gateway whose status port another gateway answers on, and names the port", () =>
    Effect.gen(function* () {
      const directory = folder()
      const processes = yield* scripted()
      const fiber = yield* startBackground(directory, options(status(snapshot({ site: "other" })))).pipe(
        Effect.provide(processes.layer),
        deployFailure,
        Effect.forkChild
      )
      // Real file I/O between the waits: the clock a second at a time, with a moment for it.
      for (let second = 0; second < 30 && fiber.pollUnsafe() === undefined; second += 1) {
        yield* TestClock.adjust("1 second")
        yield* Effect.promise(() => new Promise((done) => setTimeout(done, 1)))
      }
      const failure = yield* Fiber.join(fiber)
      expect(failure.code).toBe("wrong-gateway")
      expect(failure.hint).toContain("8099")
      expect(failure.next).toBe("lsof -nP -iTCP:8099 -sTCP:LISTEN")
      expect(processes.signals).toEqual(["SIGTERM 4242"])
      expect(existsSync(join(directory, PID_FILE))).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("is not offered on Windows", () =>
    Effect.gen(function* () {
      const processes = yield* scripted()
      const exit = yield* Effect.exit(
        startBackground(folder(), options(status(snapshot()), "win32")).pipe(Effect.provide(processes.layer))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(processes.running.size).toBe(0)
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

describe("stop", () => {
  it.effect("stops the gateway the pid file names and removes the file; nothing to do the second time", () =>
    Effect.gen(function* () {
      const directory = folder()
      const processes = yield* scripted()
      yield* startBackground(directory, options(status(snapshot()))).pipe(Effect.provide(processes.layer))
      const stopped = yield* stopBackground(directory, { cli: "ot-gateway", cwd: directory }).pipe(
        Effect.provide(processes.layer)
      )
      expect(stopped).toMatchObject({ stopped: true, pid: 4242, next: "ot-gateway start" })
      expect(processes.signals).toEqual(["SIGTERM 4242"])
      expect(existsSync(join(directory, PID_FILE))).toBe(false)
      const again = yield* stopBackground(directory, { cli: "ot-gateway", cwd: directory }).pipe(
        Effect.provide(processes.layer)
      )
      expect(again.stopped).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("leaves a process alone that has the pid now but is not this gateway", () =>
    Effect.gen(function* () {
      const directory = folder()
      const running = new Map([[4242, "/usr/bin/some-other-program"]])
      const processes = yield* scripted({ running })
      writeFileSync(
        join(directory, PID_FILE),
        JSON.stringify({ pid: 4242, config: join(directory, "ot-gateway.json"), started: 0 })
      )
      const report = yield* stopBackground(directory, { cli: "ot-gateway", cwd: directory }).pipe(
        Effect.provide(processes.layer)
      )
      expect(report.stopped).toBe(false)
      expect(processes.signals).toEqual([])
      expect(running.has(4242)).toBe(true)
      expect(existsSync(join(directory, PID_FILE))).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("keeps one pid file per config: stopping another config of the folder leaves this gateway alone", () =>
    Effect.gen(function* () {
      const directory = folder()
      writeFileSync(join(directory, "other.json"), JSON.stringify({ ...config, id: "other" }))
      const processes = yield* scripted()
      yield* startBackground(directory, options(status(snapshot()))).pipe(Effect.provide(processes.layer))
      const other = yield* stopBackground(join(directory, "other.json"), { cli: "ot-gateway", cwd: directory }).pipe(
        Effect.provide(processes.layer)
      )
      expect(other.stopped).toBe(false)
      expect(processes.signals).toEqual([])
      expect(existsSync(join(directory, PID_FILE))).toBe(true)
      expect(pidFileOf(join(directory, "other.json"))).toBe(join(directory, ".other.json.pid"))
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("signals nothing when it cannot read what the pid runs", () =>
    Effect.gen(function* () {
      const directory = folder()
      const processes = yield* scripted({ running: new Map([[4242, "?"]]), ps: false })
      writeFileSync(
        join(directory, PID_FILE),
        JSON.stringify({ pid: 4242, config: join(directory, "ot-gateway.json"), started: 0 })
      )
      const failure = yield* deployFailure(
        stopBackground(directory, { cli: "ot-gateway", cwd: directory }).pipe(Effect.provide(processes.layer))
      )
      expect(failure.code).toBe("pid-unconfirmed")
      expect(failure.next).toBe("ps -o command= -p 4242")
      expect(processes.signals).toEqual([])
      // And start does not start a second one beside it.
      const start = yield* deployFailure(
        startBackground(directory, options(status(snapshot()))).pipe(Effect.provide(processes.layer))
      )
      expect(start.code).toBe("already-running")
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it("knows the gateway's command line by run and its config", () => {
    expect(isGatewayOf("node /x/main.mjs run /site/ot-gateway.json --verbose", "/site/ot-gateway.json")).toBe(true)
    expect(isGatewayOf("node /x/main.mjs run /other/ot-gateway.json", "/site/ot-gateway.json")).toBe(false)
    expect(isGatewayOf("vim /site/ot-gateway.json", "/site/ot-gateway.json")).toBe(false)
  })
})
