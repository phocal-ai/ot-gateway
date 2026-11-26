/**
 * `up`, `down`, `restart` and `upgrade` against a scripted `docker` and a scripted status page: what they run, what
 * they write into compose.yaml, and how they end when values do not flow.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import type { DeviceStatus } from "@ot-gateway/api"
import { Duration, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach } from "vitest"
import {
  composeImage,
  composeTag,
  DeployFailed,
  Docker,
  dockerFailure,
  type DockerResult,
  down,
  type FetchSnapshot,
  type GatewaySnapshot,
  observe,
  up,
  upgrade,
  waitForValues,
  withComposeTag
} from "../src/Deploy.ts"
import { composeTemplatePath } from "../src/Folder.ts"
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
      points: [
        { id: "power", name: "Power", waveform: "sine", min: 0, max: 10, periodSeconds: 60 },
        { id: "temp", name: "Temp", waveform: "sine", min: 18, max: 22, periodSeconds: 60 }
      ]
    }
  ]
}

const composeText = readFileSync(composeTemplatePath, "utf8")
const pinned = composeTag(composeText) ?? "missing"

const directories: Array<string> = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A folder with ot-gateway.json, and compose.yaml at `tag` unless `compose` is false. */
const folder = (options: { readonly compose?: false | string; readonly name?: string } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "ot-gateway-deploy-"))
  directories.push(directory)
  writeFileSync(join(directory, options.name ?? "ot-gateway.json"), JSON.stringify(config))
  if (options.compose !== false) {
    writeFileSync(join(directory, "compose.yaml"), withComposeTag(composeText, options.compose ?? pinned))
  }
  return directory
}

const ok = (stdout = ""): DockerResult => ({ exitCode: 0, stdout, stderr: "" })
const failed = (stderr: string): DockerResult => ({ exitCode: 1, stdout: "", stderr })

/** A `docker` that records its calls and answers with `respond`. */
const scriptedDocker = (respond: (args: ReadonlyArray<string>) => DockerResult = () => ok()) => {
  const calls: Array<string> = []
  const layer = Layer.succeed(
    Docker,
    Docker.of({
      run: (args) =>
        Effect.sync(() => {
          calls.push(args.join(" "))
          return respond(args)
        })
    })
  )
  return { calls, layer }
}

const device = (overrides: Partial<DeviceStatus> = {}): DeviceStatus => ({
  id: "room",
  protocol: "simulator",
  status: "ok",
  pollIntervalMs: 1000,
  lastSuccess: 1_000,
  pointCount: 2,
  points: [
    { id: "power", name: "Power", writable: false, value: 3 },
    { id: "temp", name: "Temp", writable: false, value: 20 }
  ],
  ...overrides
})

const snapshot = (overrides: Partial<GatewaySnapshot> = {}): GatewaySnapshot => ({
  site: "s",
  building: "b",
  id: "main",
  version: "v0.15.0",
  devices: [device()],
  now: 1_500,
  ...overrides
})

/** A status page that answers with each of `answers` in turn, the last one from then on. */
const scriptedStatus = (answers: ReadonlyArray<GatewaySnapshot | "down">): FetchSnapshot => {
  let index = 0
  return (url) =>
    Effect.suspend(() => {
      const answer = answers[Math.min(index, answers.length - 1)] ?? "down"
      index += 1
      return answer === "down"
        ? Effect.fail(
            new GatewayUnreachable({
              url,
              message: `no gateway status at ${url}: connection refused`,
              code: "gateway-unreachable",
              hint: "is it running?"
            })
          )
        : Effect.succeed(answer)
    })
}

/**
 * Moves the test clock a second at a time, letting real file I/O in between happen, until `fiber` is done: the
 * upgrade writes compose.yaml between its waits.
 */
const driveClock = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let second = 0; second < 600 && fiber.pollUnsafe() === undefined; second += 1) {
      yield* TestClock.adjust("1 second")
      yield* Effect.promise(() => new Promise((done) => setTimeout(done, 1)))
    }
    return yield* Fiber.join(fiber)
  })

const expected = { path: "ot-gateway.json", site: "s", building: "b", id: "main" }
const context = { cli: "ot-gateway", platform: "linux", timeout: "30 seconds" } as const

