/**
 * `ot-gateway doctor`: every check in order on an in-memory network (a broker, a Modbus device and a BACnet device
 * that answer, or do not), read-only, and the pure parts: the clock, the disk, the devices a running gateway reports,
 * the next command and the two ways the report is printed.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import type { GatewayStatus } from "@ot-gateway/api"
import { makeSimulatedDevice, serveSimulatedDevice } from "@ot-gateway/bacnet"
import { makeMemoryNetwork, type MemoryNetwork, parseConfig } from "@ot-gateway/core"
import { makeRegisterBank, makeSimulatorControl, serveModbus } from "@ot-gateway/modbus"
import { makeBrokerControl, serveMqtt } from "@ot-gateway/mqtt"
import { Effect, FileSystem } from "effect"
import { join } from "node:path"
import {
  CLOCK_SLACK_MS,
  clockFinding,
  deviceNext,
  devicesFromStatus,
  DISK_WARN_BYTES,
  diskFinding,
  doctorProblems,
  type Finding,
  formatDoctor,
  otGatewayCommand,
  report,
  runDoctor
} from "../src/Doctor.ts"
import { LOW_DISK_BYTES } from "../src/Host.ts"
import { pidsIn } from "../src/PortHolders.ts"

const configJson = (extra: { readonly modbusHost?: string; readonly bacnetInstance?: number } = {}) => ({
  site: "s",
  building: "b",
  mqtt: { url: "mqtt://10.0.0.2:1883" },
  bacnet: { requestTimeoutMs: 200, retries: 0 },
  devices: [
    {
      id: "meter",
      protocol: "modbus-tcp",
      host: extra.modbusHost ?? "10.0.0.5",
      unitId: 1,
      points: [{ id: "power", name: "Power", table: "holding", address: 100, dataType: "float32" }]
    },
    {
      id: "ahu",
      protocol: "bacnet-ip",
      deviceInstance: extra.bacnetInstance ?? 2001,
      address: "10.0.0.9",
      points: [{ id: "supply", name: "Supply", objectType: "analog-input", instance: 1 }]
    },
    {
      id: "pv",
      protocol: "simulator",
      points: [{ id: "power", name: "Power", waveform: "sine", min: 0, max: 10, periodSeconds: 60 }]
    }
  ]
})

/** A broker, a Modbus device and a BACnet device on `network`, until the scope closes. */
const building = (network: MemoryNetwork) =>
  Effect.gen(function* () {
    yield* serveMqtt(yield* network.listen("10.0.0.2", 1883), makeBrokerControl()).pipe(Effect.forkScoped)
    const control = makeSimulatorControl()
    const bank = makeRegisterBank()
    bank.holding.set(100, 0x4148)
    bank.holding.set(101, 0)
    yield* serveModbus(yield* network.listen("10.0.0.5", 502), bank, control).pipe(Effect.forkScoped)
    const socket = yield* network.host("10.0.0.9").udp({ address: "10.0.0.9", port: 47_808 })
    yield* serveSimulatedDevice(
      socket,
      makeSimulatedDevice({
        instance: 2001,
        name: "AHU",
        objects: [
          { objectType: "analog-input", instance: 1, name: "Supply", presentValue: { type: "real", value: 18 } }
        ]
      })
    )
    return control
  })

/** The config written to a folder of its own, for the run's scope. */
const writeConfig = (json: object) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const folder = yield* fs.makeTempDirectoryScoped()
    const path = join(folder, "ot-gateway.json")
    yield* fs.writeFileString(path, JSON.stringify(json))
    return path
  })

/** The commands a finding names, as `ot-gateway <name> [rest]`. */
const command = (name: string, rest = "") => ["ot-gateway", name, rest].filter((part) => part !== "").join(" ")

const byLabel = (findings: ReadonlyArray<Finding>) =>
  Object.fromEntries(findings.map((finding) => [finding.subject ?? finding.check, finding]))

