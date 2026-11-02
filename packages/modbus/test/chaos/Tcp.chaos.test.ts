/**
 * Chaos: devices that misbehave on the TCP connection. Each one was found to
 * break the client once; these pin the fixed behaviour.
 */
import { describe, expect, it } from "@effect/vitest"
import { driverConnects, withMetricAttributes } from "@plenum/core"
import type { DriverError, ModbusPoint, Reading } from "@plenum/core"
import { Clock, Effect, Exit, Metric, Option } from "effect"
import type { Duration } from "effect"
import { encodeExceptionResponse, makeModbusDriver } from "../../src/index.ts"
import { answer, deviceOn, point, startRawDevice, twoBlocks } from "./RawDevice.ts"

interface ReadResult {
  readonly exit: Exit.Exit<ReadonlyArray<Reading>, DriverError>
  readonly millis: number
}

/** Read the device `times` times through one driver, pausing `gap` between reads. */
const readRepeatedly = (
  port: number,
  points: ReadonlyArray<ModbusPoint>,
  options: { readonly times?: number; readonly gap?: Duration.Input; readonly requestTimeout?: Duration.Input } = {}
) =>
  Effect.gen(function* () {
    const driver = yield* makeModbusDriver(deviceOn(port, points), {
      requestTimeout: options.requestTimeout ?? "300 millis",
      connectTimeout: "300 millis"
    })
    const results: Array<ReadResult> = []
    for (let i = 0; i < (options.times ?? 3); i++) {
      const start = yield* Clock.currentTimeMillis
      const exit = yield* Effect.exit(driver.readAll)
      results.push({ exit, millis: (yield* Clock.currentTimeMillis) - start })
      if (options.gap !== undefined) yield* Effect.sleep(options.gap)
    }
    return results
  }).pipe(Effect.scoped)

const values = (result: ReadResult) => (Exit.isSuccess(result.exit) ? result.exit.value.map((r) => r.value) : "failed")

/** `ok`, or the `DriverError` reason of each read. */
const outcomes = (results: ReadonlyArray<ReadResult>) =>
  results.map((result) =>
    Exit.isSuccess(result.exit)
      ? "ok"
      : Option.match(Exit.findErrorOption(result.exit), { onNone: () => "defect", onSome: (error) => error.reason })
  )

