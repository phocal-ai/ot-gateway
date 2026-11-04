/**
 * A programmable client for one device, a skewed clock and a log capture,
 * shared by the chaos tests: they put the driver through outages, busy
 * devices, clock steps and storms that real hardware produces rarely.
 */
import type { BacnetDevice, BacnetPoint } from "@ot-gateway/core"
import type { Clock } from "effect"
import { Effect, Logger, Result } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import { TestClock } from "effect/testing"
import {
  AbortReason,
  type BacnetClient,
  BacnetDeviceError,
  type BacnetRequestError,
  BacnetTimeout,
  type BacnetValue,
  type CovNotification,
  type DeviceAddress,
  ErrorClass,
  ErrorCode,
  ObjectType,
  parseDeviceAddress,
  PropertyId,
  type ReadAccessResult,
  RejectReason,
  type SubscribeCovRequest
} from "../../src/index.ts"

export const here = Result.getOrThrow(parseDeviceAddress("10.0.0.5"))

/** `count` present-value points on analog inputs 1 to `count`. */
export const points = (count: number): Array<BacnetPoint> =>
  Array.from({ length: count }, (_, index) => ({
    id: `p-${index}`,
    name: `p-${index}`,
    writable: false,
    priority: 8,
    objectType: "analog-input",
    instance: index + 1,
    property: "present-value"
  }))

export const deviceConfig = (
  devicePoints: ReadonlyArray<BacnetPoint>,
  options: { readonly cov?: boolean; readonly address?: string } = {}
): BacnetDevice => ({
  protocol: "bacnet-ip",
  id: "dev",
  deviceInstance: 2001,
  cov: options.cov ?? false,
  pollIntervalMs: 1000,
  ...(options.address === undefined ? {} : { address: options.address }),
  points: devicePoints
})

/** How the scripted device answers reads. */
export type Mode =
  | "ok"
  | "timeout"
  /** Rejects ReadPropertyMultiple as unrecognized: a device without it, or one whose stack is still starting. */
  | "reject-rpm"
  /** Answers ReadPropertyMultiple with an Error PDU for the whole request, as some do for one missing object. */
  | "error-rpm"
  /** Aborts every request as preempted by a higher-priority task: a busy device. */
  | "busy"

export const busyAbort = new BacnetDeviceError({
  kind: "abort",
  code: AbortReason.PreemptedByHigherPriorityTask,
  message: "aborted: preempted-by-higher-priority-task"
})

