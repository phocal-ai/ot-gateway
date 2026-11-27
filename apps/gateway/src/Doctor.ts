/**
 * `ot-gateway doctor`: every check in one run, in the order a gateway depends on them, and one list of findings.
 *
 *   config       the file is there and describes a valid gateway (`check`)
 *   broker       a connection, the broker's limits and a message there and back (`broker`)
 *   gateway      whether this config's gateway runs, and how it is (`status`)
 *   device       each device: from the running gateway when it runs, else asked directly once (a Modbus read of its
 *                first point as `probe` does it, a Who-Is for a BACnet device's instance), read-only
 *   bacnet-port  the BACnet/IP port is free for the gateway (only with BACnet devices)
 *   disk         free space where the buffer and the history write
 *   clock        the wall clock is not behind the config's last change (a Pi has no real-time clock)
 *
 * Each finding has a status (`ok`, `warn`, `fail`, `skip`), what was found and, when it is not `ok`, a `code`, a
 * `hint` (what to check, most likely first) and `next` (one command to run). The codes are the ones the commands
 * behind each check report, so an agent that knows `broker --json` or `status --json` reads these too.
 *
 * Nothing is written to a device or the broker beyond `broker`'s own round-trip message.
 */
import { type DeviceStatus, type GatewayStatus, gatewayPortHintFor, isDeviceLate, whatToCheck } from "@ot-gateway/api"
import { makeBacnetNetwork, parseDeviceAddress } from "@ot-gateway/bacnet"
import type { Device, GatewayConfig, Network } from "@ot-gateway/core"
import { pointWidth } from "@ot-gateway/modbus"
import { Clock, Effect, FileSystem, Option, Result, Schema } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import { statfs } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { checkBroker, roundTripFailure } from "./Broker.ts"
import { statusUrlOf, targetOf } from "./GatewayTarget.ts"
import { LOW_DISK_BYTES } from "./Host.ts"
import { defaultConfigPath } from "./Import.ts"
import { ConfigFileError, loadConfig } from "./LoadConfig.ts"
import { shellArgument } from "./Output.ts"
import { count, firstOf, named, plural } from "./Words.ts"
import { probe, type ProbeFailure } from "./Probe.ts"
import { fetchStatusFor, unhealthySummary } from "./StatusReport.ts"

export type DoctorCheck = "config" | "broker" | "gateway" | "device" | "bacnet-port" | "disk" | "clock"
export type FindingStatus = "ok" | "warn" | "fail" | "skip"

export interface Finding {
  readonly check: DoctorCheck
  readonly status: FindingStatus
  /** What the finding is about when the check has several: a device id, a folder. */
  readonly subject?: string
  /** What was found, one line. */
  readonly message: string
  /** The whole of what the command behind the check said, when `message` is its first part. */
  readonly detail?: string
  /** What kind of problem, for scripts and agents: the code the command behind the check reports. */
  readonly code?: string
  /** What to check, most likely first, one sentence. */
  readonly hint?: string
  /** One command to run next. */
  readonly next?: string
}

export interface DoctorReport {
  readonly ok: boolean
  readonly config: string
  readonly findings: ReadonlyArray<Finding>
  readonly counts: Readonly<Record<FindingStatus, number>>
  /** The first command to run: the first failure's, else the first warning's; null when nothing needs doing. */
  readonly next: string | null
}

export interface DoctorOptions {
  /** How the user runs the CLI (`ot-gateway`, `npx ot-gateway`), for the commands in `next`. */
  readonly cli?: string
  /** Reach devices and the broker through this network instead of Node's (tests, a simulation). */
  readonly network?: Network
  /** The platform the commands in `next` are for (`process.platform`). */
  readonly platform?: string
}

/** Something doctor found is failing: printed already, this makes the exit code 1. */
export class DoctorProblems extends Schema.TaggedError<DoctorProblems>()("DoctorProblems", {
  message: Schema.String,
  code: Schema.Literal("doctor-problems")
}) {}

/** Under this much free space a disk finding warns; under `LOW_DISK_BYTES` (where the gateway warns) it fails. */
export const DISK_WARN_BYTES = 256 * 1024 * 1024

/** How far the wall clock may be behind the config's last change before it counts as wrong: a copy between machines. */
export const CLOCK_SLACK_MS = 5 * 60_000

/** How long one device may take to answer doctor, connecting and retries included. */
const DEVICE_DEADLINE = "12 seconds"

