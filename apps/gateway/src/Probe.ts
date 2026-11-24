/**
 * `ot-gateway probe`: read a few Modbus registers once and show every way the points list could read them, so a
 * person or an agent setting up a device from its datasheet sees which type and byte order gives the sensible
 * number before writing the row.
 *
 * Read-only, always: one read request (FC 01–04), never a write. The values come from the driver's own decoding
 * (`valueFromRegisters`, the function a polled point goes through), so what probe shows for "float32, CDAB" is what
 * a point with those settings would publish before its scaling.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { ByteOrder, DataType, type ModbusPoint, type Network, registerWidth } from "@ot-gateway/core"
import {
  endpointText,
  exceptionName,
  FunctionCode,
  makeModbusClient,
  maxReadQuantity,
  valueFromBits,
  valueFromRegisters
} from "@ot-gateway/modbus"
import { Duration, Effect, Schema } from "effect"
import { csvLine } from "./Csv.ts"

export type ProbeTable = ModbusPoint["table"]

export const probeTables = ["holding", "input", "coil", "discrete"] as const satisfies ReadonlyArray<ProbeTable>

/** Why a probe failed, for `--json` and for tests: the device's refusal is not the same as no answer. */
export const ProbeFailure = Schema.Literals(["usage", "unreachable", "timeout", "exception", "bad_response"])
export type ProbeFailure = typeof ProbeFailure.Type

/** A probe that read nothing: a mistake in what was asked, a device that could not be reached or refused. */
export class ProbeError extends Schema.TaggedError<ProbeError>()("ProbeError", {
  reason: ProbeFailure,
  message: Schema.String,
  /** The Modbus exception code (spec §7) when the device refused the read. */
  exceptionCode: Schema.optionalKey(Schema.Int)
}) {}

export interface ProbeRequest {
  readonly host: string
  readonly port: number
  readonly unitId: number
  readonly table: ProbeTable
  /** 0-based, as the points list's `register` column. */
  readonly address: number
  readonly count: number
}

export interface ProbeOptions {
  /** How the device is reached; Node's TCP when left out (tests pass an in-memory network). */
  readonly network?: Network
  /** Time allowed to open the connection (default 3 s). */
  readonly connectTimeout?: Duration.Input
  /** Time allowed for the answer once connected (default 3 s: serial gateways in front of RS-485 meters are slow). */
  readonly requestTimeout?: Duration.Input
}

/** Why a value is not a reading to trust. NaN and infinite are what the gateway counts as a failed read. */
export type ValueFlag = "nan" | "infinite" | "implausible" | "imprecise"

export interface Interpretation {
  readonly type: DataType
  readonly byteOrder: ByteOrder
  readonly value: number | boolean
  readonly flag?: ValueFlag
}

export interface ProbeReport {
  readonly host: string
  readonly port: number
  readonly unitId: number
  readonly table: ProbeTable
  readonly address: number
  readonly count: number
  /** The registers read (holding, input), from `address` on. */
  readonly registers?: ReadonlyArray<number>
  /** The bits read (coil, discrete), from `address` on. */
  readonly bits?: ReadonlyArray<boolean>
  readonly interpretations: ReadonlyArray<Interpretation>
  /** The likeliest reading, for the example row: a guess to check against the datasheet or the device's display. */
  readonly suggestion?: Interpretation
  /** What to keep in mind about this read (a datasheet's 40101, registers that are all 0). */
  readonly notes: ReadonlyArray<string>
}

const DEFAULT_PORT = 502

/** `host`, `host:port`, `[v6]:port` or a bare IPv6 address, as a device's endpoint. */
export const parseEndpoint = (text: string): { readonly host: string; readonly port: number } | undefined => {
  const trimmed = text.trim()
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed)
  const [host, portText] = bracketed
    ? [bracketed[1], bracketed[2]]
    : trimmed.split(":").length === 2
      ? trimmed.split(":")
      : [trimmed, undefined]
  if (host === undefined || host === "" || /[\s/]/.test(host)) return undefined
  if (portText === undefined) return { host, port: DEFAULT_PORT }
  const port = Number(portText)
  return /^\d+$/.test(portText) && port >= 1 && port <= 65535 ? { host, port } : undefined
}

const isBitTable = (table: ProbeTable) => table === "coil" || table === "discrete"

/** How many addresses a probe reads when `--count` is left out: enough for a 32-bit value, or one bit. */
export const defaultCount = (table: ProbeTable) => (isBitTable(table) ? 1 : 2)

