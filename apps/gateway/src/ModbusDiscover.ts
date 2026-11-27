/**
 * `ot-gateway discover modbus <range>`: find the Modbus TCP devices on a range of addresses, and the unit ids that
 * answer on each, the way `discover` finds BACnet devices by Who-Is. Modbus has no broadcast, so each address is
 * asked in turn.
 *
 * Read-only, always: each unit is asked for one holding register (FC 03, register 0) and, when it refuses that
 * function or address, one input register (FC 04, register 0). Any answer, a refusal included (spec §7), shows a
 * Modbus device; exceptions 0A and 0B are a Modbus gateway saying that no device answers behind it on that unit id.
 * Nothing is ever written.
 *
 * Rate-limited: every request (and the connection it opens) waits for a slot, at most `rate` a second across the
 * whole scan, with a pause between the requests to one address, so a scan does not flood a building network or a
 * serial gateway. A few addresses are asked side by side, so silent ones do not hold the scan up.
 *
 * Each unit found becomes a row of a draft points list: the device named by its address and unit id, and one
 * placeholder point, the register it answered with, to replace with the datasheet's registers (`probe` helps).
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import type { Network } from "@ot-gateway/core"
import {
  endpointText,
  ExceptionCode,
  FunctionCode,
  makeModbusLink,
  type ModbusClient,
  type RegisterReadCode
} from "@ot-gateway/modbus"
import { Duration, Effect, FileSystem, Result, Schema, Semaphore } from "effect"
import * as Socket from "effect/socket/Socket"
import { toCsv } from "./Csv.ts"
import { pointsListNext, type PointsListOptions, type PointsListWritten, writeAtomically } from "./Discover.ts"
import { isEde } from "./Ede.ts"
import { shellArgument } from "./Output.ts"
import { appendToPointsList } from "./PointsListAppend.ts"
import { parseEndpoint } from "./Probe.ts"
import { plural } from "./Words.ts"

/** Why a Modbus scan did not run or found nothing: `code` for scripts, `hint` for what to do next. */
export class ModbusDiscoverError extends Schema.TaggedError<ModbusDiscoverError>()("ModbusDiscoverError", {
  message: Schema.String,
  code: Schema.String,
  hint: Schema.String
}) {}

/** Modbus TCP's port (spec, Modbus Messaging on TCP/IP §4.2). */
export const MODBUS_PORT = 502

/** At most this many addresses in one scan: a /22. A larger network is scanned in parts. */
export const MAX_HOSTS = 1024

/** Requests a second across a scan, unless `--rate` says otherwise. */
export const DEFAULT_RATE = 20

/** The highest `--rate`: a scan is a guest on the network. */
export const MAX_RATE = 200

/** Addresses asked side by side. */
const CONCURRENCY = 16

/** The pause between two requests to one address: serial gateways drop requests sent back to back. */
const REQUEST_GAP = "50 millis"

/** The unit ids asked when none are named: 1, then the ones TCP devices also answer on when 1 is silent. */
export const AUTO_UNIT_IDS = [1, 255, 0] as const

export interface ScanTarget {
  readonly host: string
  readonly port: number
}

export const modbusRangeHint =
  "a range is an address (192.168.1.20 or 192.168.1.20:5020), a network (192.168.1.0/24), first and last (192.168.1.10-40 or 192.168.1.10-192.168.1.40), or several of those with commas"

const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** An IPv4 address as a number, when it is one. */
const ipv4Number = (text: string): number | undefined => {
  const match = ipv4.exec(text)
  if (match === null) return undefined
  const octets = match.slice(1).map(Number)
  if (octets.some((octet) => octet > 255)) return undefined
  return octets.reduce((value, octet) => value * 256 + octet, 0)
}

const ipv4Text = (value: number) => [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".")

/** First to last, as numbers, when there are no more than `MAX_HOSTS`. */
const span = (first: number, last: number): Result.Result<ReadonlyArray<number>, string> => {
  if (last < first) return Result.fail("the last address comes before the first")
  if (last - first + 1 > MAX_HOSTS) return Result.fail(`${last - first + 1} addresses, more than ${MAX_HOSTS}`)
  return Result.succeed(Array.from({ length: last - first + 1 }, (_, index) => first + index))
}

