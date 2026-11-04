/**
 * The Modbus TCP driver: a planned set of block reads over one client.
 *
 * Client failures become `DriverError`s by tag. A device that refuses one
 * block (a Modbus exception, usually a misconfigured address) costs only that
 * block's points, and the other blocks still publish. A refusal is counted
 * every time but logged only when a block starts being refused and when it
 * reads again, since a misconfigured address is refused on every cycle. A
 * transient refusal (busy, gateway) is retried a couple of times within the
 * read; a permanent one (illegal function, address or value) is not. The read
 * fails when every block is refused, or on any timeout or connection
 * problem, since the device is unreachable then.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { DriverError, driverRefusals } from "@plenum/core"
import type { Driver, ModbusDevice, ModbusPoint, Network, Reading, WriteValue } from "@plenum/core"
import { Clock, Duration, Effect, Metric, Schedule } from "effect"
import { makeModbusClient } from "./Client.ts"
import type { ModbusClient, ModbusClientError } from "./Client.ts"
import { encodeValue, exceptionName, FunctionCode, isTransientException } from "./Frame.ts"
import type { ModbusException, WriteRequest } from "./Frame.ts"
import { planReads, valueFromBits, valueFromRegisters } from "./Plan.ts"
import type { PlanOptions, ReadBlock } from "./Plan.ts"

export interface ModbusDriverOptions extends PlanOptions {
  /** Time allowed to open the TCP connection (default 3 s). */
  readonly connectTimeout?: Duration.Input
  /** Time allowed for one request (default 2 s). */
  readonly requestTimeout?: Duration.Input
  /** Connect through this network instead of Node's (a simulation). */
  readonly network?: Pick<Network, "tcp">
}

/**
 * Retry a block the device is busy with, or that a gateway could not reach,
 * within the same read. Other failures are left to the pipeline's retry.
 */
const transientRetry = {
  schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered),
  times: 2,
  while: (error: ModbusClientError) => error._tag === "ModbusException" && isTransientException(error.exceptionCode)
}

/** Read one block and pick its points' values out of the result. */
const readBlock = Effect.fnUntraced(function* (client: ModbusClient, block: ReadBlock) {
  const { address, quantity, points } = block
  switch (block.functionCode) {
    case FunctionCode.ReadCoils:
    case FunctionCode.ReadDiscreteInputs: {
      const bits = yield* client.readBits(block.functionCode, address, quantity)
      const timestamp = yield* Clock.currentTimeMillis
      return points.map((point): Reading => ({
        pointId: point.id,
        value: valueFromBits(point, address, bits),
        timestamp
      }))
    }
    case FunctionCode.ReadHoldingRegisters:
    case FunctionCode.ReadInputRegisters: {
      const registers = yield* client.readRegisters(block.functionCode, address, quantity)
      const timestamp = yield* Clock.currentTimeMillis
      return points.map((point): Reading => ({
        pointId: point.id,
        value: valueFromRegisters(point, address, registers),
        timestamp
      }))
    }
  }
})

/** Log annotations naming a block and its points. */
const blockAnnotations = (block: ReadBlock) => ({
  table: block.table,
  address: block.address,
  quantity: block.quantity,
  points: block.points.map((point) => point.id).join(",")
})

