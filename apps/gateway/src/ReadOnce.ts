/**
 * `ot-gateway read`: every configured point (or the ones named) read once through the gateway's own drivers, without
 * a running gateway, a broker or a status page; then it exits. What the status page's device test does
 * (SetupTools.ts), for a whole config and from the command line.
 *
 * It only reads, over connections of its own: a Modbus connection per endpoint (the devices behind one endpoint
 * take turns, since many allow one or two clients), and one UDP socket for every BACnet device, on the config's port
 * so broadcast answers arrive; when another program (a gateway on this machine) holds that port, on a free one, which
 * hears a device it asks at its address only. Each device has a deadline, and a point the device did not answer
 * for is read alone once to say why.
 */
import { type Hint, type PointTest, type ReadFailure, unitLabel, whatToCheck } from "@ot-gateway/api"
import { makeBacnetDriverFromClient, makeBacnetNetwork, type BacnetClient } from "@ot-gateway/bacnet"
import {
  type BacnetDevice,
  type Device,
  type GatewayConfig,
  monotonicMillis,
  type Network,
  pointTopic
} from "@ot-gateway/core"
import { endpointOf } from "@ot-gateway/modbus"
import { makeSimulatorDriver } from "@ot-gateway/simulator"
import { Clock, Duration, Effect, Schema } from "effect"
import { readPoints, targetOf, testModbus } from "./SetupTools.ts"
import { closestMatch } from "./Suggest.ts"

/** How long one device may take by default: connecting, finding a BACnet device, reading its points. */
export const DEFAULT_READ_SECONDS = 15
/** How much longer than its deadline a device may take before it is given up as a whole (connecting included). */
const BACKSTOP = Duration.seconds(5)
/** BACnet devices asked at the same time over the one socket. */
const BACNET_CONCURRENCY = 4
/** Modbus endpoints asked at the same time, each over its own connection. */
const MODBUS_CONCURRENCY = 8

/** A selection that names nothing in the config, or a socket the read cannot open. */
export class ReadError extends Schema.TaggedError<ReadError>()("ReadError", {
  message: Schema.String,
  code: Schema.Literals(["no-device", "no-point", "no-devices", "bacnet-port"]),
  hint: Schema.optionalKey(Schema.String)
}) {}

/** Points read, but not all of them: the report is printed already, this makes the exit code 1. */
export class ReadIncomplete extends Schema.TaggedError<ReadIncomplete>()("ReadIncomplete", {
  message: Schema.String
}) {}

/** A device, and the points of it to read (every one when `point` is left out). */
export interface ReadSelection {
  readonly device: string
  readonly point?: string
}

/** `--json`'s failure: the driver's class as `code`, and for a device what to check, most likely first. */
export interface ReadErrorJson {
  readonly code: string
  readonly message: string
  readonly hint?: string
  readonly checks?: ReadonlyArray<string>
}

export interface PointRead {
  readonly id: string
  readonly name: string
  readonly topic: string
  readonly ok: boolean
  /** As the gateway would publish it: scaled. */
  readonly value?: number | boolean
  /** What the device sent, when scaling changed it. */
  readonly raw?: number | boolean
  readonly unit?: string
  readonly error?: ReadErrorJson
}

export interface DeviceRead {
  readonly device: string
  readonly protocol: Device["protocol"]
  /** Where it was asked: `192.168.1.30:502, unit 1`, `device 2001 at 192.168.1.40`. */
  readonly target: string
  readonly ok: boolean
  /** The device could not be reached at all: none of its points was read. */
  readonly error?: ReadErrorJson
  readonly note?: string
  readonly points: ReadonlyArray<PointRead>
  readonly durationMs: number
}

export interface ReadReport {
  readonly ok: boolean
  readonly site: string
  readonly building: string
  /** When the read started, Unix ms. */
  readonly at: number
  readonly durationMs: number
  readonly summary: {
    readonly devices: number
    readonly points: number
    readonly read: number
    readonly failed: number
  }
  readonly devices: ReadonlyArray<DeviceRead>
}

/** `meter/power,room` as selections; undefined for an empty one. */
export const parseReadSelection = (text: string): ReadonlyArray<ReadSelection> | undefined => {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
  if (parts.length === 0) return undefined
  return parts.map((part) => {
    const slash = part.indexOf("/")
    return slash < 0 ? { device: part } : { device: part.slice(0, slash), point: part.slice(slash + 1) }
  })
}

const didYouMean = (word: string, candidates: Iterable<string>) => {
  const meant = closestMatch(word, candidates)
  return meant === undefined ? "" : ` (did you mean ${meant}?)`
}

