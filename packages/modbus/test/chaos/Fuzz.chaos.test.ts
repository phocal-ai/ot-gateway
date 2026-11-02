/**
 * Chaos: random and mutated frames through the codecs. Bytes off the wire are
 * untrusted, so a decoder may fail with a typed error but never throw or die.
 */
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import {
  decodeBitResponse,
  decodeReadResponse,
  decodeRequest,
  encodeRegisterResponse,
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
  })
})
