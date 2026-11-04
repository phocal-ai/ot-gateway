import type { ModbusPoint } from "@plenum/core"
import { describe, expect, it } from "@effect/vitest"
import { planReads, valueFromBits, valueFromRegisters } from "../src/index.ts"

const point = (
  id: string,
  table: ModbusPoint["table"],
  address: number,
  dataType: ModbusPoint["dataType"]
): ModbusPoint => ({
  id,
  name: id,
  writable: false,
  table,
  address,
  dataType,
  byteOrder: "ABCD"
})

const shape = (points: ReadonlyArray<ModbusPoint>, maxGap?: number) =>
  planReads(points, maxGap === undefined ? {} : { maxGap }).map((b) => ({
    table: b.table,
    address: b.address,
    quantity: b.quantity,
    points: b.points.map((p) => p.id)
  }))

describe("planReads", () => {
  it("merges adjacent points into one request, whatever the config order", () => {
    const points = [
      point("b", "holding", 102, "float32"),
      point("a", "holding", 100, "float32"),
      point("c", "holding", 104, "int16")
    ]
    expect(shape(points)).toEqual([{ table: "holding", address: 100, quantity: 5, points: ["a", "b", "c"] }])
  })

  it("splits at gaps unless maxGap allows spanning them", () => {
    const points = [point("a", "holding", 0, "uint16"), point("b", "holding", 3, "uint16")]
    expect(shape(points).map((b) => b.points)).toEqual([["a"], ["b"]])
    expect(shape(points, 2)).toEqual([{ table: "holding", address: 0, quantity: 4, points: ["a", "b"] }])
  })

  it("keeps tables apart and uses their function codes", () => {
    const blocks = planReads([
      point("h", "holding", 0, "uint16"),
      point("i", "input", 0, "uint16"),
      point("c", "coil", 0, "bool")
    ])
    expect(blocks.map((b) => [b.table, b.functionCode])).toEqual([
      ["holding", 3],
      ["input", 4],
      ["coil", 1]
    ])
  })

  it("never asks for more than 125 registers or 2000 bits", () => {
    const registers = Array.from({ length: 130 }, (_, i) => point(`r${i}`, "holding", i, "uint16"))
    expect(shape(registers).map((b) => b.quantity)).toEqual([125, 5])
    const bits = Array.from({ length: 2001 }, (_, i) => point(`c${i}`, "coil", i, "bool"))
    expect(shape(bits).map((b) => b.quantity)).toEqual([2000, 1])
  })

  it("lets overlapping points share registers", () => {
    const points = [point("whole", "holding", 10, "uint32"), point("low", "holding", 11, "uint16")]
    expect(shape(points)).toEqual([{ table: "holding", address: 10, quantity: 2, points: ["whole", "low"] }])
  })
})

describe("device quirks", () => {
  it("keeps reads within a device's lower limits", () => {
    const registers = Array.from({ length: 40 }, (_, i) => point(`r${i}`, "holding", i, "uint16"))
    const bits = Array.from({ length: 30 }, (_, i) => point(`b${i}`, "coil", i, "bool"))
    const blocks = planReads([...registers, ...bits], { maxRegisters: 16, maxBits: 10 })
    expect(blocks.filter((b) => b.table === "holding").map((b) => b.quantity)).toEqual([16, 16, 8])
    expect(blocks.filter((b) => b.table === "coil").map((b) => b.quantity)).toEqual([10, 10, 10])
    // A 32-bit value is never split across two reads.
    const wide = planReads(
      [point("x", "holding", 0, "uint16"), point("y", "holding", 1, "float32"), point("z", "holding", 3, "uint16")],
      { maxRegisters: 2 }
    )
    expect(wide.map((b) => [b.address, b.quantity])).toEqual([
      [0, 1],
      [1, 2],
      [3, 1]
    ])
  })

  it("reads bits of one status register in one request, each its own point", () => {
    const alarm = { ...point("alarm", "holding", 7, "bool"), bit: 3 }
    const running = { ...point("running", "holding", 7, "bool"), bit: 0 }
    const blocks = planReads([alarm, running])
    expect(blocks.map((b) => [b.address, b.quantity, b.points.length])).toEqual([[7, 1, 2]])
    // 0b1000: bit 3 set, bit 0 clear.
    expect(valueFromRegisters(alarm, 7, [0b1000])).toBe(true)
    expect(valueFromRegisters(running, 7, [0b1000])).toBe(false)
    expect(valueFromRegisters({ ...point("top", "input", 0, "bool"), bit: 15 }, 0, [0x8000])).toBe(true)
  })
})

describe("value extraction", () => {
  it("picks each point out of its block", () => {
    expect(valueFromRegisters(point("t", "holding", 102, "float32"), 100, [0, 0, 0x41ac, 0x0000])).toBeCloseTo(21.5)
    expect(valueFromBits(point("c", "coil", 7, "bool"), 5, [false, false, true])).toBe(true)
  })
})