const sizeText = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : bytes >= 1024 ** 2
      ? `${Math.round(bytes / 1024 ** 2)} MiB`
      : `${Math.round(bytes / 1024)} KiB`

/** `ot-gateway <command>` with the config named only when it is not the default one in this folder. */
const commandFor =
  (cli: string, path: string) =>
  (command: string, rest = "") =>
    [cli, command, ...(path === defaultConfigPath ? [] : [shellArgument(path)]), ...(rest === "" ? [] : [rest])].join(
      " "
    )

// ---------------------------------------------------------------------------------------------------------------
// Devices

/** The failure class `whatToCheck` knows for a probe that failed, as the gateway's driver would report it. */
const probeReason: Readonly<Record<ProbeFailure, string>> = {
  unreachable: "connection",
  timeout: "timeout",
  exception: "protocol",
  bad_response: "invalid-response",
  usage: "configuration"
}

/** A failing device as a finding: the code is its failure class, the hint the status page's first check for it. */
export const deviceFailure = (
  device: { readonly id: string; readonly protocol: Device["protocol"] },
  reason: string,
  error: string,
  next: string | undefined,
  context: { readonly answeredBefore?: boolean } = {}
): Finding => {
  const hint = whatToCheck(device.protocol, reason, error, context)
  // `probe` says what failed, then what to check after a semicolon: the hint has the checks.
  const [first = error] = error.split("; ")
  return {
    check: "device",
    status: "fail",
    subject: device.id,
    message: first,
    ...(first === error ? {} : { detail: error }),
    code: `device-${reason}`,
    hint: hint.checks[0] ?? hint.meaning,
    ...(next === undefined ? {} : { next })
  }
}

/** The command that asks one device again, by hand: `probe` for Modbus, `discover --address` for BACnet. */
export const deviceNext = (device: Device, command: (name: string, rest?: string) => string, cli: string) => {
  if (device.protocol === "modbus-tcp") {
    const [first] = device.points
    if (first === undefined) return undefined
    const table = first.table === "holding" ? "" : ` --table ${first.table}`
    const unit = device.unitId === 1 ? "" : ` --unit-id ${device.unitId}`
    // An IPv6 host takes a port only in brackets, as `probe` reads it.
    const host = device.host.includes(":") ? `[${device.host}]` : device.host
    const endpoint = device.port === 502 && !device.host.includes(":") ? host : `${host}:${device.port}`
    return `${cli} probe ${shellArgument(endpoint)} ${first.address}${unit}${table}`
  }
  if (device.protocol === "bacnet-ip") {
    return command("discover", device.address === undefined ? "" : `--address ${shellArgument(device.address)}`)
  }
  return undefined
}

/** The devices as the running gateway reports them. */
export const devicesFromStatus = (
  status: GatewayStatus,
  config: GatewayConfig,
  command: (name: string, rest?: string) => string,
  cli: string
): ReadonlyArray<Finding> => {
  const configured = new Map(config.devices.map((device) => [device.id, device]))
  const running = new Set(status.devices.map((device) => device.id))
  const restart =
    "the gateway reads its config when it starts: restart it (docker compose restart in its folder, or systemctl restart ot-gateway)"
  const notLoaded = config.devices.flatMap((device): ReadonlyArray<Finding> =>
    running.has(device.id)
      ? []
      : [
          {
            check: "device",
            status: "warn",
            subject: device.id,
            message: "in the config, but the running gateway does not read it",
            code: "device-not-loaded",
            hint: restart
          }
        ]
  )
  const reported = status.devices.map((device: DeviceStatus): Finding => {
    const known = configured.get(device.id)
    const next = known === undefined ? command("status") : deviceNext(known, command, cli)
    if (device.status === "failing") {
      return deviceFailure(
        device,
        device.reason ?? "unknown",
        device.lastError ?? device.reason ?? "failing, no reason given",
        next ?? command("events"),
        { answeredBefore: device.lastSuccess !== undefined }
      )
    }
    // `status` fails on a late device too: the same here.
    if (isDeviceLate(device, status.now)) {
      return {
        check: "device",
        status: "fail",
        subject: device.id,
        message: "not failing, but not read lately: a polling cycle is stuck",
        code: "device-late",
        hint: "the gateway's warnings say which request hangs: ot-gateway logs --level warn",
        next: command("logs", "--level warn --since 10m")
      }
    }
    if (device.lastSuccess === undefined) {
      return { check: "device", status: "skip", subject: device.id, message: "the gateway has not read it yet" }
    }
    const read = `${device.protocol}: read by the gateway`
    return known === undefined
      ? {
          check: "device",
          status: "warn",
          subject: device.id,
          message: `${read}, but no longer in the config`,
          code: "device-not-in-config",
          hint: restart
        }
      : { check: "device", status: "ok", subject: device.id, message: read }
  })
  return [...reported, ...notLoaded]
}

