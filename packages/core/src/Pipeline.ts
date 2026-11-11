/**
 * The polling pipeline for one device: read → scale → publish, repeated on the device's schedule. How a value
 * goes out is the point's publish mode (`Publish.ts`): on every read, the latest once per interval, a window's
 * aggregate, or on change. Windows close on clock-aligned timers, one per distinct interval. A cycle publishes its
 * points' values concurrently, so across points they reach the broker in no set order (each carries its own `ts`);
 * one point's values keep the order they were read in.
 */
import { Clock, Duration, Effect, Metric, Option, Random, Result, Schedule, Semaphore, Stream } from "effect"
import type { Driver, PointValue, Reading } from "./Driver.ts"
import type { HealthReason, HealthRegistry } from "./Health.ts"
import { applyScaling, exceedsDeadband } from "./Normalize.ts"
import type { AnyPoint, Slug } from "./Point.ts"
import { defaultCycleTimeoutMs } from "./Config.ts"
import { type DriverError, PipelineTimeout, type PublishError } from "./Errors.ts"
import type { HistorySink } from "./History.ts"
import { monotonicMillis } from "./Monotonic.ts"
import {
  addReading,
  closeWindow,
  everyRead,
  interruptWindow,
  openWindow,
  type Publish,
  publishOf,
  type Window,
  windowEnd,
  windowIntervalMs
} from "./Publish.ts"
import { Publisher } from "./Publisher.ts"
import {
  deviceLastSuccess,
  makeValueCounters,
  pointReadFailures,
  pollCycles,
  pollDuration,
  publishFailures,
  readFailures,
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
  /** Where the device's status is recorded for the health topic, if anywhere. */
  readonly health?: HealthRegistry
  /**
   * How long one cycle, or handling one pushed value, may take before it is
   * abandoned as hung (default `defaultCycleTimeoutMs(pollIntervalMs)`).
   */
  readonly cycleTimeoutMs?: number
  /** How the device's points go out unless a point says otherwise (default: every read). */
  readonly publish?: Publish
  /** Where every read is kept on the device, if anywhere. */
  readonly history?: HistorySink
  /** Points the config asks to receive by change of value (`covPointIds`); their `$meta` says `"cov": true`. */
  readonly covPoints?: ReadonlyArray<string>
}

/** Payload of a value: on a read, on a change, or the latest once per interval. */
export interface ValueMessage {
  readonly value: PointValue
  readonly unit?: string
  readonly ts: number
}

/**
 * A point's retained metadata. `cov: true` marks a point asked for by change of value: its values come when the
 * device notifies a change (in `sample` mode each notification is a message, possibly more often than the poll
 * interval), and by polling while the device does not notify.
 */
const metaPayload = (point: AnyPoint, publish: Publish, cov: boolean): string =>
  JSON.stringify({
    name: point.name,
    unit: point.unit,
    writable: point.writable,
    publish,
    ...(cov ? { cov } : {}),
    semantics: point.semantics
  })

/** A value to publish now, and what to remember once the broker took it. */
interface Outgoing {
  readonly pointId: string
  readonly message: ValueMessage
  readonly onSent?: () => void
}
const nothing: Outgoing | undefined = undefined

/**
 * How many of a cycle's values are published at once. QoS 1 waits for the broker's acknowledgement, so one at a time
 * costs a round trip per point; the outbox drains with the same number, and the MQTT client's Receive Maximum bounds
 * it further. Values of one point never overtake each other.
 */
const PUBLISH_CONCURRENCY = 16

/** Retry transient driver failures with jittered exponential backoff, capped at 5 attempts per cycle. */
const retryPolicy = {
  schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered),
  times: 4
}

/**
 * Whether a failed read may succeed if it is sent again right away. Only
 * transport failures can: no answer, a lost connection, a garbled frame. A
 * device that answered with a refusal (`protocol`, e.g. a Modbus exception or
 * a BACnet abort) would refuse again, and retrying only multiplies requests
 * to a device that already said no; `configuration` and `not-implemented`
 * never change within a cycle. A driver that resends timeouts itself
 * (`retriesTimeouts`) is not retried on `timeout` either.
 */
const isRetryable = (driver: Driver, error: DriverError): boolean => {
  switch (error.reason) {
    case "timeout":
      return driver.retriesTimeouts !== true
    case "connection":
    case "invalid-response":
      return true
    case "protocol":
    case "configuration":
    case "not-implemented":
      return false
  }
}