/** One item of a range, as addresses with their port. */
const parseItem = (item: string, port: number): Result.Result<ReadonlyArray<ScanTarget>, string> => {
  const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(item)
  if (cidr !== null) {
    const base = ipv4Number(cidr[1] ?? "")
    const prefix = Number(cidr[2])
    if (base === undefined || prefix > 32) return Result.fail(`${item} is not an IPv4 network`)
    const size = 2 ** (32 - prefix)
    if (size > MAX_HOSTS) {
      return Result.fail(`${item} holds ${size} addresses, more than ${MAX_HOSTS}: scan a /22 or smaller at a time`)
    }
    const network = Math.floor(base / size) * size
    // The network's own address and its broadcast are no host's, except on a /31 or /32 (RFC 3021).
    const hosts = size > 2 ? span(network + 1, network + size - 2) : span(network, network + size - 1)
    return Result.map(hosts, (numbers) => numbers.map((value) => ({ host: ipv4Text(value), port })))
  }
  const dash = /^([\d.]+)-([\d.]+)$/.exec(item)
  if (dash !== null) {
    const first = ipv4Number(dash[1] ?? "")
    const lastText = dash[2] ?? ""
    // `192.168.1.10-40`: the last octet only.
    const last =
      first === undefined
        ? undefined
        : /^\d{1,3}$/.test(lastText)
          ? Number(lastText) <= 255
            ? Math.floor(first / 256) * 256 + Number(lastText)
            : undefined
          : ipv4Number(lastText)
    if (first === undefined || last === undefined) return Result.fail(`${item} is not a range of IPv4 addresses`)
    const hosts = span(first, last)
    return Result.isFailure(hosts)
      ? Result.fail(`${item}: ${hosts.failure}`)
      : Result.succeed(hosts.success.map((value) => ({ host: ipv4Text(value), port })))
  }
  const endpoint = parseEndpoint(item)
  // Digits and dots are an IPv4 address or a mistake, never a host name.
  if (endpoint === undefined || (/^[\d.]+$/.test(endpoint.host) && ipv4Number(endpoint.host) === undefined)) {
    return Result.fail(`${item} is not an address`)
  }
  // A port given with the address wins over --port.
  return Result.succeed([{ host: endpoint.host, port: /:\d+$/.test(item) ? endpoint.port : port }])
}

/** The addresses of a range (`modbusRangeHint`), each once, in order; at most `MAX_HOSTS`. */
export const parseRange = (
  text: string,
  port: number = MODBUS_PORT
): Result.Result<ReadonlyArray<ScanTarget>, string> => {
  const items = text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
  if (items.length === 0) return Result.fail("no address given")
  const seen = new Set<string>()
  const targets: Array<ScanTarget> = []
  for (const item of items) {
    const parsed = parseItem(item, port)
    if (Result.isFailure(parsed)) return parsed
    for (const target of parsed.success) {
      const key = endpointText(target)
      if (seen.has(key)) continue
      seen.add(key)
      targets.push(target)
    }
    if (targets.length > MAX_HOSTS) return Result.fail(`${targets.length} addresses or more, more than ${MAX_HOSTS}`)
  }
  return Result.succeed(targets)
}

/** `1`, `1,2,5` or `1-247`, each id 0 to 255, each once, in order. */
export const parseUnitIds = (text: string): Result.Result<ReadonlyArray<number>, string> => {
  const ids = new Set<number>()
  for (const item of text.split(",").map((each) => each.trim())) {
    const match = /^(\d{1,3})(?:-(\d{1,3}))?$/.exec(item)
    const first = Number(match?.[1])
    const last = match?.[2] === undefined ? first : Number(match[2])
    if (match === null || first > 255 || last > 255 || last < first) {
      return Result.fail(`${item === "" ? "an empty item" : item}: unit ids are 0 to 255, as 1, 1,2,5 or 1-247`)
    }
    for (let id = first; id <= last; id++) ids.add(id)
  }
  return Result.succeed([...ids])
}

