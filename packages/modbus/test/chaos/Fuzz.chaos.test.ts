/**
 * Chaos: random and mutated frames through the codecs. Bytes off the wire are
 * untrusted, so a decoder may fail with a typed error but never throw or die.
 */
import { describe, expect, it } from "@effect/vitest"
import type { ModbusPoint } from "@plenum/core"
import { Cause, Effect, Exit } from "effect"
import {
  decodeBitResponse,
  decodeReadResponse,
  decodeRequest,
  encodeRegisterResponse,
  maxReadQuantity,
  planReads,
  pointWidth,
  takeFrame
} from "../../src/index.ts"

/** A deterministic generator, so a failure reproduces. */
const makeRandom = (seed: number) => {
  let state = seed
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
  const int = (bound: number) => Math.floor(next() * bound)
  const bytes = (length: number) => Uint8Array.from({ length }, () => int(256))
  return { int, bytes }
}

const valid = encodeRegisterResponse(
  { transactionId: 7, unitId: 1, functionCode: 3, address: 0, quantity: 3 },
  [1, 2, 3]
)

describe("chaos: codec fuzz", () => {
  it("no decoder throws or dies on random and mutated frames", () => {
    const random = makeRandom(12345)
    const mutate = (frame: Uint8Array): Uint8Array => {
      const out = Uint8Array.from(frame)
      switch (random.int(4)) {
        case 0:
          out[random.int(out.length)] = random.int(256)
          return out
        case 1:
          return out.subarray(0, random.int(out.length))
        case 2:
          return Uint8Array.from([...out, ...random.bytes(random.int(300))])
        default:
          new DataView(out.buffer).setUint16(4, random.int(65536))
          return out
      }
    }
    const defects: Array<string> = []
    for (let i = 0; i < 20_000; i++) {
      const frame = i % 2 === 0 ? random.bytes(random.int(300)) : mutate(valid)
      try {
        takeFrame(frame)
        const decoders: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
          decodeReadResponse(frame, { unitId: 1, functionCode: 3, quantity: random.int(130) }),
          decodeBitResponse(frame, { unitId: 1, functionCode: 1, quantity: random.int(2100) }),
          decodeRequest(frame)
        ]
        for (const decoder of decoders) {
          const exit = Effect.runSyncExit(decoder)
          if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) defects.push(Cause.pretty(exit.cause))
        }
      } catch (error) {
        defects.push(String(error))
      }
    }
    expect(defects).toEqual([])
    // 20,000 frames through every decoder: CPU-bound, so give it room when `pnpm check` runs the simulation beside it.
  }, 60_000)
})

describe("chaos: planner fuzz", () => {
  const dataTypes = ["int16", "uint16", "int32", "uint32", "float32", "int64", "uint64", "float64", "bool"] as const
  const tables = ["holding", "input", "coil", "discrete"] as const

  it("plans legal requests for any valid point set, including the top of the address range", () => {
    const random = makeRandom(4242)
    const problems = new Set<string>()
    for (let trial = 0; trial < 3000; trial++) {
      const base = random.int(2) === 0 ? 65535 - random.int(300) : random.int(400)
      const points = Array.from({ length: 1 + random.int(200) }, (_, i): ModbusPoint => {
        const shape = {
          table: tables[random.int(tables.length)] ?? "holding",
          dataType: dataTypes[random.int(dataTypes.length)] ?? "uint16"
        }
        // The config schema keeps every point inside the address range.
        const width = pointWidth({ id: "w", name: "w", writable: false, address: 0, byteOrder: "ABCD", ...shape })
        const address = Math.min(65536 - width, Math.max(0, base + random.int(300) - 150))
        return { id: `p${i}`, name: `p${i}`, writable: false, address, byteOrder: "ABCD" as const, ...shape }
      })
      const blocks = planReads(points, { maxGap: random.int(3) === 0 ? random.int(20) : 0 })
      const planned = new Set<ModbusPoint>()
      for (const block of blocks) {
        if (block.quantity < 1 || block.quantity > maxReadQuantity(block.functionCode)) problems.add("quantity")
        if (block.address + block.quantity > 65536) problems.add("block runs past address 65535")
        for (const point of block.points) {
          planned.add(point)
          if (point.address < block.address || point.address + pointWidth(point) > block.address + block.quantity) {
            problems.add("point outside its block")
          }
        }
      }
      if (planned.size !== points.length) problems.add("point not planned")
    }
    expect([...problems]).toEqual([])
  })
})