describe("chaos: Modbus TCP connection handling", () => {
  it.live("reads a device that closes the connection after every response", () =>
    Effect.gen(function* () {
      const { port, stats } = yield* startRawDevice({ onRequest: (socket, request) => socket.end(answer(request)) })
      const results = yield* readRepeatedly(port, twoBlocks)

      expect(results.map(values)).toEqual([
        [42, 42],
        [42, 42],
        [42, 42]
      ])
      // One connection per answered request: each closed connection is replaced.
      expect(stats.connects).toBe(6)
    }).pipe(Effect.scoped)
  )

  it.live("sends a request at most twice when every reused connection closes unanswered", () =>
    Effect.gen(function* () {
      // Answers the first request it ever gets, then drops every connection on its first request.
      const { port, stats } = yield* startRawDevice({
        onRequest: (socket, request, _onConnection, current) =>
          current.requests === 1 ? socket.write(answer(request)) : socket.destroy()
      })
      const results = yield* readRepeatedly(port, twoBlocks, { times: 1 })

      expect(outcomes(results)).toEqual(["connection"])
      // The holding block is answered; the input block goes out on the reused connection, then once more on a new one.
      expect(stats.requests).toBe(3)
      expect(stats.connects).toBe(2)
    }).pipe(Effect.scoped)
  )

  it.live("does not resend on a fresh connection the device closes", () =>
    Effect.gen(function* () {
      const { port, stats } = yield* startRawDevice({ onRequest: (socket) => socket.destroy() })
      const results = yield* readRepeatedly(port, [point("a", "holding", 0)], { times: 1 })

      expect(outcomes(results)).toEqual(["connection"])
      expect(stats.requests).toBe(1)
    }).pipe(Effect.scoped)
  )

  it.live("does not resend when part of the response arrived before the reset", () =>
    Effect.gen(function* () {
      const { port, stats } = yield* startRawDevice({
        onRequest: (socket, request, onConnection) => {
          if (onConnection === 0) {
            socket.write(answer(request))
            return
          }
          socket.write(answer(request).subarray(0, 5))
          setTimeout(() => socket.resetAndDestroy(), 20)
        }
      })
      const results = yield* readRepeatedly(port, [point("a", "holding", 0)], { times: 2 })

      expect(outcomes(results)).toEqual(["ok", "connection"])
      expect(stats.requests).toBe(2)
    }).pipe(Effect.scoped)
  )

  for (const [mode, drop] of [
    ["closes", "end"],
    ["resets", "reset"]
  ] as const) {
    it.live(`reconnects at once when the device ${mode} an idle connection`, () =>
      Effect.gen(function* () {
        const { port, stats } = yield* startRawDevice({
          onRequest: (socket, request) => socket.write(answer(request)),
          onConnect: (socket) => socket.setTimeout(50, () => (drop === "end" ? socket.end() : socket.resetAndDestroy()))
        })
        const results = yield* readRepeatedly(port, twoBlocks, { gap: "200 millis", requestTimeout: "2 seconds" })

        expect(outcomes(results)).toEqual(["ok", "ok", "ok"])
        // A write into the dead socket would wait for the full request timeout.
        expect(Math.max(...results.map((result) => result.millis))).toBeLessThan(500)
        expect(stats.connects).toBe(3)
        expect(stats.requests).toBe(6)
      }).pipe(Effect.scoped)
    )
  }

  it.live("discards trailing bytes after a response", () =>
    Effect.gen(function* () {
      const { port, stats } = yield* startRawDevice({
        onRequest: (socket, request) => socket.write(Buffer.concat([answer(request), Buffer.from([0, 0])]))
      })
      const results = yield* readRepeatedly(port, twoBlocks)

      expect(outcomes(results)).toEqual(["ok", "ok", "ok"])
      expect(stats.connects).toBe(1)
    }).pipe(Effect.scoped)
  )

  it.live("skips a stale response that arrives before the right one", () =>
    Effect.gen(function* () {
      const { port } = yield* startRawDevice({
        onRequest: (socket, request) =>
          socket.write(
            Buffer.concat([
              answer({ ...request, transactionId: (request.transactionId - 1) & 0xffff }),
              answer(request)
            ])
          )
      })
      const results = yield* readRepeatedly(port, twoBlocks)

      expect(outcomes(results)).toEqual(["ok", "ok", "ok"])
    }).pipe(Effect.scoped)
  )

  it.live("skips unsolicited frames sent between requests", () =>
    Effect.gen(function* () {
      const { port, stats } = yield* startRawDevice({
        onRequest: (socket, request) => {
          socket.write(answer(request))
          setTimeout(() => socket.writable && socket.write(answer({ ...request, transactionId: 0x7777 })), 10)
        }
      })
      const results = yield* readRepeatedly(port, twoBlocks, { gap: "50 millis" })

      expect(outcomes(results)).toEqual(["ok", "ok", "ok"])
      expect(stats.connects).toBe(1)
    }).pipe(Effect.scoped)
  )

  it.live("reassembles a response split byte by byte", () =>
    Effect.gen(function* () {
      const { port } = yield* startRawDevice({
        onRequest: (socket, request) =>
          answer(request).forEach((byte, i) =>
            setTimeout(() => socket.writable && socket.write(Buffer.from([byte])), i * 5)
          )
      })
      const results = yield* readRepeatedly(port, [point("a", "holding", 0)])

      expect(results.map(values)).toEqual([[42], [42], [42]])
    }).pipe(Effect.scoped)
  )

  it.live("refuses a response from another unit", () =>
    Effect.gen(function* () {
      const { port } = yield* startRawDevice({
        onRequest: (socket, request) => socket.write(answer({ ...request, unitId: 99 }))
      })
      const results = yield* readRepeatedly(port, twoBlocks, { times: 1 })

      expect(outcomes(results)).toEqual(["invalid-response"])
    }).pipe(Effect.scoped)
  )

  it.live("refuses an exception that answers another function", () =>
    Effect.gen(function* () {
      const { port } = yield* startRawDevice({
        onRequest: (socket, request) =>
          socket.write(encodeExceptionResponse(request.transactionId, request.unitId, 0x2b, 0x02))
      })
      const results = yield* readRepeatedly(port, twoBlocks, { times: 1 })

      expect(outcomes(results)).toEqual(["invalid-response"])
    }).pipe(Effect.scoped)
  )

  it.live("times out while a device floods frames for other transactions", () =>
    Effect.gen(function* () {
      const { port } = yield* startRawDevice({
        onRequest: (socket, request) => {
          const junk = answer({ ...request, transactionId: (request.transactionId + 1000) & 0xffff })
          const burst = Buffer.concat(Array.from({ length: 1000 }, () => junk))
          const pump = () => {
            if (!socket.writable) return
            if (socket.write(burst)) setImmediate(pump)
            else socket.once("drain", pump)
          }
          pump()
        }
      })
      const results = yield* readRepeatedly(port, [point("a", "holding", 0)], { times: 2 })

      expect(outcomes(results)).toEqual(["timeout", "timeout"])
    }).pipe(Effect.scoped)
  )

  it.live("times out on a length field that promises more bytes than arrive", () =>
    Effect.gen(function* () {
      const { port } = yield* startRawDevice({
        onRequest: (socket, request) => {
          const bytes = Buffer.from(answer(request))
          bytes.writeUInt16BE(bytes.readUInt16BE(4) + 10, 4)
          socket.write(bytes)
        }
      })
      const results = yield* readRepeatedly(port, [point("a", "holding", 0)], { times: 1 })

      expect(outcomes(results)).toEqual(["timeout"])
    }).pipe(Effect.scoped)
  )

  it.live("counts a connect for every connection the device dropped", () =>
    Effect.gen(function* () {
      const { port } = yield* startRawDevice({ onRequest: (socket, request) => socket.end(answer(request)) })
      yield* readRepeatedly(port, twoBlocks, { times: 1 })

      const connects = yield* Metric.value(Metric.withAttributes(driverConnects, { device: "drops", outcome: "ok" }))
      expect(connects.count).toBe(2)
    }).pipe(Effect.scoped, withMetricAttributes({ device: "drops" }))
  )
})