export interface ModbusScanRequest {
  /** What was asked, as given, for the report. */
  readonly range: string
  readonly targets: ReadonlyArray<ScanTarget>
  /** The unit ids to ask on each address; undefined asks 1, and 255 and 0 when 1 is silent (`AUTO_UNIT_IDS`). */
  readonly unitIds?: ReadonlyArray<number> | undefined
  /** Requests a second across the scan (default `DEFAULT_RATE`). */
  readonly rate?: number | undefined
  /** The port asked where the range gives none (`--port`), to repeat in a command to run next. */
  readonly askedPort?: number | undefined
}

export interface ModbusScanOptions {
  /** How devices are reached; Node's TCP when left out (tests pass an in-memory network). */
  readonly network?: Network
  /** Time allowed to open a connection (default 1 s: a scan meets many addresses with nothing behind them). */
  readonly connectTimeout?: Duration.Input
  /** Time allowed for an answer (default 1 s). */
  readonly requestTimeout?: Duration.Input
  /** Told each address as it is done, for progress on stderr. */
  readonly onDone?: (done: number, total: number) => Effect.Effect<void>
}

/** A unit that answered: with a register's value, or with a refusal that still shows a Modbus device. */
export interface FoundUnit {
  readonly host: string
  readonly port: number
  readonly unitId: number
  /** The table and register 0's value, when one of them could be read. */
  readonly table?: "holding" | "input"
  readonly value?: number
  /** The exception the device answered the holding register read with, when it refused it (spec §7). */
  readonly exceptionCode?: number
}

/** An address whose port answered: the units found, and whether it is a Modbus gateway (exceptions 0A, 0B). */
export interface ScannedHost {
  readonly host: string
  readonly port: number
  readonly units: ReadonlyArray<FoundUnit>
  readonly gateway: boolean
  /** Unit ids asked that did not answer in time. */
  readonly silent: ReadonlyArray<number>
  /** Every unit id asked answered alike: maybe one device that ignores the unit id, every unit kept. */
  readonly anyUnitId: boolean
  /** It took the connection and closed it before any answer: one that takes one connection at a time. */
  readonly dropped: boolean
  /** The scan's time for this address ran out before every unit id was asked: the units found are kept. */
  readonly timedOut: boolean
}

export interface NotModbus {
  readonly host: string
  readonly port: number
  readonly message: string
}

export interface ModbusScanReport {
  readonly range: string
  /** The one port every address was asked on, when it is one. */
  readonly port: number | undefined
  /** `--port`, as asked. */
  readonly askedPort: number
  readonly unitIds: ReadonlyArray<number> | "auto"
  readonly rate: number
  readonly scanned: number
  /** Addresses whose port took the connection: Modbus devices and gateways, found or silent. */
  readonly hosts: ReadonlyArray<ScannedHost>
  /** Addresses whose port took the connection and answered something that is not Modbus TCP. */
  readonly notModbus: ReadonlyArray<NotModbus>
}

type UnitAnswer =
  | { readonly _tag: "Found"; readonly unit: FoundUnit }
  | { readonly _tag: "NoTarget" }
  | { readonly _tag: "Silent" }
  | { readonly _tag: "Closed" }
  | { readonly _tag: "NotModbus"; readonly message: string }

type HostOutcome =
  | { readonly _tag: "Host"; readonly host: ScannedHost }
  | { readonly _tag: "Closed" }
  | { readonly _tag: "NotModbus"; readonly notModbus: NotModbus }

/** One register 0 of `table`'s, as a unit's answer. */
const readZero = (client: ModbusClient, functionCode: RegisterReadCode) => client.readRegisters(functionCode, 0, 1)

/**
 * What one unit id answers: register 0 of the holding registers, or of the input registers when the device refuses
 * the function or the address. `slot` waits for the scan's rate before each request.
 */