const functionCodeOf = {
  holding: FunctionCode.ReadHoldingRegisters,
  input: FunctionCode.ReadInputRegisters,
  coil: FunctionCode.ReadCoils,
  discrete: FunctionCode.ReadDiscreteInputs
} as const

/**
 * A datasheet address in the 1-based "Modicon" numbering (30001–39999 input, 40001–49999 holding, and the six-digit
 * 300001/400001 forms): the register the points list means by it, 0-based, when `address` looks like one.
 */
export const modiconRegister = (
  address: number
): { readonly table: ProbeTable; readonly register: number } | undefined => {
  if (address >= 40001 && address <= 49999) return { table: "holding", register: address - 40001 }
  if (address >= 30001 && address <= 39999) return { table: "input", register: address - 30001 }
  if (address >= 400001 && address <= 465536) return { table: "holding", register: address - 400001 }
  if (address >= 300001 && address <= 365536) return { table: "input", register: address - 300001 }
  return undefined
}

const modiconHint = (address: number) => {
  const meant = modiconRegister(address)
  return meant === undefined
    ? undefined
    : `a datasheet's ${address} is usually ${meant.table} register ${meant.register}: probe reads 0-based addresses, as the points list's register column (--table ${meant.table} ${meant.register})`
}

/** A request's mistakes, before anything is sent. */
export const checkRequest = (request: ProbeRequest): ProbeError | undefined => {
  const usage = (message: string) => new ProbeError({ reason: "usage", message })
  if (!Number.isInteger(request.unitId) || request.unitId < 0 || request.unitId > 255) {
    return usage(`--unit-id takes 0 to 255, not ${request.unitId}`)
  }
  const limit = maxReadQuantity(functionCodeOf[request.table])
  if (!Number.isInteger(request.count) || request.count < 1 || request.count > limit) {
    return usage(`--count takes 1 to ${limit} for the ${request.table} table, not ${request.count}`)
  }
  if (!Number.isInteger(request.address) || request.address < 0 || request.address > 65535) {
    const hint = modiconHint(request.address)
    return usage(`the address is 0 to 65535, not ${request.address}${hint === undefined ? "" : `; ${hint}`}`)
  }
  if (request.address + request.count - 1 > 65535) {
    return usage(`${request.count} addresses from ${request.address} run past 65535, the last one`)
  }
  return undefined
}

/** The byte orders that differ for a type: a single register is only byte-swapped (Point.ts, `ByteOrder`). */
const ordersFor = (type: DataType): ReadonlyArray<ByteOrder> =>
  registerWidth(type) === 1 ? ["ABCD", "BADC"] : ByteOrder.literals

/** Above this a float is not a field reading; below the lower one (other than 0) it is the wrong word order's dust. */
const implausibleAbove = { float32: 1e10, float64: 1e15 } as const
const implausibleBelow = 1e-4

/** Why `value`, read as `type`, is not a value to trust; undefined when it reads as a plausible number. */
export const flagOf = (type: DataType, value: number | boolean): ValueFlag | undefined => {
  if (typeof value === "boolean") return undefined
  if (Number.isNaN(value)) return "nan"
  if (!Number.isFinite(value)) return "infinite"
  if (type === "float32" || type === "float64") {
    const magnitude = Math.abs(value)
    if (magnitude !== 0 && (magnitude < implausibleBelow || magnitude > implausibleAbove[type])) return "implausible"
  }
  if ((type === "int64" || type === "uint64") && !Number.isSafeInteger(value)) return "imprecise"
  return undefined
}

/** A point that reads `type` in `byteOrder` at `address`: what the driver would decode. */
const pointOf = (table: ProbeTable, address: number, type: DataType, byteOrder: ByteOrder): ModbusPoint => ({
  id: "probe",
  name: "probe",
  writable: false,
  table,
  address,
  dataType: type,
  byteOrder
})

const interpretation = (type: DataType, byteOrder: ByteOrder, value: number | boolean): Interpretation => {
  const flag = flagOf(type, value)
  return flag === undefined ? { type, byteOrder, value } : { type, byteOrder, value, flag }
}

/**
 * Every type and byte order the registers from `address` can be read as, the bool type left out (a register other
 * than 0 is true), each value as a point with those settings decodes it. Types wider than `registers` are left out.
 */
