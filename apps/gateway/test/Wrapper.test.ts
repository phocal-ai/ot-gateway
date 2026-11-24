/**
 * packaging/ot-gateway, the CLI wrapper for machines with Docker and no Node, run with `sh` against a fake `docker`
 * (and `sleep`) first on PATH. The fake logs every call and simulates a missing image, a flaky or unreachable
 * registry and a container already running under the wrapper's name.
 */
import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach } from "vitest"

const wrapper = fileURLToPath(new URL("../../../packaging/ot-gateway", import.meta.url))
const image = "ghcr.io/phocal-ai/ot-gateway:v9.9.9"

// FAKE_IMAGE_PRESENT=1: the image is local. FAKE_PULL_FAILURES=n: the first n pulls fail (always when "always"),
// ending their stderr with FAKE_PULL_ERROR.
// FAKE_RUNNING=<name>: a running container of that name.
const fakeDocker = [
  "#!/bin/sh",
  'echo "docker $*" >> "$FAKE_DIR/log"',
  'case "$1" in',
  '  image) [ "${FAKE_IMAGE_PRESENT:-}" = 1 ] ;;',
  "  pull)",
  '    count=$(cat "$FAKE_DIR/pulls" 2>/dev/null || echo 0)',
  "    count=$((count + 1))",
  '    echo "$count" > "$FAKE_DIR/pulls"',
  '    echo "layer progress on stdout"',
  '    echo "layer progress on stderr" >&2',
  '    case "${FAKE_PULL_FAILURES:-0}" in',
  '      always) echo "${FAKE_PULL_ERROR:-net/http: timeout awaiting response headers}" >&2; echo >&2; exit 1 ;;',
  '      *) [ "$count" -gt "${FAKE_PULL_FAILURES:-0}" ] || { echo "${FAKE_PULL_ERROR:-net/http: timeout awaiting response headers}" >&2; echo >&2; exit 1; } ;;',
  "    esac",
  "    ;;",
  "  inspect)",
  "    for last; do :; done",
  '    if [ -n "${FAKE_RUNNING:-}" ] && [ "$last" = "$FAKE_RUNNING" ]; then echo true; else exit 1; fi',
  "    ;;",
  '  run) echo "cli output" ;;',
  "  *) exit 0 ;;",
  "esac",
  ""
].join("\n")
const fakeSleep = ["#!/bin/sh", 'echo "sleep $*" >> "$FAKE_DIR/log"', ""].join("\n")

const directories: Array<string> = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const runWrapper = (args: ReadonlyArray<string>, env: Record<string, string>) => {
  const directory = mkdtempSync(join(tmpdir(), "ot-gateway-wrapper-"))
  directories.push(directory)
  for (const [name, body] of [
    ["docker", fakeDocker],
    ["sleep", fakeSleep]
  ] as const) {
    writeFileSync(join(directory, name), body)
    chmodSync(join(directory, name), 0o755)
  }
  const result = spawnSync("sh", [wrapper, ...args], {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: `${directory}:${process.env["PATH"] ?? ""}`,
      HOME: directory,
      OT_GATEWAY_TAG: "v9.9.9",
      FAKE_DIR: directory,
      ...env
    }
  })
  const log = readFileSync(join(directory, "log"), "utf8").trim().split("\n")
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, log }
}

const runCall = (log: ReadonlyArray<string>) => log.find((line) => line.startsWith("docker run "))