/** A client whose one device answers every read with `state.value`, as `state.mode` says. */
export const scriptedClient = () => {
  const state = {
    mode: "ok" as Mode,
    at: here,
    value: 1,
    /** Answers Who-Is; when false, `locate` times out although reads are answered. */
    answersWhoIs: true,
    maxApdu: 1476,
    /** Analog inputs the device does not have; a ReadPropertyMultiple naming one is refused as a whole. */
    missing: new Set<number>(),
    rpm: 0,
    rp: 0,
    locate: 0,
    /** How SubscribeCOV goes; succeeds by default, after the mode allowed the request. */
    subscribe: (_request: SubscribeCovRequest): Effect.Effect<void, BacnetRequestError> => Effect.void,
    subscribes: [] as Array<{ readonly at: string; readonly instance: number; readonly cancel: boolean }>,
    listener: undefined as ((notification: CovNotification, from: DeviceAddress) => void) | undefined
  }
  const timeout = new BacnetTimeout({ message: "no answer" })
  const unknownObject = new BacnetDeviceError({
    kind: "error",
    errorClass: ErrorClass.object,
    code: ErrorCode["unknown-object"],
    message: "object: unknown-object"
  })
  const refusal = (): Effect.Effect<never, BacnetRequestError> | undefined => {
    switch (state.mode) {
      case "timeout":
        return Effect.fail(timeout)
      case "busy":
        return Effect.fail(busyAbort)
      case "ok":
      case "reject-rpm":
      case "error-rpm":
        return undefined
    }
  }
  const client: BacnetClient = {
    confirmed: () => Effect.die("not scripted"),
    writeProperty: () => Effect.die("not scripted"),
    readProperty: (_target, request) =>
      Effect.suspend((): Effect.Effect<ReadonlyArray<BacnetValue>, BacnetRequestError> => {
        state.rp++
        const refused = refusal()
        if (refused !== undefined) return refused
        if (state.missing.has(request.object.instance)) return Effect.fail(unknownObject)
        if (request.property === PropertyId["max-apdu-length-accepted"]) {
          return Effect.succeed([{ type: "unsigned" as const, value: state.maxApdu }])
        }
        return Effect.succeed([{ type: "real" as const, value: state.value }])
      }),
    readPropertyMultiple: (_target, specifications) =>
      Effect.suspend((): Effect.Effect<ReadonlyArray<ReadAccessResult>, BacnetRequestError> => {
        state.rpm++
        const refused = refusal()
        if (refused !== undefined) return refused
        if (state.mode === "reject-rpm") {
          return Effect.fail(
            new BacnetDeviceError({
              kind: "reject",
              code: RejectReason.UnrecognizedService,
              message: "rejected: unrecognized-service"
            })
          )
        }
        if (state.mode === "error-rpm" || specifications.some((spec) => state.missing.has(spec.object.instance))) {
          return Effect.fail(unknownObject)
        }
        return Effect.succeed(
          specifications.map((specification) => ({
            object: specification.object,
            results: specification.properties.map(({ property }) => ({
              property,
              _tag: "Value" as const,
              values: [{ type: "real" as const, value: state.value }]
            }))
          }))
        )
      }),
    discover: () => Effect.succeed([]),
    locate: (instance) =>
      Effect.suspend(() => {
        state.locate++
        return state.mode === "timeout" || !state.answersWhoIs
          ? Effect.fail(timeout)
          : Effect.succeed({ instance, address: state.at, maxApdu: state.maxApdu, segmentation: 3, vendorId: 1 })
      }),
    subscribeCov: (target, request) =>
      Effect.suspend((): Effect.Effect<void, BacnetRequestError> => {
        state.subscribes.push({
          at: NetAddress.formatInet(target.address),
          instance: request.object.instance,
          cancel: request.lifetime === undefined
        })
        const refused = refusal()
        return refused ?? state.subscribe(request)
      }),
    newProcessId: Effect.succeed(1),
    onCovNotification: (_processId, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          state.listener = listener
        }),
        () =>
          Effect.sync(() => {
            state.listener = undefined
          })
      )
  }
  /** A notification of analog-input 1's present value. */
  const notify = (value: number) =>
    state.listener?.(
      {
        processId: 1,
        initiatingDevice: { objectType: ObjectType.device, instance: 2001 },
        object: { objectType: ObjectType["analog-input"], instance: 1 },
        timeRemaining: 300,
        values: [{ property: PropertyId["present-value"], values: [{ type: "real", value }] }]
      },
      { address: state.at }
    )
  const subscribed = () => state.subscribes.filter((subscribe) => !subscribe.cancel)
  return { state, client, notify, subscribed }
}

/** Let forked fibers run without moving the clock. */
export const settle = TestClock.adjust("1 millis")

/** Every log line written while `effect` runs, by level and message. */
export const captureLogs = () => {
  const lines: Array<{ readonly level: string; readonly message: string }> = []
  const layer = Logger.layer([
    Logger.make((options) => {
      lines.push({ level: options.logLevel, message: String(options.message) })
    })
  ])
  const count = (from = 0) => {
    const byMessage: Record<string, number> = {}
    for (const line of lines.slice(from)) byMessage[line.message] = (byMessage[line.message] ?? 0) + 1
    return byMessage
  }
  return { lines, layer, count }
}

/**
 * A clock whose wall time is the test clock's plus `skew`, while sleeps and
 * monotonic time stay the test clock's: how `Date.now()` and timers behave
 * when NTP steps the time.
 */
export const skewedClock = Effect.gen(function* () {
  const test = yield* TestClock.testClockWith(Effect.succeed)
  const skew = { ms: 1_700_000_000_000 }
  const wallNanos = () => test.currentTimeNanosUnsafe() + BigInt(skew.ms) * 1_000_000n
  // TestClock.adjust calls `adjust` on the current clock, so this one passes it on.
  const clock: Clock.Clock & Pick<TestClock.TestClock, "adjust"> = {
    currentTimeMillisUnsafe: () => test.currentTimeMillisUnsafe() + skew.ms,
    currentTimeMillis: Effect.sync(() => test.currentTimeMillisUnsafe() + skew.ms),
    currentTimeNanosUnsafe: wallNanos,
    currentTimeNanos: Effect.sync(wallNanos),
    monotonicTimeNanosUnsafe: () => test.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: Effect.sync(() => test.monotonicTimeNanosUnsafe()),
    sleep: (duration) => test.sleep(duration),
    adjust: (duration) => test.adjust(duration)
  }
  return { clock, skew }
})