/** One Modbus device asked once: its first point, as the gateway would read it. */
const askModbus = (
  device: Extract<Device, { readonly protocol: "modbus-tcp" }>,
  next: string | undefined,
  network: Network | undefined
): Effect.Effect<Finding> => {
  const [first] = device.points
  if (first === undefined) {
    return Effect.succeed({ check: "device", status: "skip", subject: device.id, message: "no points to read" })
  }
  const where = `${device.host}:${device.port} unit ${device.unitId}`
  return probe(
    {
      host: device.host,
      port: device.port,
      unitId: device.unitId,
      table: first.table,
      address: first.address,
      count: pointWidth(first)
    },
    network === undefined ? {} : { network }
  ).pipe(
    Effect.map((): Finding => ({
      check: "device",
      status: "ok",
      subject: device.id,
      message: `modbus-tcp ${where}: answered (${first.id})`
    })),
    Effect.catchTag("ProbeError", (error) =>
      Effect.succeed(deviceFailure(device, probeReason[error.reason], error.message, next))
    )
  )
}

type BacnetDevice = Extract<Device, { readonly protocol: "bacnet-ip" }>

/**
 * The BACnet/IP port as the gateway would open it, and each BACnet device located by its instance (at its address
 * when the config gives one). When another program holds the port, the devices are asked from a free one, which
 * finds a device at a fixed address; one that answers a broadcast on 47808 only is then not found.
 */
const askBacnet = Effect.fnUntraced(function* (
  settings: GatewayConfig["bacnet"],
  devices: ReadonlyArray<BacnetDevice>,
  nextOf: (device: BacnetDevice) => string | undefined,
  options: { readonly network: Network | undefined; readonly platform: string; readonly gatewayMayRun: boolean }
) {
  const port = `${settings.bindAddress}:${settings.port}`
  const findings: Array<Finding> = []
  const opened = yield* makeBacnetNetwork(settings, options.network).pipe(
    Effect.map((client) => Result.succeed(client)),
    Effect.catchTag("BacnetSocketError", (error) => Effect.succeed(Result.fail(error)))
  )
  let client = Result.isSuccess(opened) ? opened.success : undefined
  if (Result.isSuccess(opened)) {
    findings.push({ check: "bacnet-port", status: "ok", message: `UDP ${port} is free for the gateway` })
  } else {
    const inUse = opened.failure.addressInUse === true
    const reason = inUse ? "in use by another program" : opened.failure.message
    // A gateway doctor cannot ask (no status block, another one on its port) may be what holds it.
    const maybeOurs = inUse && options.gatewayMayRun
    findings.push({
      check: "bacnet-port",
      status: maybeOurs ? "warn" : "fail",
      message: `UDP ${port} cannot be opened: ${reason}${maybeOurs ? ", perhaps by this config's gateway" : ""}`,
      code: inUse ? "bacnet-port-in-use" : "bacnet-port-unavailable",
      hint: gatewayPortHintFor(reason).checks[0] ?? reason,
      ...(inUse ? { next: portOwnerCommand(settings.port, options.platform) } : {})
    })
    if (inUse) {
      const fallback = yield* makeBacnetNetwork({ ...settings, port: 0 }, options.network).pipe(
        Effect.map(Option.some),
        Effect.catchTag("BacnetSocketError", () => Effect.succeedNone)
      )
      client = Option.getOrUndefined(fallback)
    }
  }
  const asked = client
  if (asked === undefined) {
    for (const device of devices) {
      findings.push({
        check: "device",
        status: "skip",
        subject: device.id,
        message: "not asked: this machine cannot open a BACnet/IP port"
      })
    }
    return findings
  }
  const located = yield* Effect.forEach(
    devices,
    (device): Effect.Effect<Finding> => {
      const address = device.address === undefined ? undefined : parseDeviceAddress(device.address)
      if (address !== undefined && Result.isFailure(address)) {
        return Effect.succeed(deviceFailure(device, "configuration", address.failure, nextOf(device)))
      }
      const where = device.address === undefined ? "by broadcast" : `at ${device.address}`
      const notFound = `device ${device.deviceInstance} not found ${where}: no I-Am answered`
      return asked
        .locate(device.deviceInstance, address === undefined ? {} : { target: { address: address.success } })
        .pipe(
          Effect.map((found): Finding => ({
            check: "device",
            status: "ok",
            subject: device.id,
            message: `bacnet-ip device ${device.deviceInstance}: answered from ${NetAddress.formatInet(found.address)}`
          })),
          Effect.catchTags({
            BacnetTimeout: () => Effect.succeed(deviceFailure(device, "connection", notFound, nextOf(device))),
            BacnetSocketError: (error) =>
              Effect.succeed(deviceFailure(device, "connection", error.message, nextOf(device)))
          }),
          Effect.timeoutOrElse({
            duration: DEVICE_DEADLINE,
            orElse: () => Effect.succeed(deviceFailure(device, "connection", notFound, nextOf(device)))
          })
        )
    },
    { concurrency: 4 }
  )
  return [...findings, ...located]
}, Effect.scoped)