/**
 * The devices of `config` that `selections` name, each with only the points named (all of them for a device named
 * alone), in config order; every device for no selection. A name that is not in the config fails, with the closest.
 */
export const selectDevices = (
  config: GatewayConfig,
  selections: ReadonlyArray<ReadSelection>
): Effect.Effect<ReadonlyArray<Device>, ReadError> =>
  Effect.gen(function* () {
    if (config.devices.length === 0) {
      return yield* new ReadError({
        code: "no-devices",
        message: "the config has no devices to read",
        hint: "ot-gateway discover finds BACnet devices; ot-gateway import <list> adds a points list's"
      })
    }
    if (selections.length === 0) return config.devices
    const wanted = new Map<string, Set<string> | "all">()
    for (const selection of selections) {
      const device = config.devices.find((each) => each.id === selection.device)
      if (device === undefined) {
        const ids = config.devices.map((each) => each.id)
        return yield* new ReadError({
          code: "no-device",
          message: `no device ${selection.device} in the config${didYouMean(selection.device, ids)}`,
          hint: `its devices: ${ids.join(", ")}`
        })
      }
      if (selection.point === undefined || selection.point === "") {
        wanted.set(device.id, "all")
        continue
      }
      const points = device.points.map((point) => point.id)
      if (!points.includes(selection.point)) {
        return yield* new ReadError({
          code: "no-point",
          message: `${device.id} has no point ${selection.point}${didYouMean(selection.point, points)}`,
          hint: `its points: ${points.join(", ")}`
        })
      }
      const before = wanted.get(device.id)
      if (before === "all") continue
      wanted.set(device.id, new Set([...(before ?? []), selection.point]))
    }
    return config.devices.flatMap((device): ReadonlyArray<Device> => {
      const chosen = wanted.get(device.id)
      if (chosen === undefined) return []
      if (chosen === "all") return [device]
      return [withPoints(device, (id) => chosen.has(id))]
    })
  })

/** `device` with only the points `keep` takes, as the same kind of device. */
const withPoints = (device: Device, keep: (id: string) => boolean): Device => {
  switch (device.protocol) {
    case "modbus-tcp":
      return { ...device, points: device.points.filter((point) => keep(point.id)) }
    case "bacnet-ip":
      return { ...device, points: device.points.filter((point) => keep(point.id)) }
    case "simulator":
      return { ...device, points: device.points.filter((point) => keep(point.id)) }
  }
}

/** What a driver failure means, and what to check for it: the status page's table, for a device never read. */
const deviceFailure = (protocol: Device["protocol"], failure: ReadFailure): ReadErrorJson => {
  const advice: Hint = whatToCheck(protocol, failure.reason, failure.message)
  const [hint] = advice.checks
  return {
    code: failure.reason,
    message: oneShot(failure.message),
    ...(hint === undefined ? {} : { hint }),
    checks: advice.checks
  }
}

const pointRead = (config: GatewayConfig, device: Device, test: PointTest): PointRead => ({
  id: test.id,
  name: test.name,
  topic: pointTopic({ site: config.site, building: config.building, device: device.id, point: test.id }),
  ok: test.error === undefined,
  ...(test.value === undefined ? {} : { value: test.value }),
  ...(test.raw === undefined ? {} : { raw: test.raw }),
  ...(test.unit === undefined ? {} : { unit: test.unit }),
  ...(test.error === undefined ? {} : { error: { code: test.error.reason, message: pointMessage(test.error.message) } })
})

/** A point read alone that failed says so as a device would (`no point could be read (…)`); for the point, the why. */
const pointMessage = (message: string): string =>
  oneShot(/^no point could be read \((.+)\)$/.exec(message)?.[1] ?? message)

/** A driver's words without the retry the running gateway would make (`; asking again in 30 s`): this read ends. */
const oneShot = (message: string) => message.replace(/; asking again in [^;]*$/, "")

type Outcome =
  | { readonly _tag: "read"; readonly points: ReadonlyArray<PointTest> }
  | { readonly _tag: "unreachable"; readonly error: ReadFailure }

/** The BACnet side: one socket for every BACnet device, and whether it is on the config's port. */
interface BacnetSide {
  readonly client: BacnetClient
  readonly onConfigPort: boolean
}

/**
 * One socket for the BACnet devices: on the config's port, where broadcast answers arrive, or a free one when that
 * is taken. Fails only when no UDP socket opens at all.
 */