const askUnit = (client: ModbusClient, target: ScanTarget, unitId: number, slot: Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* slot
    const holding = yield* Effect.result(readZero(client, FunctionCode.ReadHoldingRegisters))
    const base = { host: target.host, port: target.port, unitId }
    if (Result.isSuccess(holding)) {
      return { _tag: "Found", unit: { ...base, table: "holding", value: holding.success[0] ?? 0 } } as const
    }
    const error = holding.failure
    switch (error._tag) {
      case "ModbusTimeout":
        return { _tag: "Silent" } as const
      case "ModbusConnectionError":
        return { _tag: "Closed" } as const
      case "ModbusFrameError":
        return { _tag: "NotModbus", message: error.message } as const
      case "ModbusException": {
        const code = error.exceptionCode
        if (code === ExceptionCode.GatewayPathUnavailable || code === ExceptionCode.GatewayTargetFailedToRespond) {
          return { _tag: "NoTarget" } as const
        }
        const refused = { ...base, exceptionCode: code }
        if (code !== ExceptionCode.IllegalFunction && code !== ExceptionCode.IllegalDataAddress) {
          return { _tag: "Found", unit: refused } as const
        }
        yield* slot
        const input = yield* Effect.result(readZero(client, FunctionCode.ReadInputRegisters))
        return {
          _tag: "Found",
          unit: Result.isSuccess(input) ? { ...refused, table: "input", value: input.success[0] ?? 0 } : refused
        } as const
      }
    }
  }) satisfies Effect.Effect<UnitAnswer>

/** The unit ids to ask next: the named ones in turn, or 1 then 255 and 0 until one answers. */
const unitOrder = (unitIds: ReadonlyArray<number> | undefined) => unitIds ?? AUTO_UNIT_IDS

/** Whether every unit found answered alike, as a device that ignores the unit id does. */
const answersAlike = (units: ReadonlyArray<FoundUnit>) => {
  const [first] = units
  return units.every(
    (unit) => unit.table === first?.table && unit.value === first?.value && unit.exceptionCode === first?.exceptionCode
  )
}

/** What one address has answered so far, kept outside its deadline so a timeout keeps what was found. */
interface HostProgress {
  readonly units: Array<FoundUnit>
  readonly silent: Array<number>
  gateway: boolean
  /** The TCP connection opened. */
  opened: boolean
  /** Something answered on it (a response, a refusal, or a timeout on an open connection). */
  connected: boolean
}

/** What an address answered, as the report keeps it. */
const hostOf = (target: ScanTarget, progress: HostProgress, flags: { dropped?: boolean; timedOut?: boolean } = {}) => {
  const { units, silent, gateway } = progress
  const host: ScannedHost = {
    ...target,
    units,
    gateway,
    silent,
    anyUnitId: !gateway && silent.length === 0 && units.length > 1 && answersAlike(units),
    dropped: flags.dropped === true,
    timedOut: flags.timedOut === true
  }
  return { _tag: "Host", host } satisfies HostOutcome
}