/** The command that names which program holds a UDP port. */
export const portOwnerCommand = (port: number, platform: string) =>
  platform === "linux" ? `ss -ulpn 'sport = :${port}'` : `lsof -nP -iUDP:${port}`

/**
 * Each device asked directly, once, read-only. Devices on one Modbus host are asked one after the other (a device
 * that takes one connection at a time would refuse the second), hosts and BACnet devices side by side.
 */
const askDevices = Effect.fnUntraced(function* (
  config: GatewayConfig,
  command: (name: string, rest?: string) => string,
  options: {
    readonly cli: string
    readonly network: Network | undefined
    readonly platform: string
    readonly gatewayMayRun: boolean
  }
) {
  const nextOf = (device: Device) => deviceNext(device, command, options.cli)
  const byHost = new Map<string, Array<Extract<Device, { readonly protocol: "modbus-tcp" }>>>()
  for (const device of config.devices) {
    if (device.protocol !== "modbus-tcp") continue
    const key = `${device.host}:${device.port}`
    byHost.set(key, [...(byHost.get(key) ?? []), device])
  }
  const modbus = Effect.forEach(
    [...byHost.values()],
    (devices) =>
      Effect.forEach(devices, (device) =>
        askModbus(device, nextOf(device), options.network).pipe(
          Effect.timeoutOrElse({
            duration: DEVICE_DEADLINE,
            orElse: () =>
              Effect.succeed(
                deviceFailure(
                  device,
                  "timeout",
                  `${device.host}:${device.port} unit ${device.unitId} did not answer within ${DEVICE_DEADLINE}`,
                  nextOf(device)
                )
              )
          })
        )
      ),
    { concurrency: 4 }
  ).pipe(Effect.map((groups) => groups.flat()))
  const bacnetDevices = config.devices.filter((device): device is BacnetDevice => device.protocol === "bacnet-ip")
  const bacnet: Effect.Effect<ReadonlyArray<Finding>> =
    bacnetDevices.length === 0
      ? Effect.succeed([])
      : askBacnet(config.bacnet, bacnetDevices, nextOf, {
          network: options.network,
          platform: options.platform,
          gatewayMayRun: options.gatewayMayRun
        })
  const [modbusFindings, bacnetFindings] = yield* Effect.all([modbus, bacnet], { concurrency: 2 })
  const simulated = config.devices.flatMap((device): ReadonlyArray<Finding> =>
    device.protocol === "simulator"
      ? [{ check: "device", status: "ok", subject: device.id, message: "simulated: nothing to reach" }]
      : []
  )
  // In config order, the port finding before the devices.
  const order = new Map(config.devices.map((device, index) => [device.id, index]))
  const devices = [...modbusFindings, ...bacnetFindings.filter((f) => f.check === "device"), ...simulated].toSorted(
    (a, b) => (order.get(a.subject ?? "") ?? 0) - (order.get(b.subject ?? "") ?? 0)
  )
  return { devices, port: bacnetFindings.filter((finding) => finding.check === "bacnet-port") }
})

// ---------------------------------------------------------------------------------------------------------------
// Disk and clock

/** The folder of `path`, or the nearest one above it that exists: the buffer's folder may not be made yet. */
const existingFolder = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  let folder = dirname(resolve(path))
  while (!(yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => false)))) {
    const parent = dirname(folder)
    if (parent === folder) return folder
    folder = parent
  }
  return folder
})