describe("packaging/ot-gateway", () => {
  it("runs a present image without pulling and without a name", () => {
    const result = runWrapper(["--version"], { FAKE_IMAGE_PRESENT: "1" })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("cli output\n")
    expect(result.stderr).toBe("")
    expect(result.log.some((line) => line.startsWith("docker pull"))).toBe(false)
    expect(runCall(result.log)).toMatch(new RegExp(`-w /work ${image} --version$`))
    expect(runCall(result.log)).not.toContain("--name")
  })

  it("passes the SSH session and the user into the container, by name only", () => {
    const result = runWrapper(["init"], {
      FAKE_IMAGE_PRESENT: "1",
      SSH_CONNECTION: "192.168.1.20 53412 192.168.1.50 22",
      USER: "pi"
    })
    expect(result.status).toBe(0)
    expect(runCall(result.log)).toContain(" -e SSH_CONNECTION -e USER ")
    expect(runCall(result.log)).not.toContain("192.168.1.50")
  })

  it("resolves the config's relative paths in the current folder, not in the image's data volume", () => {
    const result = runWrapper(["run"], { FAKE_IMAGE_PRESENT: "1" })
    expect(result.status).toBe(0)
    expect(runCall(result.log)).toContain(" -e OT_GATEWAY_DATA_DIR= -v ")
  })

  it("pulls a missing image quietly, retrying twice with a backoff", () => {
    const result = runWrapper(["--version"], { FAKE_PULL_FAILURES: "2" })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("cli output\n")
    expect(result.log.filter((line) => !line.startsWith("docker run "))).toEqual([
      `docker image inspect ${image}`,
      `docker pull -q ${image}`,
      "sleep 2",
      `docker pull -q ${image}`,
      "sleep 5",
      `docker pull -q ${image}`
    ])
    expect(result.stderr).toBe(
      [
        `ot-gateway: pulling ${image} (about 460 MB)...`,
        "ot-gateway: pull failed, retrying in 2 s",
        "ot-gateway: pull failed, retrying in 5 s",
        ""
      ].join("\n")
    )
  })

  it("gives up after three pulls with one line naming the image", () => {
    const result = runWrapper(["--version"], { FAKE_PULL_FAILURES: "always" })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.log.filter((line) => line.startsWith("docker pull"))).toHaveLength(3)
    expect(runCall(result.log)).toBeUndefined()
    expect(result.stderr.trim().split("\n").at(-1)).toBe(
      `ot-gateway: could not pull ${image} after 3 attempts: net/http: timeout awaiting response headers`
    )
    expect(result.stderr).not.toContain("layer progress")
  })

  it.each([
    ["a wrong tag", "Error response from daemon: manifest unknown: manifest unknown"],
    ["no access to Docker", "permission denied while trying to connect to the Docker daemon socket"],
    [
      "no Docker daemon",
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
    ]
  ])("fails after one pull on %s, showing Docker's line", (_, error) => {
    const result = runWrapper(["--version"], { FAKE_PULL_FAILURES: "always", FAKE_PULL_ERROR: error })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.log.filter((line) => line.startsWith("docker pull"))).toHaveLength(1)
    expect(result.log.some((line) => line.startsWith("sleep"))).toBe(false)
    expect(result.stderr).toBe(
      `ot-gateway: pulling ${image} (about 460 MB)...\not-gateway: could not pull ${image} after 1 attempt: ${error}\n`
    )
  })

  it.each(["dev", "latest"])("checks a present %s image for a newer one, once, before running it", (tag) => {
    const moving = `ghcr.io/phocal-ai/ot-gateway:${tag}`
    const result = runWrapper(["--version"], { FAKE_IMAGE_PRESENT: "1", OT_GATEWAY_TAG: tag })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("cli output\n")
    expect(result.stderr).toBe(`ot-gateway: checking for a newer ${moving}...\n`)
    expect(result.log.filter((line) => !line.startsWith("docker run "))).toEqual([
      `docker image inspect ${moving}`,
      `docker pull -q ${moving}`
    ])
    expect(runCall(result.log)).toMatch(new RegExp(`-w /work ${moving} --version$`))
  })

  it("runs the local dev image when the check for a newer one fails, without retrying", () => {
    const moving = "ghcr.io/phocal-ai/ot-gateway:dev"
    const result = runWrapper(["--version"], {
      FAKE_IMAGE_PRESENT: "1",
      OT_GATEWAY_TAG: "dev",
      FAKE_PULL_FAILURES: "always"
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("cli output\n")
    expect(result.log.filter((line) => line.startsWith("docker pull"))).toHaveLength(1)
    expect(result.log.some((line) => line.startsWith("sleep"))).toBe(false)
    expect(result.stderr).toBe(
      [
        `ot-gateway: checking for a newer ${moving}...`,
        "ot-gateway: could not check (net/http: timeout awaiting response headers), running the local image",
        ""
      ].join("\n")
    )
    expect(runCall(result.log)).toMatch(new RegExp(`-w /work ${moving} --version$`))
  })

  it("pulls a missing dev image like any other, with retries", () => {
    const moving = "ghcr.io/phocal-ai/ot-gateway:dev"
    const result = runWrapper(["--version"], { OT_GATEWAY_TAG: "dev", FAKE_PULL_FAILURES: "1" })
    expect(result.status).toBe(0)
    expect(result.log.filter((line) => line.startsWith("docker pull"))).toEqual([
      `docker pull -q ${moving}`,
      `docker pull -q ${moving}`
    ])
    expect(result.stderr).toBe(
      `ot-gateway: pulling ${moving} (about 460 MB)...\not-gateway: pull failed, retrying in 2 s\n`
    )
  })

  it("never checks a pinned dev-<sha> build for a newer one", () => {
    const pinned = "ghcr.io/phocal-ai/ot-gateway:dev-0123abc"
    const result = runWrapper(["--version"], { FAKE_IMAGE_PRESENT: "1", OT_GATEWAY_TAG: "dev-0123abc" })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.log.some((line) => line.startsWith("docker pull"))).toBe(false)
    expect(runCall(result.log)).toMatch(new RegExp(`-w /work ${pinned} --version$`))
  })

  it.each(["demo", "run", "watch"])("names the %s container after the command", (command) => {
    const result = runWrapper([command, "--seconds", "5"], { FAKE_IMAGE_PRESENT: "1" })
    expect(result.status).toBe(0)
    expect(runCall(result.log)).toMatch(new RegExp(`--name ot-gateway-${command} ${image} ${command} --seconds 5$`))
  })

  it("refuses a second demo while one is running, saying how to stop it", () => {
    const result = runWrapper(["demo"], { FAKE_IMAGE_PRESENT: "1", FAKE_RUNNING: "ot-gateway-demo" })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe(
      "ot-gateway: ot-gateway-demo is already running; stop it with: docker stop ot-gateway-demo\n"
    )
    expect(runCall(result.log)).toBeUndefined()
  })

  it("never names a container ot-gateway, the Compose service's", () => {
    const result = runWrapper(["status"], { FAKE_IMAGE_PRESENT: "1", FAKE_RUNNING: "ot-gateway" })
    expect(result.status).toBe(0)
    expect(runCall(result.log)).not.toContain("--name")
  })
})