export const interpretRegisters = (
  table: ProbeTable,
  address: number,
  registers: ReadonlyArray<number>
): ReadonlyArray<Interpretation> =>
  DataType.literals
    .filter((type) => type !== "bool" && registerWidth(type) <= registers.length)
    .flatMap((type) =>
      ordersFor(type).map((byteOrder) =>
        interpretation(
          type,
          byteOrder,
          valueFromRegisters(pointOf(table, address, type, byteOrder), address, registers)
        )
      )
    )

const isFloat = (type: DataType) => type === "float32" || type === "float64"

/**
 * The reading the example row takes, at the widest width read (64, 32 or 16 bits), falling back to a narrower one
 * when nothing there reads sensibly. A float that reads sensibly wins: a wrong word or byte order turns a float into
 * NaN, dust or something astronomical, while an integer read as a float almost always does the same. Floats keep
 * the order of preference ABCD, CDAB, BADC, DCBA (the default first, a swapped word next, as devices do). Integers
 * are read in ABCD or CDAB only, and the smallest magnitude wins: a word in the wrong half multiplies by 65536.
 * Unsigned wins a tie, since a counter is more common than a negative value. A guess, which the output says.
 */
export const suggest = (interpretations: ReadonlyArray<Interpretation>, count: number): Interpretation | undefined => {
  const widths = ([4, 2, 1] as const).filter((width) => width <= count)
  for (const width of widths) {
    const atWidth = interpretations.filter(
      (each) => registerWidth(each.type) === width && each.flag === undefined && typeof each.value === "number"
    )
    const float = atWidth.find((each) => isFloat(each.type))
    if (float !== undefined) return float
    const integers = atWidth.filter(
      (each) => !isFloat(each.type) && (each.byteOrder === "ABCD" || (width > 1 && each.byteOrder === "CDAB"))
    )
    const magnitude = (each: Interpretation) => Math.abs(Number(each.value))
    const best = integers.reduce<Interpretation | undefined>((chosen, each) => {
      if (chosen === undefined) return each
      if (magnitude(each) < magnitude(chosen)) return each
      if (magnitude(each) === magnitude(chosen) && each.type.startsWith("u") && !chosen.type.startsWith("u"))
        return each
      return chosen
    }, undefined)
    if (best !== undefined) return best
  }
  return undefined
}

/** What to keep in mind about the registers read, beyond their values. */
const registerNotes = (registers: ReadonlyArray<number>): ReadonlyArray<string> => {
  if (registers.length === 0) return []
  if (registers.every((register) => register === 0)) {
    return [
      "every register read is 0, so every type reads 0 and the type and byte order cannot be told apart: probe again while the value is not 0"
    ]
  }
  const [first, ...rest] = registers
  if (
    registers.every((register) => register === 0xffff) ||
    (first === 0x8000 && rest.every((register) => register === 0))
  ) {
    return [
      "0xFFFF or 0x8000 is what many devices send for a value they do not have (not available, sensor missing): check the register on the datasheet"
    ]
  }
  return []
}

/** One read, once: the registers or bits from `address`, and what they read as. */
export const probe = Effect.fn("probe")(function* (request: ProbeRequest, options: ProbeOptions = {}) {
  const mistake = checkRequest(request)
  if (mistake !== undefined) return yield* mistake
  const endpoint = endpointText(request)
  const connectTimeout = options.connectTimeout ?? "3 seconds"
  const requestTimeout = options.requestTimeout ?? "3 seconds"
  const target = { host: request.host, port: request.port, openTimeout: connectTimeout }
  const socket = yield* options.network ? options.network.tcp(target) : NodeSocket.makeNet(target)
  const client = yield* makeModbusClient(socket, { unitId: request.unitId, endpoint, requestTimeout })
  const addressHint = modiconHint(request.address)
  const notes = addressHint === undefined ? [] : [addressHint]
  const base = {
    host: request.host,
    port: request.port,
    unitId: request.unitId,
    table: request.table,
    address: request.address,
    count: request.count
  }
  const describe = describeFailure(request, endpoint)
  // The deadline covers the whole probe (connecting, the request, its answer), not only each step's own timeout.
  const deadline = Duration.sum(Duration.fromInputUnsafe(connectTimeout), Duration.fromInputUnsafe(requestTimeout))
  const within = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: Duration.sum(deadline, Duration.seconds(1)),
        orElse: () =>
          Effect.fail(
            new ProbeError({ reason: "timeout", message: `${endpoint} unit ${request.unitId} did not answer in time` })
          )
      })
    )
  if (request.table === "coil" || request.table === "discrete") {
    const bits = yield* client
      .readBits(functionCodeOf[request.table], request.address, request.count)
      .pipe(Effect.catchTags(describe), within)
    const value = valueFromBits(pointOf(request.table, request.address, "bool", "ABCD"), request.address, bits)
    const read = interpretation("bool", "ABCD", value)
    const report: ProbeReport = { ...base, bits, interpretations: [read], suggestion: read, notes }
    return report
  }
  const registers = yield* client
    .readRegisters(functionCodeOf[request.table], request.address, request.count)
    .pipe(Effect.catchTags(describe), within)
  const interpretations = interpretRegisters(request.table, request.address, registers)
  const suggestion = suggest(interpretations, registers.length)
  const report: ProbeReport = {
    ...base,
    registers,
    interpretations,
    ...(suggestion === undefined ? {} : { suggestion }),
    notes: [...notes, ...registerNotes(registers)]
  }
  return report
}, Effect.scoped)

