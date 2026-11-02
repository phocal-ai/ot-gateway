/**
 * The polling pipeline for one device:
 * read → scale → deadband → publish, repeated on the device's schedule.
 */
import { Effect, Option, Schedule } from "effect"
import type { Driver, PointValue } from "./Driver.ts"
import { applyScaling, exceedsDeadband } from "./Normalize.ts"
import type { AnyPoint, Slug } from "./Point.ts"
import { Publisher } from "./Publisher.ts"
import { metaTopic, pointTopic } from "./Topic.ts"

export interface DeviceContext {
  readonly site: Slug
  readonly building: Slug
  readonly pollIntervalMs: number
}

/** Payload published for every value change. */
export interface ValueMessage {
  readonly value: PointValue
  readonly unit?: string
  readonly ts: number
}

const metaPayload = (point: AnyPoint): string =>
  JSON.stringify({
    name: point.name,
    unit: point.unit,
    writable: point.writable,
    semantics: point.semantics
  })

/** Retry transient driver failures with jittered exponential backoff, capped at 5 attempts per cycle. */
const retryPolicy = {
  schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered),
  times: 4
}

/**
 * Run one device forever. Driver failures are logged and the next cycle
 * tries again; they never stop the gateway.
 */
export const runDevice = Effect.fn("runDevice")(function* (ctx: DeviceContext, driver: Driver) {
  const publisher = yield* Publisher
  const points = new Map(driver.points.map((p) => [p.id, p] as const))
  const last = new Map<string, PointValue>()
  const topicFor = (point: Slug) => ({
    site: ctx.site,
    building: ctx.building,
    device: driver.deviceId,
    point
  })

  // Publish metadata once, retained.
  yield* Effect.forEach(
    driver.points,
    (point) => publisher.publish(metaTopic(topicFor(point.id)), metaPayload(point), { retain: true }),
    { discard: true }
  )

  const cycle = driver.readAll.pipe(
    Effect.retry(retryPolicy),
    Effect.flatMap((readings) =>
      Effect.forEach(
        readings,
        (reading) => {
          const point = points.get(reading.pointId)
          if (point === undefined) return Effect.void
          const value = typeof reading.value === "number" ? applyScaling(reading.value, point.scaling) : reading.value
          if (!exceedsDeadband(Option.fromUndefinedOr(last.get(point.id)), value, point.deadband)) {
            return Effect.void
          }
          last.set(point.id, value)
          const message: ValueMessage = {
            value,
            ts: reading.timestamp,
            ...(point.unit === undefined ? {} : { unit: point.unit })
          }
          return publisher.publish(pointTopic(topicFor(point.id)), JSON.stringify(message))
        },
        { discard: true }
      )
    ),
    Effect.catchTags({
      DriverError: (error) =>
        Effect.logWarning("device read failed", {
          device: error.device,
          reason: error.reason,
          message: error.message
        }),
      PublishError: (error) => Effect.logWarning("publish failed", { topic: error.topic, message: error.message })
    })
  )

  return yield* cycle.pipe(
    Effect.repeat(Schedule.spaced(ctx.pollIntervalMs)),
    Effect.annotateLogs({ device: driver.deviceId })
  )
})