describe("doctor on a network", () => {
  it.live("finds everything working, asks each device once and writes nothing", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      const control = yield* building(network)
      const path = yield* writeConfig(configJson())
      const doctor = yield* runDoctor(path, { network: network.host("10.0.0.1"), platform: "linux" })
      expect(doctor.findings.filter((finding) => finding.status === "fail")).toEqual([])
      expect(doctor.ok).toBe(true)
      expect(doctor.findings.map((finding) => [finding.check, finding.subject ?? null, finding.status])).toEqual([
        ["config", null, "ok"],
        ["broker", null, "ok"],
        // No status block: nothing to ask, so the devices are asked directly.
        ["gateway", null, "skip"],
        ["device", "meter", "ok"],
        ["device", "ahu", "ok"],
        ["device", "pv", "ok"],
        ["bacnet-port", null, "ok"],
        ["disk", expect.any(String), expect.stringMatching(/ok|skip/)],
        ["clock", null, "ok"]
      ])
      expect(byLabel(doctor.findings)["gateway"]?.code).toBe("no-status-page")
      expect(byLabel(doctor.findings)["ahu"]?.message).toBe("bacnet-ip device 2001: answered from 10.0.0.9:47808")
      expect(control.writes).toEqual([])
      expect(control.requests).toBe(1)
      expect(doctorProblems(doctor)).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live("names each problem with its code, hint and next command, and the first failure's command", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      yield* building(network)
      // Another program holds the BACnet/IP port on the gateway's machine.
      yield* Effect.flatMap(
        network.host("10.0.0.1").udp({ address: "0.0.0.0", port: 47_808 }),
        (socket) => socket.reader
      )
      const path = yield* writeConfig({
        ...configJson({ modbusHost: "10.0.0.6", bacnetInstance: 2002 }),
        mqtt: { url: "mqtt://10.0.0.3:1883" },
        // Nothing answers on its status port: the gateway is not running, so the port is someone else's.
        status: { port: 1 }
      })
      const doctor = yield* runDoctor(path, {
        network: network.host("10.0.0.1"),
        cli: "npx ot-gateway",
        platform: "linux"
      })
      const found = byLabel(doctor.findings)
      expect(doctor.ok).toBe(false)
      expect(found["broker"]).toMatchObject({ status: "fail", code: "broker-unreachable" })
      expect(found["broker"]?.next).toBe(`npx ot-gateway broker ${path}`)
      expect(found["meter"]).toMatchObject({
        status: "fail",
        code: "device-connection",
        hint: expect.stringContaining("switched on"),
        next: "npx ot-gateway probe 10.0.0.6 100"
      })
      expect(found["meter"]?.message).not.toContain(";")
      expect(found["meter"]?.detail).toContain("check the host")
      expect(found["ahu"]).toMatchObject({
        status: "fail",
        code: "device-connection",
        message: "device 2002 not found at 10.0.0.9: no I-Am answered",
        hint: expect.stringContaining("device instance"),
        next: `npx ot-gateway discover ${path} --address 10.0.0.9`
      })
      expect(found["bacnet-port"]).toMatchObject({
        status: "fail",
        code: "bacnet-port-in-use",
        next: "ss -ulpn 'sport = :47808'"
      })
      expect(found["gateway"]).toMatchObject({
        status: "skip",
        code: "gateway-unreachable",
        next: `npx ot-gateway run ${path}`
      })
      expect(doctor.next).toBe(found["broker"]?.next)
      expect(doctorProblems(doctor)?.message).toBe("4 problems: broker, meter, ahu and bacnet-port")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live("without a status block to ask, a taken BACnet/IP port may be the gateway's own: a warning", () =>
    Effect.gen(function* () {
      const network = makeMemoryNetwork()
      yield* building(network)
      yield* Effect.flatMap(
        network.host("10.0.0.1").udp({ address: "0.0.0.0", port: 47_808 }),
        (socket) => socket.reader
      )
      const doctor = yield* runDoctor(yield* writeConfig(configJson()), { network: network.host("10.0.0.1") })
      expect(byLabel(doctor.findings)["bacnet-port"]).toMatchObject({
        status: "warn",
        code: "bacnet-port-in-use",
        message: expect.stringContaining("perhaps by this config's gateway")
      })
      // From a free port, the device at its fixed address is still found.
      expect(byLabel(doctor.findings)["ahu"]?.status).toBe("ok")
      expect(doctor.ok).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live(
    "names what holds the BACnet/IP port: a read at work or this config's gateway warn, the demo or another program fail",
    () =>
      Effect.gen(function* () {
        const network = makeMemoryNetwork()
        yield* building(network)
        yield* Effect.flatMap(
          network.host("10.0.0.1").udp({ address: "0.0.0.0", port: 47_808 }),
          (socket) => socket.reader
        )
        const asked: Array<number> = []
        const holder = (line: string) => (port: number) =>
          Effect.sync(() => {
            asked.push(port)
            return [{ pid: 4711, command: line }]
          })
        const path = yield* writeConfig(configJson())
        const reading = yield* runDoctor(path, {
          network: network.host("10.0.0.1"),
          portHolders: holder("node /usr/local/lib/node_modules/ot-gateway/apps/gateway/src/main.mjs read --json")
        })
        expect(asked).toEqual([47_808])
        expect(byLabel(reading.findings)["bacnet-port"]).toMatchObject({
          status: "warn",
          code: "bacnet-port-in-use",
          message: "UDP 0.0.0.0:47808 is held by ot-gateway read (pid 4711) while it is at work",
          hint: expect.stringContaining("run doctor again")
        })
        expect(byLabel(reading.findings)["ahu"]?.status).toBe("ok")
        // This config's gateway: its status is the next command.
        const running = yield* runDoctor(path, {
          network: network.host("10.0.0.1"),
          cli: "otg",
          portHolders: holder(`node /x/apps/gateway/src/main.ts run ${path} --verbose`)
        })
        expect(byLabel(running.findings)["bacnet-port"]).toMatchObject({
          status: "warn",
          message: expect.stringContaining("held by a gateway on this machine (pid 4711)"),
          next: expect.stringMatching(/^otg status/)
        })
        // The demo holds it until stopped: a problem, named.
        const demo = yield* runDoctor(path, {
          network: network.host("10.0.0.1"),
          portHolders: holder("/usr/local/bin/ot-gateway demo")
        })
        expect(byLabel(demo.findings)["bacnet-port"]).toMatchObject({
          status: "fail",
          message: "UDP 0.0.0.0:47808 cannot be opened: held by ot-gateway demo (pid 4711)"
        })
        // A foreign program too, by its program only: its arguments can hold a password.
        const foreign = yield* runDoctor(path, {
          network: network.host("10.0.0.1"),
          portHolders: holder("/usr/bin/bridge --mqtt mqtt://admin:secret@10.0.0.5")
        })
        const port = byLabel(foreign.findings)["bacnet-port"]
        expect(port).toMatchObject({
          status: "fail",
          code: "bacnet-port-in-use",
          message: "UDP 0.0.0.0:47808 cannot be opened: held by bridge (pid 4711)"
        })
        expect(JSON.stringify(port)).not.toContain("secret")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it("knows an ot-gateway command line and what it runs, and the pids lsof and ss print", () => {
    expect(otGatewayCommand("node /opt/homebrew/lib/node_modules/ot-gateway/apps/gateway/src/main.mjs read")).toEqual({
      command: "read"
    })
    expect(otGatewayCommand("node --no-warnings /home/me/ot-gateway/apps/gateway/src/main.ts discover")).toEqual({
      command: "discover"
    })
    expect(otGatewayCommand("/usr/local/bin/ot-gateway --log-level debug read")).toEqual({ command: "read" })
    // The image's entrypoint names only the config: a gateway that runs.
    expect(
      otGatewayCommand(
        "node --enable-source-maps /opt/ot-gateway/apps/gateway/src/main.mjs /etc/ot-gateway/gateway.json"
      )
    ).toEqual({ command: "run" })
    expect(otGatewayCommand("/usr/bin/bacnet-tool --workdir /opt/ot-gateway --listen")).toBeUndefined()
    expect(otGatewayCommand("vim /home/me/ot-gateway.json")).toBeUndefined()
    expect(pidsIn("123\n456\n")).toEqual([123, 456])
    expect(pidsIn('UNCONN 0 0 0.0.0.0:47808 0.0.0.0:* users:(("node",pid=812,fd=21))')).toEqual([812])
    expect(pidsIn("")).toEqual([])
  })

  it.live("without a config says how to get one, and still checks the disk and the clock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      const doctor = yield* runDoctor(join(folder, "ot-gateway.json"))
      expect(doctor.findings.map((finding) => `${finding.check} ${finding.status}`)).toEqual([
        "config fail",
        "broker skip",
        "gateway skip",
        expect.stringMatching(/^disk (ok|skip|warn|fail)$/),
        "clock ok"
      ])
      // init writes the config where doctor looked for it.
      expect(doctor.findings[0]).toMatchObject({ code: "no-config", next: `ot-gateway init ${folder}` })
      expect(doctor.next).toBe(`ot-gateway init ${folder}`)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live("points at every mistake of an invalid config with check", () =>
    Effect.gen(function* () {
      const path = yield* writeConfig({ ...configJson(), site: "Not A Slug" })
      const doctor = yield* runDoctor(path)
      expect(doctor.findings[0]).toMatchObject({
        check: "config",
        status: "fail",
        code: "invalid-config",
        message: expect.stringContaining("site"),
        next: `ot-gateway check ${path}`
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("doctor's findings", () => {
  it("fails a clock behind the config's last change, beyond a copy's slack", () => {
    const changed = Date.UTC(2026, 10, 26, 12)
    expect(clockFinding(changed + 1_000, changed, "ot-gateway.json", "linux").status).toBe("ok")
    expect(clockFinding(changed - CLOCK_SLACK_MS + 1_000, changed, "ot-gateway.json", "linux").status).toBe("ok")
    expect(clockFinding(Date.UTC(1970, 0, 1), changed, "ot-gateway.json", "linux")).toMatchObject({
      status: "fail",
      code: "clock-behind",
      message: expect.stringContaining("1970-01-01"),
      next: "timedatectl status"
    })
    expect(clockFinding(0, undefined, "ot-gateway.json", "linux").status).toBe("ok")
  })

  it("warns under 256 MiB free and fails where the gateway does", () => {
    expect(diskFinding("buffer", "/data", DISK_WARN_BYTES, "linux").status).toBe("ok")
    expect(diskFinding("buffer", "/data", DISK_WARN_BYTES - 1, "linux")).toMatchObject({
      status: "warn",
      code: "disk-low",
      next: "df -h /data"
    })
    expect(diskFinding("buffer", "/data", LOW_DISK_BYTES - 1, "linux").status).toBe("fail")
    expect(diskFinding("buffer", "/data", undefined, "linux").status).toBe("skip")
  })

  it.effect(
    "takes the devices from a running gateway, with the status page's first check, and what it has not loaded",
    () =>
      Effect.gen(function* () {
        const config = yield* parseConfig(JSON.stringify(configJson()))
        const now = Date.UTC(2026, 10, 26, 12)
        const status: GatewayStatus = {
          site: "s",
          building: "b",
          id: "main",
          since: now - 60_000,
          now,
          configSince: now - 60_000,
          broker: {
            url: "mqtt://10.0.0.2:1883",
            connected: true,
            connects: 1,
            failedConnects: 0,
            published: 1,
            publishFailures: 0
          },
          devices: [
            {
              id: "meter",
              protocol: "modbus-tcp",
              status: "failing",
              pollIntervalMs: 5000,
              reason: "timeout",
              lastError: "no answer within 3 s",
              lastSuccess: now - 30_000,
              pointCount: 1,
              points: []
            },
            {
              id: "pv",
              protocol: "simulator",
              status: "ok",
              pollIntervalMs: 1000,
              lastSuccess: now - 60_000,
              pointCount: 1,
              points: []
            },
            {
              id: "old-meter",
              protocol: "modbus-tcp",
              status: "ok",
              pollIntervalMs: 5000,
              lastSuccess: now - 1_000,
              pointCount: 1,
              points: []
            }
          ],
          commands: []
        }
        const findings = devicesFromStatus(status, config, command, "ot-gateway")
        expect(findings.map((finding) => `${finding.subject} ${finding.status} ${finding.code ?? ""}`)).toEqual([
          "meter fail device-timeout",
          // Not read for a minute at a 1 s interval: status fails on it, and so does doctor.
          "pv fail device-late",
          "old-meter warn device-not-in-config",
          // Added to the config after the gateway started.
          "ahu warn device-not-loaded"
        ])
        expect(findings[0]).toMatchObject({
          // It answered earlier in this run: what changed leads, as on the status page.
          hint: expect.stringContaining("answered earlier"),
          next: "ot-gateway probe 10.0.0.5 100"
        })
      })
  )

  it.effect("puts an IPv6 host in brackets when the probe it suggests names a port", () =>
    Effect.gen(function* () {
      const nextAt = Effect.fnUntraced(function* (host: string, port: number) {
        const [base] = configJson().devices
        const config = yield* parseConfig(JSON.stringify({ ...configJson(), devices: [{ ...base, host, port }] }))
        const [device] = config.devices
        return device === undefined ? undefined : deviceNext(device, command, "ot-gateway")
      })
      expect(yield* nextAt("fd00::5", 5020)).toBe("ot-gateway probe '[fd00::5]:5020' 100")
      expect(yield* nextAt("fd00::5", 502)).toBe("ot-gateway probe '[fd00::5]:502' 100")
      expect(yield* nextAt("10.0.0.5", 5020)).toBe("ot-gateway probe 10.0.0.5:5020 100")
    })
  )

  it("prints one line per finding in a terminal, and the hint and next of each problem otherwise", () => {
    const doctor = report("ot-gateway.json", [
      { check: "config", status: "ok", message: "s/b gateway main, 1 device" },
      {
        check: "broker",
        status: "fail",
        message: "could not connect",
        code: "broker-unreachable",
        hint: "is it running?",
        next: "ot-gateway broker"
      },
      {
        check: "device",
        status: "warn",
        subject: "meter",
        message: "late",
        code: "device-late",
        next: "ot-gateway logs"
      }
    ])
    expect(doctor).toMatchObject({ ok: false, next: "ot-gateway broker", counts: { ok: 1, warn: 1, fail: 1, skip: 0 } })
    expect(formatDoctor(doctor, { brief: true }).split("\n")).toEqual([
      "✓ config   s/b gateway main, 1 device",
      "✗ broker   could not connect",
      "! devices  1 device, 1 with a warning",
      "! meter    late",
      "",
      "1 problem, 1 warning. Next: ot-gateway broker"
    ])
    expect(formatDoctor(doctor, { brief: false }).split("\n")).toEqual([
      "✓ config  s/b gateway main, 1 device",
      "✗ broker  could not connect",
      "    is it running?",
      "    next: ot-gateway broker",
      "! meter   late",
      "    next: ot-gateway logs",
      "",
      "1 problem, 1 warning. Next: ot-gateway broker"
    ])
    expect(formatDoctor(report("x.json", [{ check: "clock", status: "ok", message: "fine" }]), { brief: true })).toBe(
      "✓ clock  fine\n\nNo problems."
    )
  })
})