/** One address: its connection opened once, each unit id asked over it, read-only. */
const scanTarget = Effect.fn("scanModbusTarget")(function* (
  target: ScanTarget,
  request: ModbusScanRequest,
  options: ModbusScanOptions,
  slot: Effect.Effect<void>,
  progress: HostProgress
) {
  const endpoint = endpointText(target)
  const connectTimeout = options.connectTimeout ?? "1 second"
  const socketOptions = { host: target.host, port: target.port, openTimeout: connectTimeout }
  const socket = yield* options.network ? options.network.tcp(socketOptions) : NodeSocket.makeNet(socketOptions)
  // Whether the connection opened tells a port nothing listens on from a device that hangs up at once.
  const watched = Socket.make({
    reader: socket.reader.pipe(Effect.tap(() => Effect.sync(() => (progress.opened = true)))),
    writer: socket.writer
  })
  const link = yield* makeModbusLink(watched, {
    endpoint,
    requestGap: REQUEST_GAP,
    requestTimeout: options.requestTimeout ?? "1 second"
  })
  const auto = request.unitIds === undefined
  for (const unitId of unitOrder(request.unitIds)) {
    const answer: UnitAnswer = yield* askUnit(link.unit(unitId), target, unitId, slot)
    if (answer._tag === "NotModbus") {
      // On the first exchange it is not Modbus; after answers, a reply that does not match (a device that answers
      // every unit id as its own) is that unit not answering.
      if (!progress.connected) {
        const notModbus: NotModbus = { ...target, message: answer.message }
        return { _tag: "NotModbus", notModbus } satisfies HostOutcome
      }
      progress.silent.push(unitId)
      continue
    }
    if (answer._tag === "Closed") {
      if (progress.connected) break
      // Took the connection, then closed it unanswered; otherwise nothing listens.
      return progress.opened ? hostOf(target, progress, { dropped: true }) : ({ _tag: "Closed" } satisfies HostOutcome)
    }
    progress.connected = true
    if (answer._tag === "Silent") progress.silent.push(unitId)
    if (answer._tag === "NoTarget") progress.gateway = true
    if (answer._tag === "Found") {
      progress.units.push(answer.unit)
      if (auto) break
    }
    // A gateway answers for unit 1: 255 and 0 are not where its devices are.
    if (auto && progress.gateway) break
  }
  return hostOf(target, progress)
}, Effect.scoped)

/**
 * The longest one address may take: each request's slot is the scan's to give, so only the connection and the
 * answers count, two requests per unit id at most, with the gap between them.
 */
const hostDeadline = (request: ModbusScanRequest, options: ModbusScanOptions) => {
  const asks = unitOrder(request.unitIds).length * 2
  const perAsk = Duration.sum(
    Duration.fromInputUnsafe(options.requestTimeout ?? "1 second"),
    Duration.fromInputUnsafe(REQUEST_GAP)
  )
  return Duration.sum(
    Duration.sum(Duration.fromInputUnsafe(options.connectTimeout ?? "1 second"), Duration.times(perAsk, asks)),
    // Every slot of the scan before this address's last request, at the scan's rate.
    Duration.millis(((request.targets.length * asks) / (request.rate ?? DEFAULT_RATE)) * 1000 + 1000)
  )
}

/** Scans the addresses of `request`, read-only and at most `rate` requests a second. */
export const scanModbus = Effect.fn("scanModbus")(function* (
  request: ModbusScanRequest,
  options: ModbusScanOptions = {}
) {
  const rate = request.rate ?? DEFAULT_RATE
  const interval = Duration.millis(1000 / rate)
  // One slot at a time, each held for the interval: requests start at most `rate` a second.
  const limiter = yield* Semaphore.make(1)
  const slot = Semaphore.withPermit(limiter)(Effect.sleep(interval))
  const deadline = hostDeadline(request, options)
  let done = 0
  const outcomes = yield* Effect.forEach(
    request.targets,
    (target) => {
      const progress: HostProgress = { units: [], silent: [], gateway: false, opened: false, connected: false }
      return scanTarget(target, request, options, slot, progress).pipe(
        // A hung peer ends the address, not the scan; what it answered until then is kept.
        Effect.timeoutOrElse({
          duration: deadline,
          orElse: () =>
            Effect.succeed(
              progress.opened ? hostOf(target, progress, { timedOut: true }) : ({ _tag: "Closed" } as const)
            )
        }),
        Effect.tap(() =>
          Effect.suspend(() => {
            done++
            return options.onDone?.(done, request.targets.length) ?? Effect.void
          })
        )
      )
    },
    { concurrency: CONCURRENCY }
  )
  const ports = new Set(request.targets.map((target) => target.port))
  const report: ModbusScanReport = {
    range: request.range,
    port: ports.size === 1 ? [...ports][0] : undefined,
    askedPort: request.askedPort ?? MODBUS_PORT,
    unitIds: request.unitIds ?? "auto",
    rate,
    scanned: request.targets.length,
    hosts: outcomes.flatMap((outcome) => (outcome._tag === "Host" ? [outcome.host] : [])),
    notModbus: outcomes.flatMap((outcome) => (outcome._tag === "NotModbus" ? [outcome.notModbus] : []))
  }
  return report
})