/** Free bytes for this user on the filesystem of `folder`; undefined when the system does not say. */
const freeBytes = (folder: string) =>
  Effect.tryPromise(() => statfs(folder)).pipe(
    Effect.map((stats) => stats.bavail * stats.bsize),
    Effect.orElseSucceed((): number | undefined => undefined)
  )

/** A disk finding from the free space of the folder `what` writes to. */
export const diskFinding = (what: string, folder: string, free: number | undefined, platform: string): Finding => {
  if (free === undefined) {
    return { check: "disk", status: "skip", subject: folder, message: `${what}: free space unknown on this system` }
  }
  const message = `${what} in ${folder}: ${sizeText(free)} free`
  if (free >= DISK_WARN_BYTES) return { check: "disk", status: "ok", subject: folder, message }
  return {
    check: "disk",
    status: free < LOW_DISK_BYTES ? "fail" : "warn",
    subject: folder,
    message,
    code: "disk-low",
    hint:
      free < LOW_DISK_BYTES
        ? "the buffer stops keeping values and the history stops writing when the disk is full: free space (old logs, docker system prune) or move them with OT_GATEWAY_DATA_DIR"
        : "the buffer fills while the broker is away and the history grows to retentionDays: free space before it runs out",
    next: platform === "win32" ? "dir" : `df -h ${shellArgument(folder)}`
  }
}

/** Where the gateway of `config` writes: the buffer and the history, else the config's own folder. */
const diskFindings = Effect.fnUntraced(function* (config: GatewayConfig | undefined, path: string, platform: string) {
  const targets = [
    ...(config?.buffer === undefined ? [] : [{ what: "buffer", path: config.buffer.path }]),
    ...(config?.history === undefined ? [] : [{ what: "history", path: config.history.path }])
  ].filter((target) => target.path !== ":memory:" && !target.path.startsWith("file:"))
  const asked = targets.length === 0 ? [{ what: "config folder", path: resolve(path) }] : targets
  const byFolder = new Map<string, Array<string>>()
  for (const target of asked) {
    const folder = yield* existingFolder(target.path)
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), target.what])
  }
  return yield* Effect.forEach([...byFolder], ([folder, what]) =>
    Effect.map(freeBytes(folder), (free) => diskFinding(what.join(" and "), folder, free, platform))
  )
})

/**
 * The clock against the config's last change: a wall clock behind it is wrong (a Pi without a real-time clock that
 * has not synced since boot), and every `ts` the gateway publishes with it is too.
 */
export const clockFinding = (now: number, changedAt: number | undefined, path: string, platform: string): Finding => {
  const clock = new Date(now).toISOString()
  if (changedAt === undefined || now >= changedAt - CLOCK_SLACK_MS) {
    return { check: "clock", status: "ok", message: `${clock} (UTC), not behind the config's last change` }
  }
  return {
    check: "clock",
    status: "fail",
    message: `this machine's clock reads ${clock}, before ${path} was last changed (${new Date(changedAt).toISOString()})`,
    code: "clock-behind",
    hint: "the clock is wrong, so is every ts the gateway publishes: a Raspberry Pi has no real-time clock and needs NTP (an NTP server reachable from this network) after each boot",
    next: platform === "linux" ? "timedatectl status" : platform === "darwin" ? "sntp time.apple.com" : "date"
  }
}

const clockCheck = Effect.fnUntraced(function* (path: string, platform: string) {
  const fs = yield* FileSystem.FileSystem
  const changedAt = yield* fs.stat(path).pipe(
    Effect.map((info) => Option.getOrUndefined(Option.map(info.mtime, (mtime) => mtime.getTime()))),
    Effect.orElseSucceed((): number | undefined => undefined)
  )
  return clockFinding(yield* Clock.currentTimeMillis, changedAt, path, platform)
})

// ---------------------------------------------------------------------------------------------------------------
// The run

/**
 * Whether this config's gateway runs, as far as doctor can tell: `running` (its status is read), `stopped` (nothing
 * answers on its status port), `other-release` (it answers in a form this CLI cannot read: it runs, so its devices
 * and port are left alone), `unknown` (no status block, or another gateway answers there).
 */
export type GatewayMode = "running" | "stopped" | "other-release" | "unknown"