/** What a refused read means, by exception code (spec §7), and what to try. */
const exceptionAdvice = (request: ProbeRequest, code: number): string => {
  const last = request.address + request.count - 1
  const range = request.count === 1 ? `${request.address}` : `${request.address} to ${last}`
  switch (code) {
    case 0x01:
      return `it does not serve the ${request.table} table: try --table ${request.table === "holding" ? "input" : "holding"}`
    case 0x02: {
      const hint = modiconHint(request.address)
      const what = `it has no ${request.table} ${isBitTable(request.table) ? "address" : "register"} ${range}`
      return hint === undefined
        ? `${what}: check the address on the datasheet (0-based here: a datasheet that counts from 1 means ${Math.max(0, request.address - 1)}), the table, and that --count does not run past the last one`
        : `${what}: ${hint}`
    }
    case 0x03:
      return `it does not read ${request.count} at once: try a smaller --count`
    case 0x04:
      return "the device failed while reading: check it, then try again"
    case 0x05:
    case 0x06:
      return "the device is busy: try again in a moment"
    case 0x0a:
      return "the Modbus gateway has no path to that unit: check --unit-id and the gateway's serial settings"
    case 0x0b:
      return `no device answered behind the Modbus gateway as unit ${request.unitId}: check --unit-id, the wiring and the meter's own Modbus address`
    default:
      return "check the datasheet for this exception code"
  }
}

/** The client's failures as one line each, by tag. */
const describeFailure = (request: ProbeRequest, endpoint: string) => ({
  ModbusConnectionError: (error: { readonly message: string }) =>
    Effect.fail(
      new ProbeError({
        reason: "unreachable",
        message: `cannot reach ${endpoint}: ${error.message}; check the host, the port (Modbus TCP is 502 unless the device says otherwise) and that nothing blocks it`
      })
    ),
  ModbusTimeout: (error: { readonly message: string }) =>
    Effect.fail(
      new ProbeError({
        reason: "timeout",
        message: `${error.message}: check --unit-id (a Modbus gateway in front of RS-485 meters needs the meter's address) and that the device speaks Modbus TCP on that port`
      })
    ),
  ModbusException: (error: { readonly exceptionCode: number }) =>
    Effect.fail(
      new ProbeError({
        reason: "exception",
        exceptionCode: error.exceptionCode,
        message: `${endpoint} unit ${request.unitId} refused the read: ${exceptionName(error.exceptionCode).replaceAll("_", " ")} (exception ${error.exceptionCode}); ${exceptionAdvice(request, error.exceptionCode)}`
      })
    ),
  ModbusFrameError: (error: { readonly message: string }) =>
    Effect.fail(
      new ProbeError({
        reason: "bad_response",
        message: `${endpoint} answered something that is not a Modbus TCP response (${error.message}): is it a Modbus TCP device on that port?`
      })
    )
})

/** A value as the table shows it: NaN and the infinities as words, the rest as JavaScript prints numbers. */
const valueText = (value: number | boolean) => String(value)

const flagText: Readonly<Record<ValueFlag, string>> = {
  nan: "NaN: the gateway counts a failed read",
  infinite: "infinite: the gateway counts a failed read",
  implausible: "implausible: tiny or huge, likely the wrong type or order",
  imprecise: "beyond 2^53: rounded as a number"
}

const hex = (register: number) => `0x${register.toString(16).toUpperCase().padStart(4, "0")}`

/** The points list's columns for a Modbus row, in its own names (`ot-gateway points schema`). */
export const exampleRowColumns = [
  "device",
  "point",
  "host",
  "port",
  "unit_id",
  "register",
  "table",
  "type",
  "byte_order"
] as const