/** Every unit found, address by address. */
export const foundUnits = (report: ModbusScanReport) => report.hosts.flatMap((host) => host.units)

/** A unit's device name in the draft: its address, with the port when it is not 502, and its unit id. */
export const deviceName = (unit: FoundUnit) =>
  `Modbus ${unit.port === MODBUS_PORT ? unit.host : endpointText(unit)} unit ${unit.unitId}`

/** The placeholder point's name: the register it answered with, or a point still to name. */
const pointName = (unit: FoundUnit) =>
  unit.table === undefined ? "Point 1" : `${unit.table === "holding" ? "Holding" : "Input"} register 0`

/** The points list columns a Modbus draft fills (PointsSchema.ts), in the schema's order. */
export const modbusDraftColumns = ["device", "point", "host", "port", "unit_id", "register", "table", "type"] as const

/** One row per unit found; a unit that refused both reads has no register yet, to fill in from its datasheet. */
export const modbusDraftRows = (units: ReadonlyArray<FoundUnit>) =>
  units.map((unit) => [
    deviceName(unit),
    pointName(unit),
    unit.host,
    String(unit.port),
    String(unit.unitId),
    unit.table === undefined ? "" : "0",
    unit.table ?? "",
    unit.table === undefined ? "" : "uint16"
  ])

/** The draft as a points list. */
export const modbusDraftPointsList = (units: ReadonlyArray<FoundUnit>) =>
  toCsv([modbusDraftColumns, ...modbusDraftRows(units)])

/** The row of a unit as `--json` gives it, in the points list's column names. */
const rowOf = (unit: FoundUnit) => {
  const [row = []] = modbusDraftRows([unit])
  return Object.fromEntries(modbusDraftColumns.map((column, index) => [column, row[index] ?? ""]))
}

/** How a unit answered, in a few words. */
const answerText = (unit: FoundUnit) => {
  const refused = unit.exceptionCode === undefined ? "" : `holding register 0 refused (exception ${unit.exceptionCode})`
  if (unit.table === "holding") return `holding register 0 = ${unit.value}`
  if (unit.table === "input") return `${refused}, input register 0 = ${unit.value}`
  return `answers, ${refused}`
}

/** Unit ids as `--unit-ids` takes them, runs of ids as first-last: 1-247, 1,3,5-9. */
export const unitIdsText = (ids: ReadonlyArray<number>) => {
  const parts: Array<string> = []
  let index = 0
  while (index < ids.length) {
    const first = ids[index] ?? 0
    let last = first
    while (ids[index + 1] === last + 1) {
      last++
      index++
    }
    parts.push(first === last ? `${first}` : last === first + 1 ? `${first},${last}` : `${first}-${last}`)
    index++
  }
  return parts.join(",")
}

/** The command that scans again with what was asked (range, port, unit ids, rate), plus `extra`. */
export const scanCommand = (
  report: Pick<ModbusScanReport, "range" | "askedPort" | "unitIds" | "rate">,
  extra: string,
  cli = "ot-gateway"
) =>
  [
    `${cli} discover modbus ${shellArgument(report.range)}`,
    report.askedPort === MODBUS_PORT ? "" : ` --port ${report.askedPort}`,
    report.unitIds === "auto" ? "" : ` --unit-ids ${unitIdsText(report.unitIds)}`,
    report.rate === DEFAULT_RATE ? "" : ` --rate ${report.rate}`,
    extra
  ].join("")

