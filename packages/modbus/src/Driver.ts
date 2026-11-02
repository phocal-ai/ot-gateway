/**
 * The Modbus TCP driver: a planned set of block reads over one client.
 *
 * Client failures become `DriverError`s by tag. A device that refuses one
 * block (a Modbus exception, usually a misconfigured address) costs only that
 * block's points: the refusal is logged and counted, and the other blocks
 * still publish. The read fails when every block is refused, or on any
 * timeout or connection problem, since the device is unreachable then.
 */
import { NodeSocket } from "@effect/platform-node"
import { DriverError } from "@plenum/core"
import type { Driver, ModbusDevice, Reading } from "@plenum/core"
import { Clock, Effect } from "effect"
import type { Duration } from "effect"
import { makeModbusClient } from "./Client.ts"
import type { ModbusClient } from "./Client.ts"
import { FunctionCode } from "./Frame.ts"
import { planReads, valueFromBits, valueFromRegisters } from "./Plan.ts"
import type { PlanOptions, ReadBlock } from "./Plan.ts"

export interface ModbusDriverOptions extends PlanOptions {
  /** Time allowed to open the TCP connection (default 3 s). */
  readonly connectTimeout?: Duration.Input
  /** Time allowed for one request (default 2 s). */
  readonly requestTimeout?: Duration.Input
}

const exceptionNames: Record<number, string> = {
  1: "illegal function",
  2: "illegal data address",
  3: "illegal data value",
  4: "server device failure",
  6: "server device busy",
  10: "gateway path unavailable",
  11: "gateway target failed to respond"
}

const exceptionName = (code: number) => exceptionNames[code] ?? `exception ${code}`

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

/** A driver over an existing client. `makeModbusDriver` builds the client; tests can pass their own. */
export const makeModbusDriverFromClient = (
  device: ModbusDevice,
  client: ModbusClient,
  options: PlanOptions = {}
): Driver => {
  const blocks = planReads(device.points, options)
  const fail = (reason: DriverError["reason"], message: string) =>
    Effect.fail(new DriverError({ device: device.id, reason, message }))

  const readAll = Effect.gen(function* () {
    const readings: Array<Reading> = []
    const refusals: Array<string> = []
    for (const block of blocks) {
      const blockReadings = yield* readBlock(client, block).pipe(
        Effect.catchTag("ModbusException", (error) => {
          const reason = exceptionName(error.exceptionCode)
          refusals.push(reason)
          return Effect.logWarning("device refused a read").pipe(
            Effect.annotateLogs({
              reason,
              table: block.table,
              address: block.address,
              quantity: block.quantity,
              points: block.points.map((point) => point.id).join(",")
            }),
            Effect.as<ReadonlyArray<Reading>>([])
          )
        })
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
    // Write-back is v0.4 (docs/VISION.md): it lands with the command guard, not before.
    write: (pointId) => fail("not-implemented", `writing ${pointId} is not supported yet`)
  }
}

/**
 * Build the driver for a `modbus-tcp` device. The TCP connection opens on the
 * first read and closes with the scope.
 */
export const makeModbusDriver = Effect.fn("makeModbusDriver")(function* (
  device: ModbusDevice,
  options: ModbusDriverOptions = {}
) {
  const socket = yield* NodeSocket.makeNet({
    host: device.host,
    port: device.port,
    openTimeout: options.connectTimeout ?? "3 seconds"
  })
  const client = yield* makeModbusClient(socket, {
    unitId: device.unitId,
    ...(options.requestTimeout === undefined ? {} : { requestTimeout: options.requestTimeout })
  })
  return makeModbusDriverFromClient(device, client, options)
})
