/**
 * Read planning: group a device's points into as few Modbus requests as the
 * protocol allows, and pick each point's value back out of the result.
 *
 * Pure, so the grouping rules are tested without a socket.
 */
import type { ModbusPoint } from "@plenum/core"
import { decodeValue, FunctionCode, maxReadQuantity, registerCount } from "./Frame.ts"
import type { ReadCode } from "./Frame.ts"

export type Table = ModbusPoint["table"]

const functionCodeFor: Record<Table, ReadCode> = {
  coil: FunctionCode.ReadCoils,
  discrete: FunctionCode.ReadDiscreteInputs,
  holding: FunctionCode.ReadHoldingRegisters,
  input: FunctionCode.ReadInputRegisters
}

const isBitTable = (table: Table) => table === "coil" || table === "discrete"

/** Addresses a point occupies: one bit, or one or two registers. */
export const pointWidth = (point: ModbusPoint): number => (isBitTable(point.table) ? 1 : registerCount(point.dataType))

/** One request covering a contiguous run of addresses in one table. */
export interface ReadBlock {
  readonly table: Table
  readonly functionCode: ReadCode
  readonly address: number
  readonly quantity: number
  readonly points: ReadonlyArray<ModbusPoint>
}

export interface PlanOptions {
  /**
   * Unused addresses a block may span to join two points (default 0). Some
   * devices answer "illegal data address" for any unmapped address in a
   * range, so merging across gaps is opt-in.
   */
  readonly maxGap?: number
}

/**
 * Group points into read blocks: per table, sorted by address, merging a
 * point into the current block while it fits the gap rule and the protocol's
 * quantity limit (125 registers or 2000 bits).
 */
export const planReads = (points: ReadonlyArray<ModbusPoint>, options: PlanOptions = {}): ReadonlyArray<ReadBlock> => {
  const maxGap = options.maxGap ?? 0
  const blocks: Array<ReadBlock> = []
  for (const table of ["holding", "input", "coil", "discrete"] as const) {
    const sorted = points.filter((p) => p.table === table).toSorted((a, b) => a.address - b.address)
    const functionCode = functionCodeFor[table]
    const limit = maxReadQuantity(functionCode)
    let current: { address: number; end: number; points: Array<ModbusPoint> } | undefined
    for (const point of sorted) {
      const end = point.address + pointWidth(point)
      if (
        current !== undefined &&
        point.address <= current.end + maxGap &&
        Math.max(current.end, end) - current.address <= limit
      ) {
        current.end = Math.max(current.end, end)
        current.points.push(point)
        continue
      }
      if (current !== undefined) {
        blocks.push({
          table,
          functionCode,
          address: current.address,
          quantity: current.end - current.address,
          points: current.points
        })
      }
      current = { address: point.address, end, points: [point] }
    }
    if (current !== undefined) {
      blocks.push({
        table,
        functionCode,
        address: current.address,
        quantity: current.end - current.address,
        points: current.points
      })
    }
  }
  return blocks
}

/** The value of `point` inside a register block read starting at `blockAddress`. */
export const valueFromRegisters = (
  point: ModbusPoint,
  blockAddress: number,
  registers: ReadonlyArray<number>
): number | boolean => {
  const offset = point.address - blockAddress
  return decodeValue(registers.slice(offset, offset + registerCount(point.dataType)), point.dataType)
}

/** The value of `point` inside a bit block read starting at `blockAddress`. */
export const valueFromBits = (point: ModbusPoint, blockAddress: number, bits: ReadonlyArray<boolean>): boolean =>
  bits[point.address - blockAddress] === true