/** What to look at next for an address: why it has no unit, or what to keep in mind about the ones it has. */
const hostHint = (host: ScannedHost, report: ModbusScanReport) => {
  const auto = report.unitIds === "auto"
  const asked = auto ? "1" : unitIdsText(report.unitIds)
  if (host.dropped) {
    return "takes the connection, then closes it before answering: a device that takes one connection at a time does that while a gateway or another client polls it; stop that one and scan again"
  }
  if (host.timedOut) {
    return `the scan's time for this address ran out${host.units.length > 0 ? " with the units above found" : ""}: scan it alone, with fewer unit ids at a time`
  }
  if (host.anyUnitId) {
    return "every unit id asked answered alike: one device that ignores the unit id answers on any, so keep one of its rows; meters behind a gateway can answer alike too"
  }
  if (host.units.length > 0) return undefined
  if (host.gateway) {
    return auto
      ? `a Modbus gateway: no device behind it answers on unit id ${asked}; ask its units with --unit-ids 1-247`
      : `a Modbus gateway: no device behind it answers on unit ids ${asked}; check the meters' Modbus addresses and the gateway's serial settings`
  }
  return auto
    ? "takes connections but no unit id of 1, 255 and 0 answered in time; a gateway in front of RS-485 meters needs --unit-ids 1-247, or it is not a Modbus device"
    : `takes connections but no unit id of ${asked} answered in time: is it a Modbus device on this port?`
}

/** What to run after a scan without `--points-list`: write the list, or ask a gateway's unit ids. */
export const scanNext = (report: ModbusScanReport, options: Pick<PointsListOptions, "command"> = {}) => {
  if (foundUnits(report).length > 0) return scanCommand(report, " --points-list modbus.csv", options.command)
  const answering = report.hosts.find((host) => host.gateway) ?? report.hosts.find((host) => !host.dropped)
  return report.unitIds === "auto" && answering !== undefined
    ? scanCommand(report, " --unit-ids 1-247", options.command)
    : undefined
}

/** What `discover modbus` prints: each device found, one line each, then what else answered and what next. */
export const formatScan = (report: ModbusScanReport, options: Pick<PointsListOptions, "command"> = {}) => {
  const units = foundUnits(report)
  const lines: Array<string> = [
    `${plural(units.length, "Modbus unit")} found on ${plural(report.scanned, "address", "addresses")}${units.length > 0 ? ":" : ""}`
  ]
  for (const host of report.hosts) {
    const endpoint = endpointText(host)
    for (const unit of host.units) {
      lines.push(`  ${endpoint.padEnd(21)} unit ${String(unit.unitId).padEnd(4)} ${answerText(unit)}`)
    }
    const hint = hostHint(host, report)
    if (hint !== undefined) lines.push(`  ${endpoint.padEnd(21)} ${hint}`)
  }
  for (const each of report.notModbus) {
    lines.push(`  ${endpointText(each).padEnd(21)} answers, but not as Modbus TCP: ${each.message}`)
  }
  const next = scanNext(report, options)
  if (units.length > 0) {
    lines.push(
      "",
      "--points-list writes each unit as a row with a placeholder point (register 0 as uint16), to replace with the datasheet's registers; ot-gateway probe <host> <register> shows how one reads."
    )
  }
  if (next !== undefined) lines.push(`next: ${next}`)
  return lines.join("\n")
}

/** What `discover modbus --json` prints: the scan, each unit with its draft row, and what to run next. */
export const scanJson = (report: ModbusScanReport, options: Pick<PointsListOptions, "command"> = {}) => {
  const next = scanNext(report, options)
  return {
    ok: true as const,
    range: report.range,
    port: report.port ?? null,
    unitIds: report.unitIds,
    rate: report.rate,
    scanned: report.scanned,
    devices: foundUnits(report).map((unit) => ({
      endpoint: endpointText(unit),
      host: unit.host,
      port: unit.port,
      unitId: unit.unitId,
      table: unit.table ?? null,
      value: unit.value ?? null,
      exceptionCode: unit.exceptionCode ?? null,
      row: rowOf(unit)
    })),
    hosts: report.hosts.map((host) => ({
      endpoint: endpointText(host),
      gateway: host.gateway,
      units: host.units.map((unit) => unit.unitId),
      silent: host.silent,
      anyUnitId: host.anyUnitId,
      dropped: host.dropped,
      timedOut: host.timedOut,
      hint: hostHint(host, report) ?? null
    })),
    notModbus: report.notModbus.map((each) => ({ endpoint: endpointText(each), message: each.message })),
    next: next ?? null
  }
}