const openBacnet = (config: GatewayConfig, network: Pick<Network, "udp"> | undefined) =>
  makeBacnetNetwork(config.bacnet, network).pipe(
    Effect.map((client): BacnetSide => ({ client, onConfigPort: true })),
    Effect.catchTag("BacnetSocketError", () =>
      makeBacnetNetwork({ ...config.bacnet, port: 0 }, network).pipe(
        Effect.map((client): BacnetSide => ({ client, onConfigPort: false }))
      )
    ),
    Effect.catchTag("BacnetSocketError", (error) =>
      Effect.fail(
        new ReadError({
          code: "bacnet-port",
          message: `no UDP port for BACnet/IP: ${error.message}`,
          hint: "another program may hold every port it tried; ot-gateway status shows whether a gateway runs here"
        })
      )
    )
  )

const readDevice = (
  config: GatewayConfig,
  device: Device,
  bacnet: BacnetSide | undefined,
  network: Network | undefined,
  timeout: Duration.Duration
) =>
  Effect.gen(function* () {
    const started = yield* monotonicMillis
    const deadline = { device: device.id, ms: Duration.toMillis(timeout) }
    const outcome: { readonly read: Outcome; readonly note?: string } = yield* Effect.gen(function* () {
      switch (device.protocol) {
        case "modbus-tcp": {
          const read = yield* testModbus(device, network, deadline.ms)
          const note =
            read._tag === "unreachable" && read.error.reason === "connection"
              ? "Many Modbus devices take one or two clients: when a gateway reads this device, it may hold the connection this read needs (ot-gateway status says whether one runs)."
              : undefined
          return note === undefined ? { read } : { read, note }
        }
        case "bacnet-ip": {
          if (bacnet === undefined) return yield* Effect.die(new Error(`no BACnet socket for ${device.id}`))
          // A read does not subscribe to changes.
          const polled: BacnetDevice = { ...device, cov: false }
          const read = yield* readPoints(
            polled.points,
            (points) => makeBacnetDriverFromClient({ ...polled, points }, bacnet.client),
            deadline
          )
          const note =
            read._tag === "unreachable" &&
            read.error.reason === "timeout" &&
            device.address === undefined &&
            !bacnet.onConfigPort
              ? `Another program holds UDP port ${config.bacnet.port} (a gateway on this machine?), so this read listens on another port and does not hear broadcast answers: give the device its address (ip or ip:port), or stop that program.`
              : undefined
          return note === undefined ? { read } : { read, note }
        }
        case "simulator":
          return { read: yield* readPoints(device.points, () => Effect.succeed(makeSimulatorDriver(device))) }
      }
    }).pipe(
      // `readPoints` keeps to the deadline and keeps what it read before it; this is the backstop for the rest
      // (connecting, opening the driver), a little later so it never cuts a read that keeps to it.
      Effect.timeoutOrElse({
        duration: Duration.sum(timeout, BACKSTOP),
        orElse: () =>
          Effect.succeed({
            read: {
              _tag: "unreachable" as const,
              error: { reason: "timeout", message: `no answer within ${Duration.format(timeout)}` }
            }
          })
      })
    )
    const finished = yield* monotonicMillis
    // The Mac's own refusal first: another note (a Modbus device's clients) would send the reader the wrong way.
    const note =
      (outcome.read._tag === "unreachable" && network === undefined
        ? macLocalNetworkNote(process.platform, outcome.read.error.message)
        : undefined) ?? outcome.note
    const points =
      outcome.read._tag === "read" ? outcome.read.points.map((test) => pointRead(config, device, test)) : []
    const result: DeviceRead = {
      device: device.id,
      protocol: device.protocol,
      target: targetOf(device),
      ok: outcome.read._tag === "read" && points.every((point) => point.ok),
      ...(outcome.read._tag === "unreachable" ? { error: deviceFailure(device.protocol, outcome.read.error) } : {}),
      ...(note === undefined ? {} : { note }),
      points,
      durationMs: Math.max(0, finished - started)
    }
    return result
  })

/**
 * Why a LAN device can be "unreachable" from a Mac while it answers everything else: macOS's Local Network privacy
 * refuses unicast to the LAN with EHOSTUNREACH at once for a process it does not count as an allowed app. A shell in
 * tmux (or screen, or anything started by launchd) is one: the server outlives the terminal that started it. ping is
 * exempt, so the network looks fine.
 */
export const macLocalNetworkNote = (platform: string, message: string | undefined) =>
  platform === "darwin" && message !== undefined && /\bunreachable\b/i.test(message)
    ? "On macOS this is often Local Network privacy, not the device: allow your terminal app under System Settings > Privacy & Security > Local Network. Inside tmux or screen, restart its server from that app (tmux kill-server), or run the command outside it."
    : undefined