/** The gateway check and, when it runs and is this config's, its view of the devices. */
const gatewayCheck = Effect.fnUntraced(function* (
  path: string,
  config: GatewayConfig,
  command: (name: string, rest?: string) => string
) {
  const fs = yield* FileSystem.FileSystem
  if (config.status === undefined) {
    const finding: Finding = {
      check: "gateway",
      status: "skip",
      message: `${path} has no status block, so a running gateway cannot be asked`,
      code: "no-status-page",
      hint: 'add "status": {} to the config to get the status page and the API that status, events and doctor ask'
    }
    return { finding, status: undefined, mode: "unknown" as GatewayMode }
  }
  const url = statusUrlOf(config.status)
  const target = yield* targetOf(path, config, undefined)
  const outcome = yield* fetchStatusFor(target).pipe(Effect.result)
  if (Result.isSuccess(outcome)) {
    const { status } = outcome.success
    const problem = unhealthySummary(status)
    const finding: Finding =
      problem === undefined
        ? { check: "gateway", status: "ok", message: `running at ${url}, version ${status.host?.version ?? "unknown"}` }
        : {
            check: "gateway",
            status: "fail",
            message: `running at ${url}: ${problem}`,
            code: "gateway-unhealthy",
            hint: "the device and broker findings below say what fails; what changed and when: ot-gateway events",
            next: command("status")
          }
    return { finding, status, mode: "running" as GatewayMode }
  }
  const error = outcome.failure
  switch (error._tag) {
    case "GatewayUnreachable": {
      const compose = join(dirname(resolve(path)), "compose.yaml")
      const hasCompose = yield* fs.exists(compose).pipe(Effect.orElseSucceed(() => false))
      const finding: Finding = {
        check: "gateway",
        status: "skip",
        message: `not running at ${url}: the devices are asked directly`,
        code: "gateway-unreachable",
        hint: "start it once the checks above pass",
        // up starts it with the folder's compose.yaml and waits for values; without one, run in this terminal.
        next: hasCompose ? command("up") : command("run")
      }
      return { finding, status: undefined, mode: "stopped" as GatewayMode }
    }
    case "GatewayMismatch":
      return {
        finding: {
          check: "gateway",
          status: "fail",
          message: error.message,
          code: "wrong-gateway",
          hint: "another gateway answers on this config's status port: give one of them another status.port",
          next: command("status")
        } satisfies Finding,
        status: undefined,
        mode: "unknown" as GatewayMode
      }
    case "GatewayAnswerUnreadable":
      return {
        finding: {
          check: "gateway",
          status: "warn",
          message: error.message,
          code: error.code,
          hint: "the gateway runs another release than this CLI: run the CLI at its version, or upgrade the gateway",
          next: command("status")
        } satisfies Finding,
        status: undefined,
        mode: "other-release" as GatewayMode
      }
  }
})