/** The failure for a scan that found no unit: what answered, and what to try. */
export const nothingFound = (report: ModbusScanReport, options: Pick<PointsListOptions, "command"> = {}) => {
  const listening = report.hosts.length + report.notModbus.length
  const next = scanNext(report, options)
  return new ModbusDiscoverError({
    code: "none-found",
    message:
      listening === 0
        ? `no Modbus device found: nothing took a connection on ${report.port === undefined ? "the ports asked" : `port ${report.port}`} at the ${plural(report.scanned, "address", "addresses")} of ${report.range}`
        : `no Modbus unit answered on ${report.range}: ${plural(listening, "address", "addresses")} took a connection, none answered as a unit`,
    hint:
      next ??
      report.hosts.map((host) => hostHint(host, report)).find((hint) => hint !== undefined) ??
      (report.notModbus.length > 0
        ? "what answers there is not Modbus TCP: check the port (--port) on the device's datasheet"
        : "check the range and the port (Modbus TCP is 502 unless the device says otherwise; --port), that this machine reaches that network, and that no firewall drops it")
  })
}

const failure = (code: string, message: string, hint: string) => new ModbusDiscoverError({ code, message, hint })

/**
 * `discover modbus --points-list <file>`: the units found, written as a points list to fill in and import, as
 * `discover --points-list` writes BACnet devices: an existing file only with `append` (rows it has are skipped),
 * none written when nothing was found, the file replaced in one step.
 */
export const scanToPointsList = Effect.fn("scanToPointsList")(function* (
  report: ModbusScanReport,
  path: string,
  options: PointsListOptions = {}
) {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(path)
  if (exists && options.append !== true) {
    return yield* failure(
      "points-list-exists",
      `${path} exists. Nothing was written.`,
      `add --append to add the units found to it, or give another file name`
    )
  }
  const existing = exists ? yield* fs.readFileString(path) : undefined
  if (existing !== undefined && isEde(existing)) {
    return yield* failure(
      "points-list-ede",
      `${path} is an EDE file. Nothing was written.`,
      `turn it into a points list first (ot-gateway points from-ede ${shellArgument(path)} > points.csv) and add to that`
    )
  }
  const units = foundUnits(report)
  if (units.length === 0) return yield* nothingFound(report, options)
  const rows = modbusDraftRows(units)
  const next = pointsListNext(path, options)
  const unnamed = units.filter((unit) => unit.table === undefined).length
  const fill =
    unnamed > 0
      ? `fill in the register, table and type of the ${plural(unnamed, "row")} without one, from the datasheet`
      : "replace each placeholder point with the datasheet's registers"
  if (existing === undefined) {
    yield* writeAtomically(path, modbusDraftPointsList(units))
    const written: PointsListWritten = {
      path,
      devices: units.length,
      points: rows.length,
      added: rows.length,
      skipped: 0,
      appended: false,
      next
    }
    return { written, message: `wrote ${plural(rows.length, "unit")} to ${path}. ${capitalize(fill)}, then: ${next}` }
  }
  const merged = appendToPointsList(existing, modbusDraftColumns, rows)
  if (Result.isFailure(merged)) {
    return yield* failure("points-list-invalid", `${path}: ${merged.failure}. Nothing was written.`, "check the file")
  }
  const { added, skipped } = merged.success
  if (added > 0) yield* writeAtomically(path, merged.success.text)
  const written: PointsListWritten = {
    path,
    devices: units.length,
    points: rows.length,
    added,
    skipped,
    appended: true,
    ...(added > 0 ? { next } : {})
  }
  return {
    written,
    message:
      `added ${plural(added, "unit")}, skipped ${skipped} already in the list, to ${path}` +
      (added > 0 ? `. ${capitalize(fill)}, then: ${next}` : "; it was left as it was")
  }
})

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