describe("compose.yaml's release", () => {
  it("is read and written in the image line, not the comment that explains it", () => {
    expect(composeTag(composeText)).toMatch(/^v\d+\.\d+\.\d+/)
    expect(composeImage(composeText)).toBe("ghcr.io/phocal-ai/ot-gateway")
    const moved = withComposeTag(composeText, "v9.9.9")
    expect(composeTag(moved)).toBe("v9.9.9")
    expect(moved.replace("v9.9.9", pinned)).toBe(composeText)
  })
})

describe("observe", () => {
  it("is done when every point has a value", () => {
    expect(observe(snapshot(), expected, {})).toMatchObject({ _tag: "Flowing", points: 2 })
  })

  it("names another gateway on the port, and an older release still answering", () => {
    expect(observe(snapshot({ id: "other" }), expected, {})).toEqual({ _tag: "Other", found: "s/b gateway other" })
    expect(observe(snapshot(), expected, { version: "v0.16.0" })).toEqual({ _tag: "OldRelease", version: "v0.15.0" })
  })

  it("waits only for the points asked for", () => {
    const partial = snapshot({
      devices: [
        device({
          points: [
            { id: "power", name: "Power", writable: false, value: 1 },
            { id: "temp", name: "Temp", writable: false }
          ]
        })
      ]
    })
    expect(observe(partial, expected, {})).toMatchObject({ _tag: "Partial", withValue: 1, missing: ["room/temp"] })
    expect(observe(partial, expected, { required: new Set(["room/power"]) })).toMatchObject({ _tag: "Flowing" })
  })
})

const waitOptions = (fetchSnapshot: FetchSnapshot) => ({
  url: "http://127.0.0.1:8099",
  expected,
  timeout: Duration.seconds(30),
  fetchSnapshot,
  cli: "ot-gateway",
  logs: "docker compose logs --tail 50 gateway"
})

/** The code dockerFailure gives a failed command that said `stderr`. */
const failureCode = (stderr: string) => dockerFailure(failed(stderr), "compose-failed", "up failed", "docker ps").code