const countCycle = (outcome: "ok" | "read_failed" | "publish_failed" | "timed_out") =>
  Metric.update(Metric.withAttributes(pollCycles, { outcome }), 1)

/**
 * Run one device forever. Driver failures are logged and the next cycle
 * tries again; they never stop the gateway.
 *
 * Each cycle is its own root span (`Device.pollCycle`), so a trace ends with
 * its cycle instead of hanging under a span that never closes, and updates
 * the metrics in `Telemetry.ts` with a `device` attribute. Only
 * `traceSampleRatio` of the cycles are exported as traces.
 *
 * Values the driver pushes (`driver.changes`) go through the same scaling and
 * publish mode, one at a time with the cycle's own values and the window
 * timers, so each point's state stays consistent. They are not traced.
 */
export const runDevice = Effect.fn("runDevice")(function* (ctx: DeviceContext, driver: Driver) {
  const publisher = yield* Publisher
  /** This device's own instances of the per-value counters (`makeValueCounters`). */
  const counters = makeValueCounters()
  const points = new Map(driver.points.map((p) => [p.id, p] as const))
  const policies = new Map(driver.points.map((p) => [p.id, publishOf(ctx.publish, p)] as const))
  const policyOf = (pointId: string) => policies.get(pointId) ?? everyRead
  const covPoints = new Set(ctx.covPoints)
  /** Change mode: the last value sent, and when (monotonic), for the deadband and `maxSilenceMs`. */
  const last = new Map<string, PointValue>()
  const lastSentAt = new Map<string, number>()
  /** Sample mode with an interval: the latest value per point, and which points read one since the last send. */
  const latest = new Map<string, ValueMessage>()
  const fresh = new Set<string>()
  /** Aggregate mode: each point's open window. */
  const windows = new Map<string, Window>()
  const topicFor = (point: Slug) => ({
    site: ctx.site,
    building: ctx.building,
    device: driver.deviceId,
    point
  })

  /**
   * A message the broker refused (not authorized, too large) fails again on
   * every retry, so it must not hold up the device's other points. It is
   * counted every time and logged once per topic until that topic works again.
   */
  const refusedTopics = new Set<string>()
  const skipRefused = (error: PublishError) =>
    error.reason !== "rejected"
      ? Effect.fail(error)
      : Effect.gen(function* () {
          yield* Metric.update(publishFailures, 1)
          if (refusedTopics.has(error.topic)) return
          refusedTopics.add(error.topic)
          yield* Effect.logWarning("broker refused a message, skipping it").pipe(
            Effect.annotateLogs({ topic: error.topic, error: error.message })
          )
        })

  /**
   * A device or broker that stays down fails every cycle. Each failure is
   * counted, but logged only when it starts or changes, and once more when it
   * ends, so a gateway with many devices and no broker does not flood its log.
   * `deviceProblem` follows the health status: the reason the device is
   * failing, until a cycle completes again. `publishFailing` is set per kind
   * of message by a failed publish (values, polled or pushed; or retained
   * metadata), until a message of that kind gets through again. They fail
   * apart: behind the outbox a value is taken while the broker is down, and
   * metadata is not, so one state would flip on every cycle.
   */
  let deviceProblem: HealthReason | undefined
  const publishFailing = { values: false, metadata: false }
  type Channel = keyof typeof publishFailing
  const deviceFailed = (problem: HealthReason, message: string, annotations: Record<string, unknown>) =>
    Effect.suspend(() => {
      if (problem === deviceProblem) return Effect.void
      deviceProblem = problem
      return Effect.logWarning(message).pipe(Effect.annotateLogs(annotations))
    })
  /** A failed cycle in the health registry: why, in the error's own words, and when. */
  const recordFailure = (reason: HealthReason, message: string) =>
    ctx.health === undefined
      ? Effect.void
      : Effect.map(Clock.currentTimeMillis, (at) => ctx.health?.recordFailure(driver.deviceId, { reason, message, at }))
  const deviceRecovered = Effect.suspend(() => {
    const was = deviceProblem
    if (was === undefined) return Effect.void
    deviceProblem = undefined
    return Effect.logInfo("device works again").pipe(Effect.annotateLogs({ after: was }))
  })
  const publishFailed = (channel: Channel, message: string, annotations: Record<string, unknown>) =>
    Effect.suspend(() => {
      if (publishFailing[channel]) return Effect.void
      publishFailing[channel] = true
      return Effect.logWarning(message).pipe(Effect.annotateLogs(annotations))
    })
  const publishRecovered = (channel: Channel) =>
    Effect.suspend(() => {
      if (!publishFailing[channel]) return Effect.void
      publishFailing[channel] = false
      return Effect.logInfo(channel === "values" ? "publishing works again" : "metadata publishing works again")
    })
  // Only a message the broker took ends an outage: a cycle whose values all stayed inside their deadband publishes
  // nothing, so it proves nothing and must not reset the log state (or the next failure is logged again).
  const publishPoint = Effect.fnUntraced(function* (
    topic: string,
    payload: string,
    options?: { readonly retain: boolean }
  ) {
    yield* publisher.publish(topic, payload, options)
    refusedTopics.delete(topic)
    yield* publishRecovered(options?.retain === true ? "metadata" : "values")
  })

  // Metadata goes out once per point, retained. It is retried at the start of
  // every cycle until the broker took it, so a broker that is down when the
  // gateway starts delays metadata instead of stopping the device. Metadata the
  // broker refuses is given up on: retrying cannot help.
  const unpublishedMeta = new Set(driver.points)
  // Suspended so each retry takes the points still missing then, not the ones missing when this was defined.
  const publishMeta = Effect.suspend(() =>
    Effect.forEach(
      [...unpublishedMeta],
      (point) =>
        publishPoint(metaTopic(topicFor(point.id)), metaPayload(point, policyOf(point.id), covPoints.has(point.id)), {
          retain: true
        }).pipe(
          Effect.catchTag("PublishError", skipRefused),
          Effect.andThen(Effect.sync(() => unpublishedMeta.delete(point)))
        ),
      // A broker failure interrupts the others in flight; what did not get out is retried next cycle.
      { concurrency: PUBLISH_CONCURRENCY, discard: true }
    )
  ).pipe(
    // The device is still read: its health is independent of the broker's.
    Effect.catchTag("PublishError", (error) =>
      Effect.all([
        publishFailed("metadata", "metadata publish failed", { topic: error.topic, error: error.message }),
        Metric.update(publishFailures, 1)
      ])
    )
  )

  /**
   * When each point's last pushed value was handled, on the monotonic clock.
   * A polled value from a cycle that started before then is older than what
   * is out already, and is dropped. The readings' own timestamps are wall
   * time, which can step back, so they are never compared.
   */
  const pushedAt = new Map<string, bigint>()

  /**
   * Points whose last value was not a finite number. Each one is a point read
   * failure, counted every time and logged once until the point reads a
   * number again; nothing is published and the deadband reference is kept.
   */
  const nonFinitePoints = new Set<string>()
  const nonFinite = Effect.fnUntraced(function* (pointId: string, raw: PointValue) {
    yield* Metric.update(Metric.withAttributes(pointReadFailures, { reason: "not_finite" }), 1)
    if (nonFinitePoints.has(pointId)) return
    nonFinitePoints.add(pointId)
    yield* Effect.logWarning("point value is not a finite number, not publishing it").pipe(
      Effect.annotateLogs({ point: pointId, raw: String(raw) })
    )
  })

  /**
   * Everything handling a reading does short of publishing it: drop a stale polled value, scale, refuse a
   * non-finite number, record to the history, and apply the publish mode. Returns what to publish now, if anything;
   * `onSent` is what to remember once the broker took it. Nothing here waits on I/O.
   */
  const decideReading = Effect.fnUntraced(function* (reading: Reading, polledSince?: bigint) {
    const point = points.get(reading.pointId)
    if (point === undefined) return nothing
    if (polledSince === undefined) pushedAt.set(point.id, yield* Clock.monotonicTimeNanos)
    else if ((pushedAt.get(point.id) ?? -1n) >= polledSince) return nothing
    const value = typeof reading.value === "number" ? applyScaling(reading.value, point.scaling) : reading.value
    // NaN or ±Infinity (a float register holding NaN, or scaling that overflows) is not a reading:
    // JSON has no such number, and NaN as the deadband reference would never compare as changed again.
    // It also ends what the point's window holds, so later windows do not report the last good value as if it held.
    if (typeof value === "number" && !Number.isFinite(value)) {
      yield* nonFinite(point.id, reading.value)
      const window = windows.get(point.id)
      if (window !== undefined) windows.set(point.id, interruptWindow(window, yield* monotonicMillis))
      return nothing
    }
    if (nonFinitePoints.delete(point.id)) {
      yield* Effect.logInfo("point delivers numbers again").pipe(Effect.annotateLogs({ point: point.id }))
    }
    ctx.history?.record(driver.deviceId, point.id, value, reading.timestamp)
    const message: ValueMessage = {
      value,
      ts: reading.timestamp,
      ...(point.unit === undefined ? {} : { unit: point.unit })
    }
    const policy = policyOf(point.id)
    switch (policy.mode) {
      case "sample": {
        if (policy.intervalMs === undefined) return { pointId: point.id, message }
        latest.set(point.id, message)
        fresh.add(point.id)
        return nothing
      }
      case "aggregate": {
        const atMono = yield* monotonicMillis
        windows.set(point.id, addReading(windows.get(point.id) ?? openWindow(atMono), value, atMono, reading.timestamp))
        return nothing
      }
      case "change": {
        const atMono = yield* monotonicMillis
        const sentAt = lastSentAt.get(point.id)
        const quietTooLong =
          policy.maxSilenceMs !== undefined && sentAt !== undefined && atMono - sentAt >= policy.maxSilenceMs
        if (!quietTooLong && !exceedsDeadband(Option.fromUndefinedOr(last.get(point.id)), value, policy.deadband)) {
          yield* Metric.update(counters.suppressed, 1)
          return nothing
        }
        // Only remember the value once it is out, so a failed publish is retried with the next read.
        return {
          pointId: point.id,
          message,
          onSent: () => {
            last.set(point.id, value)
            lastSentAt.set(point.id, atMono)
          }
        }
      }
    }
  })

  /** Handles one reading start to finish: pushed values, and a cycle that read the same point twice. */
  const handleReading = Effect.fnUntraced(function* (reading: Reading, polledSince?: bigint) {
    const outgoing = yield* decideReading(reading, polledSince)
    if (outgoing === undefined) return
    if (yield* send(outgoing.pointId, outgoing.message)) outgoing.onSent?.()
  })

  /**
   * The broker failure that ended this cycle's publishing. A broker that is down fails every publish, each after
   * waiting up to the publish timeout, so the cycle's later points are recorded but not offered to it again.
   */
  let unavailable: PublishError | undefined

  /** Publishes one point's message; false when the broker refused it (counted and logged once per topic). */
  const send = Effect.fnUntraced(function* (pointId: string, message: object) {
    if (unavailable !== undefined) return false
    const sent = yield* publishPoint(pointTopic(topicFor(pointId)), JSON.stringify(message)).pipe(
      Effect.as(true),
      Effect.catchTag("PublishError", (error) => Effect.as(skipRefused(error), false))
    )
    if (sent) yield* Metric.update(counters.published, 1)
    return sent
  })

  /**
   * Publishes one of a cycle's values, alongside up to `PUBLISH_CONCURRENCY - 1` others. A broker failure is kept in
   * `unavailable` instead of failing, so the publishes already in flight finish on their own and none starts after it.
   */
  const publishOutgoing = Effect.fnUntraced(function* (outgoing: Outgoing) {
    const sent = yield* send(outgoing.pointId, outgoing.message).pipe(
      Effect.catchTag("PublishError", (error) =>
        Effect.sync(() => {
          unavailable ??= error
          return false
        })
      )
    )
    if (sent) outgoing.onSent?.()
  })

  /**
   * Closes the windows of one interval at `endMs`: the latest value of each sample point that read one since the
   * last send, and the aggregate of each aggregate point. A window with no read in it is sent only while the
   * device is fine: then its value held unchanged (a quiet change-of-value point); otherwise nothing is known.
   *
   * Every window of the interval closes, whether or not the broker takes its message, so no window stays open
   * across an outage and later reports it as one interval. After the first broker failure the rest are not offered
   * to it (a broker that is down would make each wait for the publish timeout), and the failure is reported once,
   * after the loop. A sample point whose latest value was not sent keeps it fresh, so the next boundary offers it.
   */
  const closeWindows = Effect.fnUntraced(function* (intervalMs: number, endMs: number) {
    const atMono = yield* monotonicMillis
    let failed: PublishError | undefined
    for (const point of driver.points) {
      const policy = policyOf(point.id)
      if (windowIntervalMs(policy) !== intervalMs) continue
      if (policy.mode === "sample") {
        const message = latest.get(point.id)
        if (message === undefined || !fresh.has(point.id) || failed !== undefined) continue
        const sent = yield* Effect.result(send(point.id, message))
        if (Result.isFailure(sent)) failed = sent.failure
        else fresh.delete(point.id)
        continue
      }
      const window = windows.get(point.id)
      if (window === undefined) continue
      const closed = closeWindow(window, atMono, endMs, intervalMs, point.unit)
      windows.set(point.id, closed.next)
      if (closed.message === undefined || (closed.message.count === 0 && deviceProblem !== undefined)) continue
      if (failed !== undefined) continue
      const sent = yield* Effect.result(send(point.id, closed.message))
      if (Result.isFailure(sent)) failed = sent.failure
    }
    if (failed !== undefined) return yield* failed
  })

  /** A device that stops answering ends what its last values said: an outage is not averaged as if they held. */
  const interruptWindows = Effect.gen(function* () {
    if (windows.size === 0) return
    const atMono = yield* monotonicMillis
    for (const [pointId, window] of windows) windows.set(pointId, interruptWindow(window, atMono))
  })
  // Polled and pushed values for the same point must not interleave around `last`.
  const handling = yield* Semaphore.make(1)

  // A hung driver or publisher must not hold the device forever with its health still `ok`.
  const deadlineMs = ctx.cycleTimeoutMs ?? defaultCycleTimeoutMs(ctx.pollIntervalMs)
  const stageNames = {
    "poll-cycle": "polling cycle",
    "pushed-value": "pushed value",
    "publish-window": "closing a window"
  } as const
  const deadline = (stage: PipelineTimeout["stage"]) =>
    Effect.timeoutOrElse({
      duration: deadlineMs,
      orElse: () =>
        Effect.fail(
          new PipelineTimeout({
            device: driver.deviceId,
            stage,
            timeoutMs: deadlineMs,
            message: `${stageNames[stage]} did not finish within ${deadlineMs} ms`
          })
        )
    })

  const pollCycle = Effect.gen(function* () {
    if (unpublishedMeta.size > 0) yield* publishMeta
    const polledSince = yield* Clock.monotonicTimeNanos
    const readings = yield* driver.readAll.pipe(
      Effect.retry({
        ...retryPolicy,
        while: (error) => isRetryable(driver, error)
      })
    )
    const readAt = yield* Clock.currentTimeMillis
    yield* Metric.update(deviceLastSuccess, readAt / 1000)
    yield* Effect.annotateCurrentSpan("ot_gateway.readings", readings.length)
    // Two phases, both under the permit and the cycle's deadline. First every reading is decided one after another
    // (history, deadband, windows: nothing that waits), so a broker that is down cannot keep any point out of the
    // history and the status page. Then the values to send are published `PUBLISH_CONCURRENCY` at a time, so a slow
    // uplink costs one round trip per batch instead of one per point. After the first broker failure no new publish
    // starts (`send`), and the failure is reported once, after all of them. A cycle that read a point twice is
    // handled one reading at a time, so a point's values never overtake each other or race its deadband.
    const failedPublish = yield* handling.withPermit(
      Effect.gen(function* () {
        unavailable = undefined
        if (new Set(readings.map((reading) => reading.pointId)).size < readings.length) {
          for (const reading of readings) {
            const handled = yield* Effect.result(handleReading(reading, polledSince))
            if (Result.isFailure(handled)) unavailable ??= handled.failure
          }
          return unavailable
        }
        const outgoing: Array<Outgoing> = []
        for (const reading of readings) {
          const decided = yield* decideReading(reading, polledSince)
          if (decided !== undefined) outgoing.push(decided)
        }
        yield* Effect.forEach(outgoing, publishOutgoing, { concurrency: PUBLISH_CONCURRENCY, discard: true })
        return unavailable
      }).pipe(
        // Also when the cycle's deadline interrupts it: pushed values and closing windows must not skip publishing.
        Effect.ensuring(
          Effect.sync(() => {
            unavailable = undefined
          })
        )
      )
    )
    // The device is `ok` once its values were handled: a broker that refuses or is down does not make the device
    // failing, but a cycle that hangs in publishing (and hits the deadline) never gets here.
    ctx.health?.recordSuccess(driver.deviceId, readAt)
    yield* deviceRecovered
    if (failedPublish !== undefined) return yield* failedPublish
    yield* countCycle("ok")
  }).pipe(
    deadline("poll-cycle"),
    Effect.catchTags({
      DriverError: (error) =>
        Effect.all([
          recordFailure(error.reason, error.message),
          handling.withPermit(interruptWindows),
          deviceFailed(error.reason, "device read failed", { reason: error.reason, error: error.message }),
          Effect.annotateCurrentSpan({ "ot_gateway.outcome": "read_failed", "ot_gateway.reason": error.reason }),
          Metric.update(Metric.withAttributes(readFailures, { reason: error.reason }), 1),
          countCycle("read_failed")
        ]),
      PublishError: (error) =>
        Effect.all([
          publishFailed("values", "publish failed", { topic: error.topic, error: error.message }),
          Effect.annotateCurrentSpan({ "ot_gateway.outcome": "publish_failed" }),
          Metric.update(publishFailures, 1),
          countCycle("publish_failed")
        ]),
      PipelineTimeout: (error) =>
        Effect.all([
          recordFailure("cycle-timeout", error.message),
          handling.withPermit(interruptWindows),
          deviceFailed("cycle-timeout", "polling cycle hung, abandoned it", {
            timeoutMs: error.timeoutMs,
            error: error.message
          }),
          Effect.annotateCurrentSpan({ "ot_gateway.outcome": "timed_out" }),
          countCycle("timed_out")
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
        attributes: {
          "ot_gateway.site": ctx.site,
          "ot_gateway.building": ctx.building,
          "ot_gateway.device": driver.deviceId
        }
      })
    )
  })

  const polling = tracedCycle.pipe(Effect.repeat(Schedule.spaced(ctx.pollIntervalMs)))
  // A broker outage fails every pushed value: each is counted, and logged only if publishing was not failing yet.
  const pushLost = (message: string, annotations: Record<string, unknown>) =>
    Effect.all([publishFailed("values", message, annotations), Metric.update(publishFailures, 1)])
  const pushed =
    driver.changes === undefined
      ? Effect.void
      : Stream.runForEach(driver.changes, (reading) =>
          Metric.update(counters.pushed, 1).pipe(
            // Under the deadline, so a hung publish cannot keep the permit from the polling cycle forever.
            Effect.andThen(handling.withPermit(handleReading(reading)).pipe(deadline("pushed-value"))),
            // The value is lost; the next change, renewal notification or poll brings the point's value again.
            Effect.catchTags({
              PublishError: (error) =>
                pushLost("publish of a pushed value failed", { topic: error.topic, error: error.message }),
              // Publishing is the only step of handling a value that can block, so it counts as a publish failure.
              PipelineTimeout: (error) =>
                pushLost("handling a pushed value hung, dropped it", {
                  point: reading.pointId,
                  error: error.message
                })
            })
          )
        ).pipe(
          // A bug on the push side must not stop the device: polling goes on.
          Effect.catchDefect((defect) =>
            Effect.logError("pushed values stopped, polling continues").pipe(
              Effect.annotateLogs({ error: String(defect) })
            )
          )
        )

  /**
   * One timer per distinct publish interval, waking at each clock-aligned boundary. The boundary is computed again
   * from the wall clock after every wait, so a clock that NTP steps re-aligns at the next window instead of
   * drifting; the wait itself is a monotonic sleep. Window labels only move forward: a timer that wakes early, or a
   * clock stepped back, extends the open window rather than closing one with the same label twice.
   */
  const intervals = [...new Set([...policies.values()].flatMap((policy) => windowIntervalMs(policy) ?? []))]
  const windowTimer = (intervalMs: number) => {
    let closedUpTo = 0
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const endMs = windowEnd(Math.max(now, closedUpTo), intervalMs)
      closedUpTo = endMs
      yield* Effect.sleep(endMs - now)
      yield* handling.withPermit(closeWindows(intervalMs, endMs)).pipe(
        deadline("publish-window"),
        Effect.catchTags({
          PublishError: (error) => pushLost("publishing a window failed", { topic: error.topic, error: error.message }),
          PipelineTimeout: (error) => pushLost("closing a window hung, skipped it", { error: error.message })
        })
      )
    }).pipe(Effect.forever)
  }
  const timers = Effect.forEach(intervals, windowTimer, { concurrency: "unbounded", discard: true })

  return yield* Effect.all([polling, pushed, timers], { concurrency: 3, discard: true }).pipe(
    Effect.annotateLogs({ device: driver.deviceId }),
    withMetricAttributes({ device: driver.deviceId })
  )
})
