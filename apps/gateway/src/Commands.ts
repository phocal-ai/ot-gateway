/**
 * Commands from MQTT to the command guard. The connection's read loop only
 * stamps each one with its arrival time and drops it into the inbox; a
 * dispatcher hands it to its device's own queue, and one worker per device
 * with writable points runs the guard, a command at a time. So a device that
 * stops answering delays only its own commands, never another device's, and
 * the guard refuses a command that waited too long instead of applying it
 * late (`maxAge` in `makeCommandGuard`).
 *
 * Every queue drops what does not fit. A dropped command is counted in
 * `plenum_commands{outcome="dropped"}` and logged when dropping starts and
 * when it stops, not once per message: a flood must not flood the logs too.
 */
import { commands, type InboundCommand, monotonicMillis } from "@plenum/core"
import type { GatewayConfig, Publisher } from "@plenum/core"
import type { InboundMessage } from "@plenum/mqtt"
import { Effect, Metric, Queue } from "effect"

/** Commands received and not yet dispatched. */
const INBOX = 64
/** Commands waiting for one device; beyond this they are dropped. */
const PER_DEVICE = 16

/** Count a dropped command; log the first of a run of drops, and the end of it. */
const makeDropTracker = (queue: string) => {
  let dropped = 0
  return (accepted: boolean): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (accepted) {
        if (dropped === 0) return Effect.void
        const count = dropped
        dropped = 0
        return Effect.logInfo("taking commands again").pipe(Effect.annotateLogs({ queue, dropped: count }))
      }
      dropped++
      const counted = Metric.update(Metric.withAttributes(commands, { outcome: "dropped", reason: "backlog" }), 1)
      return dropped === 1
        ? Effect.andThen(
            counted,
            Effect.logWarning("too many commands waiting, dropping them").pipe(Effect.annotateLogs({ queue }))
          )
        : counted
    })
}

export interface CommandRouting {
  /** For the MQTT client: called on its read loop, never blocks. */
  readonly onMessage: (message: InboundMessage) => Effect.Effect<void>
  /** The dispatcher and the per-device workers; runs until interrupted. */
  readonly run: Effect.Effect<void, never, Publisher>
}

export const makeCommandRouting = Effect.fnUntraced(function* (
  config: GatewayConfig,
  handle: (command: InboundCommand) => Effect.Effect<void, never, Publisher>
) {
  const inbox = yield* Queue.dropping<InboundCommand>(INBOX)
  const inboxDrops = makeDropTracker("inbox")
  // A queue per device with something to write; everything else is refused at once, so one queue serves it.
  const writable = config.devices.filter((device) => device.points.some((point) => point.writable))
  const queues = new Map<
    string,
    { readonly queue: Queue.Queue<InboundCommand>; readonly drops: ReturnType<typeof makeDropTracker> }
  >()
  for (const device of writable) {
    queues.set(device.id, {
      queue: yield* Queue.dropping<InboundCommand>(PER_DEVICE),
      drops: makeDropTracker(device.id)
    })
  }
  const other = { queue: yield* Queue.dropping<InboundCommand>(PER_DEVICE), drops: makeDropTracker("other") }
  const prefix = `${config.site}/${config.building}/`

  const onMessage = (message: InboundMessage) =>
    Effect.gen(function* () {
      const command: InboundCommand = {
        topic: message.topic,
        payload: message.payload,
        retain: message.retain,
        receivedAt: yield* monotonicMillis,
        ...(message.messageExpirySeconds === undefined ? {} : { expirySeconds: message.messageExpirySeconds }),
        ...(message.correlationData === undefined ? {} : { correlationData: message.correlationData })
      }
      yield* inboxDrops(yield* Queue.offer(inbox, command))
    })

  const dispatch = Effect.gen(function* () {
    const command = yield* Queue.take(inbox)
    const deviceId = command.topic.startsWith(prefix) ? command.topic.slice(prefix.length).split("/", 1)[0] : undefined
    const target = (deviceId === undefined ? undefined : queues.get(deviceId)) ?? other
    yield* target.drops(yield* Queue.offer(target.queue, command))
  })
  const worker = (queue: Queue.Queue<InboundCommand>) => Effect.forever(Effect.flatMap(Queue.take(queue), handle))

  const run = Effect.all(
    [Effect.forever(dispatch), worker(other.queue), ...[...queues.values()].map(({ queue }) => worker(queue))],
    { concurrency: "unbounded", discard: true }
  )
  return { onMessage, run } satisfies CommandRouting
})