/** A driver over an existing client. `makeModbusDriver` builds the client; tests can pass their own. */
export const makeModbusDriverFromClient = (
  device: ModbusDevice,
  client: ModbusClient,
  options: PlanOptions = {}
): Driver => {
  const blocks = planReads(device.points, {
    maxRegisters: device.maxRegistersPerRead,
    maxBits: device.maxBitsPerRead,
    ...options
  })
  const fail = (reason: DriverError["reason"], message: string) =>
    Effect.fail(new DriverError({ device: device.id, reason, message }))

  /** The blocks the device refuses right now, with the exception it gave. */
  const refusedBlocks = new Map<ReadBlock, string>()

  const recordRefusal = Effect.fnUntraced(function* (block: ReadBlock, error: ModbusException) {
    const reason = exceptionName(error.exceptionCode)
    yield* Metric.update(Metric.withAttributes(driverRefusals, { exception: reason }), 1)
    if (refusedBlocks.get(block) === reason) return reason
    refusedBlocks.set(block, reason)
    yield* Effect.logWarning("device refused a read; counting further refusals without logging them").pipe(
      Effect.annotateLogs({ reason, ...blockAnnotations(block) })
    )
    return reason
  })

  const recordAnswer = (block: ReadBlock) =>
    refusedBlocks.delete(block)
      ? Effect.logInfo("device answers a block it refused before").pipe(Effect.annotateLogs(blockAnnotations(block)))
      : Effect.void

  const readAll = Effect.gen(function* () {
    const readings: Array<Reading> = []
    const refusals: Array<string> = []
    for (const block of blocks) {
      const blockReadings = yield* readBlock(client, block).pipe(
        Effect.retry(transientRetry),
        Effect.tap(() => recordAnswer(block)),
        Effect.catchTag("ModbusException", (error) =>
          recordRefusal(block, error).pipe(
            Effect.map((reason) => {
              refusals.push(reason)
              return []
            })
          )
        )
      )
      readings.push(...blockReadings)
    }
    yield* Effect.annotateCurrentSpan({ "plenum.requests": blocks.length, "plenum.refused": refusals.length })
    if (blocks.length > 0 && refusals.length === blocks.length) {
      return yield* new DriverError({
        device: device.id,
        reason: "protocol",
        message: `device refused every read (${[...new Set(refusals)].join(", ")})`
      })
    }
    return readings
  }).pipe(
    Effect.catchTags({
      ModbusTimeout: (error) => fail("timeout", error.message),
      ModbusConnectionError: (error) => fail("connection", error.message),
      ModbusFrameError: (error) => fail("invalid-response", error.message)
    })
  )

  return {
    deviceId: device.id,
    points: device.points,
    readAll,
    write: (pointId, value) =>
      Effect.gen(function* () {
        const point = device.points.find((candidate) => candidate.id === pointId)
        if (point === undefined) return yield* fail("configuration", `no point ${pointId}`)
        const request = writeRequestFor(point, value)
        if (typeof request === "string") return yield* fail("configuration", `${pointId}: ${request}`)
        yield* client.write(request)
      }).pipe(
        Effect.catchTags({
          ModbusException: (error) =>
            fail("protocol", `device refused the write: ${exceptionName(error.exceptionCode)}`),
          ModbusTimeout: (error) => fail("timeout", error.message),
          ModbusConnectionError: (error) => fail("connection", error.message),
          ModbusFrameError: (error) => fail("invalid-response", error.message)
        })
      )
  }
}

/**
 * Integer ranges of the register types; floats take any finite number. A
 * 64-bit integer is written exactly up to ±2^53, as far as a number reaches.
 */
const integerRange = {
  int16: [-32_768, 32_767],
  uint16: [0, 65_535],
  int32: [-(2 ** 31), 2 ** 31 - 1],
  uint32: [0, 2 ** 32 - 1],
  int64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  uint64: [0, Number.MAX_SAFE_INTEGER]
} as const

/**
 * The request that writes `value` to `point`, or why it cannot: a coil takes
 * FC 05; a one-register holding value FC 06; a 32-bit one FC 16, so both
 * halves change together. Integers must be whole and fit their type: a
 * truncated or wrapped value would be a different command than the one given.
 */
export const writeRequestFor = (point: ModbusPoint, value: WriteValue): WriteRequest | string => {
  if (value === null) return "Modbus has nothing to release; write a value"
  if (point.bit !== undefined) return "a bit of a register cannot be written"
  if (point.table === "coil") {
    if (typeof value !== "boolean") return "a coil takes true or false"
    return { functionCode: FunctionCode.WriteSingleCoil, address: point.address, value }
  }
  if (point.table !== "holding")
    return `${point.table} ${point.table === "input" ? "registers" : "inputs"} are read-only`
  if (point.dataType === "bool") {
    if (typeof value !== "boolean") return "a bool register takes true or false"
    return { functionCode: FunctionCode.WriteSingleRegister, address: point.address, value: value ? 1 : 0 }
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return `a ${point.dataType} takes a finite number`
  if (point.dataType !== "float32" && point.dataType !== "float64") {
    const [minimum, maximum] = integerRange[point.dataType]
    if (!Number.isInteger(value)) return `${value} is not a whole number, as a ${point.dataType} needs`
    if (value < minimum || value > maximum) return `${value} does not fit a ${point.dataType}`
  }
  const registers = encodeValue(value, point.dataType, point.byteOrder)
  const [first] = registers
  return registers.length === 1 && first !== undefined
    ? { functionCode: FunctionCode.WriteSingleRegister, address: point.address, value: first }
    : { functionCode: FunctionCode.WriteMultipleRegisters, address: point.address, values: registers }
}

/**
 * Build the driver for a `modbus-tcp` device. The TCP connection opens on the
 * first read and closes with the scope.
 */
export const makeModbusDriver = Effect.fn("makeModbusDriver")(function* (
  device: ModbusDevice,
  options: ModbusDriverOptions = {}
) {
  const target = { host: device.host, port: device.port, openTimeout: options.connectTimeout ?? "3 seconds" }
  const socket = yield* options.network ? options.network.tcp(target) : NodeSocket.makeNet(target)
  const client = yield* makeModbusClient(socket, {
    unitId: device.unitId,
    requestGap: Duration.millis(device.requestGapMs),
    ...(options.requestTimeout === undefined ? {} : { requestTimeout: options.requestTimeout })
  })
  return makeModbusDriverFromClient(device, client, options)
})