describe("waitForValues", () => {
  it.effect("asks again until values flow", () =>
    Effect.gen(function* () {
      const fiber = yield* waitForValues(waitOptions(scriptedStatus(["down", "down", snapshot()]))).pipe(
        Effect.forkChild
      )
      yield* TestClock.adjust("5 seconds")
      const values = yield* Fiber.join(fiber)
      expect(values).toEqual({ points: 2, ms: 2000, version: "v0.15.0" })
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("ends with the failing device, what to check and status as the next command", () =>
    Effect.gen(function* () {
      const failing = snapshot({
        devices: [
          device({
            id: "meter",
            protocol: "modbus-tcp",
            status: "failing",
            reason: "connection",
            lastError: "could not connect: connection refused by 10.0.0.5:502",
            points: [{ id: "kw", name: "kW", writable: false }]
          })
        ]
      })
      const fiber = yield* waitForValues(waitOptions(scriptedStatus([failing]))).pipe(Effect.flip, Effect.forkChild)
      yield* TestClock.adjust("31 seconds")
      const error = yield* Fiber.join(fiber)
      expect(error).toBeInstanceOf(DeployFailed)
      expect(error).toMatchObject({ code: "device-failing" })
      expect(error.message).toContain("meter: could not connect: connection refused by 10.0.0.5:502")
      expect(error.hint).toBeDefined()
      expect(error.next).toBe("ot-gateway status")
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("says the gateway never answered, with its log as the next command", () =>
    Effect.gen(function* () {
      const fiber = yield* waitForValues(waitOptions(scriptedStatus(["down"]))).pipe(Effect.flip, Effect.forkChild)
      yield* TestClock.adjust("31 seconds")
      const error = yield* Fiber.join(fiber)
      expect(error).toMatchObject({ code: "gateway-not-answering" })
      expect(error.next).toBe("docker compose logs --tail 50 gateway")
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

describe("dockerFailure", () => {
  it("tells Docker that refuses this user, Docker not running and Compose missing apart", () => {
    expect(
      failureCode(
        "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"
      )
    ).toBe("docker-permission")
    expect(
      failureCode("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")
    ).toBe("docker-not-running")
    expect(failureCode("docker: 'compose' is not a docker command.")).toBe("compose-missing")
    expect(failureCode("Error response from daemon: port is already allocated")).toBe("compose-failed")
  })
})

describe("up", () => {
  it.effect("checks the config, writes compose.yaml, starts it and waits for values", () =>
    Effect.gen(function* () {
      const directory = folder({ compose: false })
      const docker = scriptedDocker()
      const report = yield* up(directory, {
        ...context,
        cwd: directory,
        recreate: false,
        fetchSnapshot: scriptedStatus([snapshot()])
      }).pipe(Effect.provide(docker.layer))
      expect(readFileSync(join(directory, "compose.yaml"), "utf8")).toBe(composeText)
      expect(docker.calls).toEqual([`compose -f ${directory}/compose.yaml --project-directory ${directory} up -d`])
      expect(report).toMatchObject({
        ok: true,
        action: "up",
        composeWritten: true,
        image: `ghcr.io/phocal-ai/ot-gateway:${pinned}`,
        gateway: "s/b gateway main",
        url: "http://127.0.0.1:8099",
        values: { points: 2 },
        warnings: [],
        next: "ot-gateway status"
      })
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("restart recreates the container", () =>
    Effect.gen(function* () {
      const directory = folder()
      const docker = scriptedDocker()
      yield* up(directory, { ...context, cwd: directory, recreate: true, wait: false }).pipe(
        Effect.provide(docker.layer)
      )
      expect(docker.calls[0]).toMatch(/ up -d --force-recreate$/)
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("refuses on Docker Desktop unless forced, and a config compose.yaml does not run", () =>
    Effect.gen(function* () {
      const directory = folder()
      const docker = scriptedDocker()
      const desktop = yield* up(directory, { ...context, cwd: directory, recreate: false, platform: "darwin" }).pipe(
        Effect.provide(docker.layer),
        Effect.flip
      )
      expect(desktop).toMatchObject({ code: "docker-desktop", next: `ot-gateway run ${directory}/ot-gateway.json` })
      const named = folder({ name: "site.json" })
      const misnamed = yield* up(join(named, "site.json"), { ...context, cwd: named, recreate: false }).pipe(
        Effect.provide(docker.layer),
        Effect.flip
      )
      expect(misnamed).toMatchObject({ code: "compose-config-name" })
      expect(docker.calls).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("says why Compose failed", () =>
    Effect.gen(function* () {
      const directory = folder()
      const docker = scriptedDocker(() => failed("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"))
      const error = yield* up(directory, { ...context, cwd: directory, recreate: false }).pipe(
        Effect.provide(docker.layer),
        Effect.flip
      )
      expect(error).toMatchObject({ code: "docker-not-running", next: "sudo systemctl enable --now docker" })
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

describe("down", () => {
  it.effect("stops the folder's gateway, and says when the folder runs none", () =>
    Effect.gen(function* () {
      const directory = folder()
      const docker = scriptedDocker()
      const report = yield* down(directory, { cli: "ot-gateway", cwd: directory }).pipe(Effect.provide(docker.layer))
      expect(report).toEqual({
        ok: true,
        action: "down",
        compose: join(directory, "compose.yaml"),
        next: "ot-gateway up"
      })
      expect(docker.calls).toEqual([`compose -f ${directory}/compose.yaml --project-directory ${directory} down`])
      const empty = folder({ compose: false })
      const error = yield* down(empty, { cli: "ot-gateway", cwd: empty }).pipe(
        Effect.provide(docker.layer),
        Effect.flip
      )
      expect(error).toMatchObject({ code: "no-compose" })
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

describe("upgrade", () => {
  const latest = Effect.succeed({ tag: "v0.16.0", url: "https://example.test/v0.16.0" })
  const upgradeOptions = (directory: string) => ({
    ...context,
    cwd: directory,
    check: false,
    latest,
    envTag: undefined
  })

  it.effect("--check compares and changes nothing", () =>
    Effect.gen(function* () {
      const directory = folder({ compose: "v0.15.0" })
      const docker = scriptedDocker()
      const report = yield* upgrade(directory, { ...upgradeOptions(directory), check: true }).pipe(
        Effect.provide(docker.layer)
      )
      expect(report).toMatchObject({ action: "upgrade-check", current: "v0.15.0", latest: "v0.16.0", available: true })
      expect(docker.calls).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("pulls, checks the config with the new release, switches the tag and waits for its values", () =>
    Effect.gen(function* () {
      const directory = folder({ compose: "v0.15.0" })
      const docker = scriptedDocker()
      const report = yield* upgrade(directory, {
        ...upgradeOptions(directory),
        fetchSnapshot: scriptedStatus([snapshot(), snapshot({ version: "v0.16.0" })])
      }).pipe(Effect.provide(docker.layer))
      expect(report).toMatchObject({ action: "upgrade", from: "v0.15.0", to: "v0.16.0", upgraded: true })
      expect(composeTag(readFileSync(join(directory, "compose.yaml"), "utf8"))).toBe("v0.16.0")
      expect(docker.calls).toEqual([
        "pull -q ghcr.io/phocal-ai/ot-gateway:v0.16.0",
        `run --rm --network none -v ${directory}:/etc/ot-gateway:ro ghcr.io/phocal-ai/ot-gateway:v0.16.0 check /etc/ot-gateway/ot-gateway.json`,
        `compose -f ${directory}/compose.yaml --project-directory ${directory} up -d`
      ])
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("changes nothing when the new release does not take the config", () =>
    Effect.gen(function* () {
      const directory = folder({ compose: "v0.15.0" })
      const docker = scriptedDocker((args) =>
        args[0] === "run" ? failed('error: ot-gateway.json: unknown key "mqtt.url"') : ok()
      )
      const error = yield* upgrade(directory, {
        ...upgradeOptions(directory),
        fetchSnapshot: scriptedStatus([snapshot()])
      }).pipe(Effect.provide(docker.layer), Effect.flip)
      expect(error).toMatchObject({ code: "config-rejected" })
      expect(error.message).toContain('unknown key "mqtt.url"')
      expect(composeTag(readFileSync(join(directory, "compose.yaml"), "utf8"))).toBe("v0.15.0")
      expect(docker.calls.some((call) => call.includes(" up -d"))).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("goes back to the old release when the new one brings no values", () =>
    Effect.gen(function* () {
      const directory = folder({ compose: "v0.15.0" })
      const docker = scriptedDocker((args) => (args.includes("logs") ? ok("boom\n") : ok()))
      // The old release has values, before and after; the new one never answers.
      const fetchSnapshot: FetchSnapshot = (url) =>
        Effect.suspend(() =>
          composeTag(readFileSync(join(directory, "compose.yaml"), "utf8")) === "v0.16.0"
            ? scriptedStatus(["down"])(url)
            : Effect.succeed(snapshot())
        )
      const fiber = yield* upgrade(directory, { ...upgradeOptions(directory), fetchSnapshot }).pipe(
        Effect.provide(docker.layer),
        Effect.flip,
        Effect.forkChild
      )
      const error = yield* driveClock(fiber)
      expect(error).toMatchObject({ code: "upgrade-rolled-back" })
      expect(error.message).toContain("v0.16.0 failed, so v0.15.0 runs again")
      expect(error.message).toContain("Its log ended with: boom")
      expect(composeTag(readFileSync(join(directory, "compose.yaml"), "utf8"))).toBe("v0.15.0")
      expect(docker.calls.filter((call) => call.endsWith(" up -d"))).toHaveLength(2)
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("refuses while OT_GATEWAY_TAG would win over compose.yaml", () =>
    Effect.gen(function* () {
      const directory = folder({ compose: "v0.15.0" })
      const error = yield* upgrade(directory, { ...upgradeOptions(directory), envTag: "v0.14.0" }).pipe(
        Effect.provide(scriptedDocker().layer),
        Effect.flip
      )
      expect(error).toMatchObject({ code: "tag-overridden" })
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("does nothing when the folder runs the newest release", () =>
    Effect.gen(function* () {
      const directory = folder({ compose: "v0.16.0" })
      const docker = scriptedDocker()
      const report = yield* upgrade(directory, upgradeOptions(directory)).pipe(Effect.provide(docker.layer))
      expect(report).toMatchObject({ upgraded: false, from: "v0.16.0", to: "v0.16.0" })
      expect(docker.calls).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