/** The findings of one config, checked in order; nothing fails the run itself. */
export const runDoctor = Effect.fn("runDoctor")(function* (path: string, options: DoctorOptions = {}) {
  const cli = options.cli ?? "ot-gateway"
  const platform = options.platform ?? process.platform
  const command = commandFor(cli, path)
  const findings: Array<Finding> = []
  const loaded = yield* loadConfig(path).pipe(
    Effect.catchTags({
      // The env file next to the config, or the file itself, could not be read: as a config that is not there.
      ConfigError: (error) =>
        Effect.fail(new ConfigFileError({ path, code: "invalid-config", message: error.message })),
      PlatformError: (error) =>
        Effect.fail(new ConfigFileError({ path, code: "invalid-config", message: `${path}: ${error.message}` }))
    }),
    Effect.result
  )
  if (Result.isFailure(loaded)) {
    const error = loaded.failure
    const missing = error.code === "no-config"
    findings.push({
      check: "config",
      status: "fail",
      message: missing
        ? `no config at ${path}`
        : error.issues?.[0] === undefined
          ? error.message
          : `${plural(error.issues.length, "mistake")}; the first: ${error.issues[0].path === undefined ? "" : `${error.issues[0].path}: `}${error.issues[0].message}`,
      code: error.code ?? "invalid-config",
      hint: missing
        ? "write one with ot-gateway init, or name the config elsewhere: ot-gateway doctor path/to/ot-gateway.json"
        : "every mistake with its path: ot-gateway check",
      // init writes into the folder named, where doctor looked.
      next: missing
        ? dirname(path) === "."
          ? `${cli} init`
          : `${cli} init ${shellArgument(dirname(path))}`
        : command("check")
    })
    for (const check of ["broker", "gateway"] as const) {
      findings.push({ check, status: "skip", message: "not checked without a valid config" })
    }
    findings.push(...(yield* diskFindings(undefined, path, platform)), yield* clockCheck(path, platform))
    return report(path, findings)
  }
  const config = loaded.success
  const devices = config.devices.length
  findings.push({
    check: "config",
    status: "ok",
    message: `${config.site}/${config.building} gateway ${config.id}, ${plural(devices, "device")}`
  })

  const brokerFailure = (message: string, code: string, hint: string | undefined): Finding => ({
    check: "broker",
    status: "fail",
    message,
    code,
    ...(hint === undefined ? {} : { hint }),
    next: command("broker")
  })
  findings.push(
    yield* checkBroker(config, options.network).pipe(
      Effect.map((checked): Finding => {
        const failure = checked.ok ? undefined : roundTripFailure(checked)
        if (failure !== undefined) return brokerFailure(failure.message, "no-round-trip", failure.hint)
        const summary = `${checked.broker}: MQTT ${checked.protocolVersion}${checked.roundTripMs === undefined ? "" : `, round trip ${checked.roundTripMs} ms`}`
        return checked.warnings.length > 0
          ? {
              check: "broker",
              status: "warn",
              message: summary,
              code: "broker-limits",
              hint: checked.warnings.join("; "),
              next: command("broker")
            }
          : { check: "broker", status: "ok", message: summary }
      }),
      Effect.catchTags({
        BrokerCommandError: (error) =>
          Effect.succeed(brokerFailure(error.message, error.code ?? "broker-unreachable", error.hint)),
        // The URL or the login in the config cannot be used as it is.
        MqttSettingsError: (error) =>
          Effect.succeed(
            brokerFailure(error.message, "broker-settings", "check mqtt.url and mqtt.username in the config")
          )
      })
    )
  )

  const gateway = yield* gatewayCheck(path, config, command)
  findings.push(gateway.finding)

  const hasBacnet = config.devices.some((device) => device.protocol === "bacnet-ip")
  if (gateway.status !== undefined || gateway.mode === "other-release") {
    // A running gateway reads the devices and holds the port: doctor does not ask them a second time.
    findings.push(
      ...(gateway.status === undefined
        ? config.devices.map((device): Finding => ({
            check: "device",
            status: "skip",
            subject: device.id,
            message: "not asked while a gateway runs: see ot-gateway status"
          }))
        : devicesFromStatus(gateway.status, config, command, cli)),
      ...(hasBacnet
        ? [
            {
              check: "bacnet-port",
              status: "skip",
              message: `UDP ${config.bacnet.port}: held by the running gateway`
            } satisfies Finding
          ]
        : [])
    )
  } else {
    const asked = yield* askDevices(config, command, {
      cli,
      network: options.network,
      platform,
      gatewayMayRun: gateway.mode === "unknown"
    })
    findings.push(...asked.devices, ...asked.port)
  }

  findings.push(...(yield* diskFindings(config, path, platform)), yield* clockCheck(path, platform))
  return report(path, findings)
})

/** The report of `findings`: ok when none fails, and the first command to run. */
export const report = (path: string, findings: ReadonlyArray<Finding>): DoctorReport => {
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 }
  for (const finding of findings) counts[finding.status] += 1
  const next =
    findings.find((finding) => finding.status === "fail" && finding.next !== undefined)?.next ??
    findings.find((finding) => finding.status === "warn" && finding.next !== undefined)?.next ??
    findings.find((finding) => finding.check === "gateway" && finding.next !== undefined)?.next ??
    null
  return { ok: counts.fail === 0, config: path, findings, counts, next }
}

// ---------------------------------------------------------------------------------------------------------------
// Output

const marks: Readonly<Record<FindingStatus, string>> = { ok: "✓", warn: "!", fail: "✗", skip: "–" }

/** The line's label: the check, or the device's id. */
const labelOf = (finding: Finding) => (finding.check === "device" ? (finding.subject ?? "device") : finding.check)

/** The worst of the statuses: a failure before a warning before ok, and skip only when all are. */
const worst = (statuses: ReadonlyArray<FindingStatus>): FindingStatus =>
  statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : statuses.includes("ok") ? "ok" : "skip"

