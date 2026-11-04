/**
 * Chaos: a device that refuses blocks on every cycle. A misconfigured address
 * is refused forever, so a warning per cycle would flood the logs (at a 100 ms
 * poll, about 864k lines a day per block). Refusals are counted instead, and
 * logged when they start and when the block reads again.
 */
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { describe, expect, it } from "@effect/vitest"
import { driverRefusals, driverRequests, withMetricAttributes } from "@ot-gateway/core"
import type { ModbusPoint } from "@ot-gateway/core"
import { Effect, Logger, Metric } from "effect"
import {
  encodeExceptionResponse,
  ExceptionCode,
  makeModbusDriver,
  makeRegisterBank,
  serveModbus,
  setPointValue
} from "../../src/index.ts"
import { answer, deviceOn, point, startRawDevice } from "./RawDevice.ts"

/** Run `effect` with a logger that keeps every line's level and message. */
const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lines: Array<{ readonly level: string; readonly message: string }> = []
    const logger = Logger.make((options) => {
      lines.push({ level: options.logLevel, message: String(options.message) })
    })
    const result = yield* effect.pipe(Effect.provide(Logger.layer([logger])))
    return { result, lines }
  })

const countOf = (metric: Metric.Counter<number>, attributes: Record<string, string>) =>
  Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.map((state) => state.count))

describe("chaos: refused blocks", () => {
  it.live("logs a refusal once when it starts and once when the block reads again", () =>
    Effect.gen(function* () {
      const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
      const bank = makeRegisterBank()
      const good = point("good", "holding", 0)
      const firstBad = point("bad0", "holding", 1000)
      const bad = [firstBad, ...Array.from({ length: 9 }, (_, i) => point(`bad${i + 1}`, "holding", 1010 + i * 10))]
      setPointValue(bank, good, 1)
      yield* serveModbus(server, bank).pipe(Effect.forkScoped)
      const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port
      const driver = yield* makeModbusDriver(deviceOn(port, [good, ...bad]))

      const refused = yield* captureLogs(Effect.repeat(driver.readAll, { times: 9 }))
      expect(refused.lines.filter((line) => line.level === "Warn")).toHaveLength(10)
      expect(yield* countOf(driverRefusals, { device: "refusals", exception: "illegal_data_address" })).toBe(100)

      // One misconfigured register gets mapped: the block reads again, once logged.
      setPointValue(bank, firstBad, 7)
      const recovered = yield* captureLogs(Effect.repeat(driver.readAll, { times: 4 }))
      expect(recovered.lines.filter((line) => line.level === "Warn")).toHaveLength(0)
      expect(recovered.lines.filter((line) => line.level === "Info")).toHaveLength(1)
      expect(recovered.result.find((reading) => reading.pointId === "bad0")?.value).toBe(7)
    }).pipe(Effect.scoped, withMetricAttributes({ device: "refusals" }))
  )

  it.live("does not retry a permanent refusal within the read", () =>
    Effect.gen(function* () {
      const { port, stats } = yield* startRawDevice({
        onRequest: (socket, request) =>
          socket.write(
            encodeExceptionResponse(
              request.transactionId,
              request.unitId,
              request.functionCode,
              ExceptionCode.IllegalDataAddress
            )
          )
      })
      const driver = yield* makeModbusDriver(deviceOn(port, [point("a", "holding", 0), point("b", "input", 0)]))
      const error = yield* Effect.flip(driver.readAll)

      expect(error).toMatchObject({ _tag: "DriverError", reason: "protocol" })
      expect(stats.requests).toBe(2)
    }).pipe(Effect.scoped)
  )

  it.live("retries a block while the device is busy", () =>
    Effect.gen(function* () {
      const { port, stats } = yield* startRawDevice({
        onRequest: (socket, request, onConnection) =>
          socket.write(
            onConnection < 2
              ? encodeExceptionResponse(
                  request.transactionId,
                  request.unitId,
                  request.functionCode,
                  ExceptionCode.ServerDeviceBusy
                )
              : answer(request)
          )
      })
      const busy: ModbusPoint = point("a", "holding", 0)
      const driver = yield* makeModbusDriver(deviceOn(port, [busy]))
      const readings = yield* driver.readAll

      expect(readings.map((reading) => reading.value)).toEqual([42])
      expect(stats.requests).toBe(3)
      expect(yield* countOf(driverRequests, { device: "busy", outcome: "exception" })).toBe(2)
      expect(yield* countOf(driverRefusals, { device: "busy", exception: "server_device_busy" })).toBe(0)
    }).pipe(Effect.scoped, withMetricAttributes({ device: "busy" }))
  )

  it.live("gives up on a busy block after two retries and counts the refusal", () =>
    Effect.gen(function* () {
      const { port, stats } = yield* startRawDevice({
        onRequest: (socket, request) =>
          socket.write(
            encodeExceptionResponse(
              request.transactionId,
              request.unitId,
              request.functionCode,
              ExceptionCode.GatewayTargetFailedToRespond
            )
          )
      })
      const driver = yield* makeModbusDriver(deviceOn(port, [point("a", "holding", 0)]))
      const error = yield* Effect.flip(driver.readAll)

      expect(error.message).toContain("gateway_target_failed_to_respond")
      expect(stats.requests).toBe(3)
      expect(yield* countOf(driverRefusals, { device: "gateway", exception: "gateway_target_failed_to_respond" })).toBe(
        1
      )
    }).pipe(Effect.scoped, withMetricAttributes({ device: "gateway" }))
  )
})