/** The points list's columns for one reading, as `--json` gives them and the example row writes them. */
export const rowFor = (report: ProbeReport, reading: Interpretation) => ({
  host: report.host,
  port: report.port,
  unit_id: report.unitId,
  register: report.address,
  table: report.table,
  type: reading.type,
  // A bit or a single bool has no byte order: the column stays empty.
  ...(reading.type === "bool" ? {} : { byte_order: reading.byteOrder })
})

/** The example row: a header and one line, with placeholders for the device and point names. */
export const exampleRow = (report: ProbeReport, reading: Interpretation) => {
  const columns: Readonly<Record<string, string | number>> = {
    device: "My device",
    point: "My point",
    ...rowFor(report, reading)
  }
  return [csvLine(exampleRowColumns), csvLine(exampleRowColumns.map((column) => columns[column] ?? ""))]
}

/** What `probe` prints: the raw read, every reading of it, and a row to copy. */
export const formatProbeReport = (report: ProbeReport): string => {
  const endpoint = endpointText(report)
  const last = report.address + report.count - 1
  const what = isBitTable(report.table)
    ? report.table === "coil"
      ? "coils"
      : "discrete inputs"
    : `${report.table} registers`
  const header = `${endpoint} unit ${report.unitId}, ${what} ${report.count === 1 ? report.address : `${report.address} to ${last}`} (0-based, as the points list's register column)`
  const lines: Array<string> = [header, ""]
  if (report.bits !== undefined) {
    lines.push("  address  value")
    report.bits.forEach((bit, index) => lines.push(`  ${String(report.address + index).padEnd(9)}${bit}`))
  }
  if (report.registers !== undefined) {
    lines.push("  register  hex     decimal")
    report.registers.forEach((register, index) =>
      lines.push(`  ${String(report.address + index).padEnd(10)}${hex(register).padEnd(8)}${register}`)
    )
    lines.push("")
    const valueWidth = Math.max(5, ...report.interpretations.map((each) => valueText(each.value).length)) + 2
    lines.push(`  ${"type".padEnd(9)}${"byte_order".padEnd(12)}value`)
    for (const each of report.interpretations) {
      const suggested = each === report.suggestion ? "  <- likeliest" : ""
      const flag = each.flag === undefined ? "" : flagText[each.flag]
      lines.push(
        `  ${each.type.padEnd(9)}${each.byteOrder.padEnd(12)}${valueText(each.value).padEnd(valueWidth)}${flag}${suggested}`.trimEnd()
      )
    }
    if (report.registers.length < 4) {
      lines.push(`  (--count 4 adds int64, uint64 and float64)`)
    }
  }
  for (const note of report.notes) lines.push("", `note: ${note}`)
  if (report.suggestion !== undefined) {
    const reading = report.suggestion
    lines.push(
      "",
      isBitTable(report.table)
        ? "As a points list row:"
        : `As a points list row, read as ${reading.type} ${reading.byteOrder} (the likeliest; take the line whose value matches the datasheet or the device's display, and write its type and byte_order):`,
      ...exampleRow(report, reading).map((line) => `  ${line}`)
    )
  }
  if (!isBitTable(report.table)) {
    lines.push(
      "",
      `Nothing sensible? ${report.address > 0 ? `A datasheet that counts registers from 1 means ${report.address - 1}; ` : ""}the other table is --table ${report.table === "holding" ? "input" : "holding"}.`
    )
  }
  return lines.join("\n")
}

/** What `probe --json` prints: the report, NaN and infinities as null with their flag, and each reading's row. */
export const probeJson = (report: ProbeReport) => {
  const reading = (each: Interpretation) => ({
    type: each.type,
    byteOrder: each.byteOrder,
    value: typeof each.value === "number" && !Number.isFinite(each.value) ? null : each.value,
    flag: each.flag ?? null,
    row: rowFor(report, each)
  })
  return {
    ok: true as const,
    endpoint: endpointText(report),
    host: report.host,
    port: report.port,
    unitId: report.unitId,
    table: report.table,
    address: report.address,
    count: report.count,
    ...(report.registers === undefined
      ? {}
      : {
          registers: report.registers.map((value, index) => ({
            address: report.address + index,
            hex: hex(value),
            value
          }))
        }),
    ...(report.bits === undefined
      ? {}
      : { bits: report.bits.map((value, index) => ({ address: report.address + index, value })) }),
    interpretations: report.interpretations.map(reading),
    suggestion: report.suggestion === undefined ? null : reading(report.suggestion),
    notes: report.notes
  }
}