/** The devices in one finding: how many are fine, and how many fail, warn or were not checked. */
export const devicesFinding = (devices: ReadonlyArray<Finding>): Finding => {
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 }
  for (const device of devices) counts[device.status] += 1
  const total = devices.length
  const parts = [
    counts.fail > 0 ? `${count(counts.fail)} failing` : undefined,
    counts.warn > 0 ? `${count(counts.warn)} with a warning` : undefined,
    counts.skip > 0 ? `${count(counts.skip)} not checked` : undefined
  ].filter((part) => part !== undefined)
  const message =
    counts.ok === total
      ? `${plural(total, "device")}, all ok`
      : [
          counts.ok > 0 ? `${count(counts.ok)} of ${plural(total, "device")} ok` : plural(total, "device"),
          ...parts
        ].join(", ")
  // A line of the text only, labelled `devices`: --json keeps a finding per device.
  return { check: "device", subject: "devices", status: worst(devices.map((device) => device.status)), message }
}

/**
 * The lines of the findings. A terminal (`brief`) sums the devices up in one line, then names the failing ones and
 * those with a warning, the first few, so a site of 300 devices fits a screen: `all` (`--all`), a pipe and --json
 * have every device.
 */
const shownFindings = (
  findings: ReadonlyArray<Finding>,
  options: { readonly brief: boolean; readonly all: boolean }
) => {
  const devices = findings.filter((finding) => finding.check === "device")
  if (!options.brief || options.all || devices.length === 0) return { rows: findings, more: 0 }
  const attention = devices.filter((device) => device.status === "fail" || device.status === "warn")
  const { shown, more } = firstOf([
    ...attention.filter((device) => device.status === "fail"),
    ...attention.filter((device) => device.status === "warn")
  ])
  const [first] = devices
  const at = first === undefined ? 0 : findings.indexOf(first)
  const others = findings.filter((finding) => finding.check !== "device")
  return { rows: [...others.slice(0, at), devicesFinding(devices), ...shown, ...others.slice(at)], more }
}

/**
 * The report for a person. `brief` (a terminal) is one line per finding, the devices summed up (`all` lists each),
 * and the one command to run; otherwise (piped, a log) every device, and each problem also has its hint and its own
 * next command, for whoever reads it later.
 */
export const formatDoctor = (
  doctor: DoctorReport,
  options: { readonly brief: boolean; readonly all?: boolean; readonly cli?: string }
) => {
  const { rows, more } = shownFindings(doctor.findings, { brief: options.brief, all: options.all ?? false })
  const width = Math.max(0, ...rows.map((finding) => labelOf(finding).length))
  const lines = rows.flatMap((finding) => {
    const line = `${marks[finding.status]} ${labelOf(finding).padEnd(width)}  ${finding.message}`
    if (options.brief || finding.status === "ok" || finding.status === "skip") return [line]
    return [
      line,
      ...(finding.hint === undefined ? [] : [`    ${finding.hint}`]),
      ...(finding.next === undefined ? [] : [`    next: ${finding.next}`])
    ]
  })
  const afterDevices =
    more === 0
      ? []
      : [
          `  ${" ".repeat(width)}  and ${count(more)} more: ${commandFor(options.cli ?? "ot-gateway", doctor.config)("doctor", "--all")} lists every device`
        ]
  const lastDevice = lines.findLastIndex((_, index) => rows[index]?.check === "device")
  const listed =
    lastDevice < 0 ? lines : [...lines.slice(0, lastDevice + 1), ...afterDevices, ...lines.slice(lastDevice + 1)]
  const { fail, warn } = doctor.counts
  const summary =
    fail > 0
      ? `${plural(fail, "problem")}${warn > 0 ? `, ${plural(warn, "warning")}` : ""}.`
      : warn > 0
        ? `No problems, ${plural(warn, "warning")}.`
        : "No problems."
  return [...listed, "", doctor.next === null ? summary : `${summary} Next: ${doctor.next}`].join("\n")
}

/** What `doctor --json` prints: the report, each finding complete. */
export const doctorJson = (doctor: DoctorReport) => doctor

/** The failure that makes the exit code 1 after the report: which checks failed. */
export const doctorProblems = (doctor: DoctorReport) => {
  const failed = doctor.findings.filter((finding) => finding.status === "fail")
  if (failed.length === 0) return undefined
  return new DoctorProblems({
    code: "doctor-problems",
    message: `${plural(failed.length, "problem")}: ${named(failed.map((finding) => labelOf(finding)))}`
  })
}
