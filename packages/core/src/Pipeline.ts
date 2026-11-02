/**
 * The polling pipeline for one device:
 * read → scale → deadband → publish, repeated on the device's schedule.
 */
import { Clock, Duration, Effect, Metric, Option, Random, Schedule } from "effect"
import type { Driver, PointValue, Reading } from "./Driver.ts"
import { applyScaling, exceedsDeadband } from "./Normalize.ts"
import type { AnyPoint, Slug } from "./Point.ts"
import { Publisher } from "./Publisher.ts"
import {
  deviceLastSuccess,
  pointLastRead,
  pollCycles,
  pollDuration,
  publishFailures,
  readFailures,
  valuesPublished,
  valuesSuppressed,
  withMetricAttributes
} from "./Telemetry.ts"
import { metaTopic, pointTopic } from "./Topic.ts"

export interface DeviceContext {
  readonly site: Slug
  readonly building: Slug
  readonly pollIntervalMs: number
  /**
   * Share of polling cycles exported as traces, from 0 to 1 (default 1).
   * Metrics and logs cover every cycle; this only bounds trace volume.
   */
  readonly traceSampleRatio?: number
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

const countCycle = (outcome: "ok" | "read_failed" | "publish_failed") =>
  Metric.update(Metric.withAttributes(pollCycles, { outcome }), 1)

/**
 * Run one device forever. Driver failures are logged and the next cycle
 * tries again; they never stop the gateway.
 *
 * Each cycle is its own root span (`Device.pollCycle`), so a trace ends with
 * its cycle instead of hanging under a span that never closes, and updates
 * the metrics in `Telemetry.ts` with a `device` attribute. Only
 * `traceSampleRatio` of the cycles are exported as traces.
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

  const handleReading = Effect.fnUntraced(function* (reading: Reading) {
    const point = points.get(reading.pointId)
    if (point === undefined) return
    yield* Metric.update(Metric.withAttributes(pointLastRead, { point: point.id }), reading.timestamp / 1000)
    const value = typeof reading.value === "number" ? applyScaling(reading.value, point.scaling) : reading.value
    if (!exceedsDeadband(Option.fromUndefinedOr(last.get(point.id)), value, point.deadband)) {
      return yield* Metric.update(valuesSuppressed, 1)
    }
    const message: ValueMessage = {
      value,
      ts: reading.timestamp,
      ...(point.unit === undefined ? {} : { unit: point.unit })
    }
    yield* publisher.publish(pointTopic(topicFor(point.id)), JSON.stringify(message))
    // Only remember the value once it is out, so a failed publish is retried next cycle.
    last.set(point.id, value)
    yield* Metric.update(valuesPublished, 1)
  })

  const pollCycle = Effect.gen(function* () {
    const readings = yield* driver.readAll.pipe(Effect.retry(retryPolicy))
    yield* Metric.update(deviceLastSuccess, (yield* Clock.currentTimeMillis) / 1000)
    yield* Effect.annotateCurrentSpan("plenum.readings", readings.length)
    yield* Effect.forEach(readings, handleReading, { discard: true })
    yield* countCycle("ok")
  }).pipe(
    Effect.catchTags({
      DriverError: (error) =>
        Effect.all([
          Effect.logWarning("device read failed").pipe(
            Effect.annotateLogs({ reason: error.reason, error: error.message })
          ),
          Effect.annotateCurrentSpan({ "plenum.outcome": "read_failed", "plenum.reason": error.reason }),
          Metric.update(Metric.withAttributes(readFailures, { reason: error.reason }), 1),
          countCycle("read_failed")
        ]),
      PublishError: (error) =>
        Effect.all([
          Effect.logWarning("publish failed").pipe(Effect.annotateLogs({ topic: error.topic, error: error.message })),
          Effect.annotateCurrentSpan({ "plenum.outcome": "publish_failed" }),
          Metric.update(publishFailures, 1),
          countCycle("publish_failed")
        ])
    }),
    Effect.timed,
    Effect.flatMap(([duration]) => Metric.update(pollDuration, Duration.toSeconds(duration)))
  )

  // Head sampling: the decision is made when the cycle starts.
  const sampleRatio = ctx.traceSampleRatio ?? 1
  const tracedCycle = Effect.gen(function* () {
    const draw = yield* Random.next
    return yield* pollCycle.pipe(
      Effect.withSpan("Device.pollCycle", {
        root: true,
        sampled: draw < sampleRatio,
        attributes: { "plenum.site": ctx.site, "plenum.building": ctx.building, "plenum.device": driver.deviceId }
      })
    )
  })

  return yield* tracedCycle.pipe(
    Effect.repeat(Schedule.spaced(ctx.pollIntervalMs)),
    Effect.annotateLogs({ device: driver.deviceId }),
    withMetricAttributes({ device: driver.deviceId })
  )
})