/**
 * Reads `devices` (from `selectDevices`) once: BACnet devices a few at a time over one socket, Modbus endpoints a few
 * at a time, the devices behind one endpoint one after another. The report keeps the config's order.
 */
export const readOnce = Effect.fn("readOnce")(function* (
  config: GatewayConfig,
  devices: ReadonlyArray<Device>,
  options: { readonly timeout?: Duration.Duration; readonly network?: Network } = {}
) {
  const timeout = options.timeout ?? Duration.seconds(DEFAULT_READ_SECONDS)
  const at = yield* Clock.currentTimeMillis
  const started = yield* monotonicMillis
  const bacnet = devices.some((device) => device.protocol === "bacnet-ip")
    ? yield* openBacnet(config, options.network)
    : undefined
  const read = (device: Device) => readDevice(config, device, bacnet, options.network, timeout)

  const byEndpoint = new Map<string, Array<Device>>()
  for (const device of devices) {
    if (device.protocol !== "modbus-tcp") continue
    const key = endpointOf(device)
    byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), device])
  }
  const [bacnetReads, modbusReads, simulated] = yield* Effect.all(
    [
      Effect.forEach(
        devices.filter((device) => device.protocol === "bacnet-ip"),
        read,
        { concurrency: BACNET_CONCURRENCY }
      ),
      Effect.forEach([...byEndpoint.values()], (behind) => Effect.forEach(behind, read), {
        concurrency: MODBUS_CONCURRENCY
      }),
      Effect.forEach(
        devices.filter((device) => device.protocol === "simulator"),
        read
      )
    ],
    { concurrency: "unbounded" }
  )
  const byId = new Map([...bacnetReads, ...modbusReads.flat(), ...simulated].map((each) => [each.device, each]))
  const results = devices.flatMap((device) => byId.get(device.id) ?? [])
  // Counted from the config: a device that did not answer has no point results, and its points are not read.
  const points = devices.reduce((sum, device) => sum + device.points.length, 0)
  const readCount = results.reduce((sum, device) => sum + device.points.filter((point) => point.ok).length, 0)
  const report: ReadReport = {
    ok: results.every((device) => device.ok),
    site: config.site,
    building: config.building,
    at,
    durationMs: Math.max(0, (yield* monotonicMillis) - started),
    summary: { devices: results.length, points, read: readCount, failed: points - readCount },
    devices: results
  }
  return report
}, Effect.scoped)

const valueText = (point: PointRead) => {
  if (point.value === undefined) return ""
  const unit = unitLabel(point.unit)
  return unit === "" ? String(point.value) : `${point.value} ${unit}`
}

const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)

/**
 * The report for a person: a line per point, `device/point  value unit`, aligned; a device that did not answer is
 * one line with what to check under it; then a line with the count. Short: --json has the rest.
 */
export const formatReadReport = (report: ReadReport): string => {
  const rows: Array<{ readonly name: string; readonly text: string; readonly extra?: ReadonlyArray<string> }> = []
  for (const device of report.devices) {
    if (device.error !== undefined) {
      rows.push({
        name: device.device,
        text: `not read: ${device.error.message}`,
        extra: [
          `  ${device.target}`,
          ...(device.error.hint === undefined ? [] : [`  check: ${device.error.hint}`]),
          ...(device.note === undefined ? [] : [`  ${device.note}`])
        ]
      })
      continue
    }
    for (const point of device.points) {
      rows.push({
        name: `${device.device}/${point.id}`,
        text: point.error === undefined ? valueText(point) : `error: ${point.error.message}`
      })
    }
  }
  const width = Math.max(0, ...rows.map((row) => row.name.length))
  const lines = rows.flatMap((row) => [`${row.name.padEnd(width)}  ${row.text}`, ...(row.extra ?? [])])
  const { summary } = report
  const counted =
    summary.failed === 0
      ? `${summary.read} point(s) of ${summary.devices} device(s) read in ${took(report.durationMs)}`
      : `${summary.read} of ${summary.points} point(s) read, ${summary.failed} failed, in ${took(report.durationMs)}`
  return [...lines, "", counted].join("\n")
}

/** Why the exit code is 1, as stderr's last line says it. */
export const incompleteMessage = (report: ReadReport) => {
  const failed = report.devices.filter((device) => !device.ok).map((device) => device.device)
  return `${report.summary.failed} of ${report.summary.points} point(s) not read (${failed.join(", ")})`
}
