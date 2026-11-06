/**
 * Retained metadata of points that are gone. A point's `.../$meta` is published retained, so after a point is
 * renamed or removed from the config the broker keeps describing it to every new subscriber: a ghost point.
 *
 * A device's topics belong to the gateway that has the device in its config (two gateways with the same device
 * id in one building would publish over each other already). So on every connection the gateway subscribes to
 * the `$meta` of its own devices, and clears (an empty retained message, MQTT 5 §3.3.1.3) each retained one whose
 * point is not in its config. Devices it does not have are never touched, so gateways sharing a building leave
 * each other alone; the metadata of a device removed from the config stays, as nothing says whose it is now.
 *
 * Only retained deliveries count: the broker sends those on subscribing, and the gateway's own live metadata
 * comes back without the flag.
 */
import { Publisher } from "@ot-gateway/core"
import type { InboundMessage, Subscription } from "@ot-gateway/mqtt"
import { Effect, Queue } from "effect"

/** Ghosts waiting to be cleared; more are dropped and come back with the next connection's retained messages. */
const MAX_PENDING = 1024

/** What the cleaner reads of a config: where it is, and which devices and points it has. */
export interface MetaOwner {
  readonly site: string
  readonly building: string
  readonly devices: ReadonlyArray<{ readonly id: string; readonly points: ReadonlyArray<{ readonly id: string }> }>
}

/** One filter per device of the config: its points' metadata, and nothing of other gateways. */
export const metaSubscriptions = (config: MetaOwner) =>
  config.devices.map((device): Subscription => ({
    filter: `${config.site}/${config.building}/${device.id}/+/$meta`,
    qos: 0
  }))

/** The topic of a retained message to clear: metadata of one of the config's devices for a point it no longer has. */
export const staleMetaTopic = (config: MetaOwner, message: Pick<InboundMessage, "topic" | "payload" | "retain">) => {
  if (!message.retain || message.payload === "") return undefined
  const parts = message.topic.split("/")
  if (parts.length !== 5 || parts[0] !== config.site || parts[1] !== config.building || parts[4] !== "$meta") {
    return undefined
  }
  const device = config.devices.find((candidate) => candidate.id === parts[2])
  if (device === undefined) return undefined
  return device.points.some((point) => point.id === parts[3]) ? undefined : message.topic
}

export interface StaleMetaCleaner {
  readonly subscriptions: ReadonlyArray<Subscription>
  /** For the MQTT client's read loop: quick, it only queues the topic. */
  readonly onMessage: (message: InboundMessage) => Effect.Effect<void>
  /** Clears what `onMessage` queued, through the gateway's publisher (and its outbox), until interrupted. */
  readonly run: Effect.Effect<never, never, Publisher>
}

export const makeStaleMetaCleaner = Effect.fn("makeStaleMetaCleaner")(function* (config: MetaOwner) {
  const pending = yield* Queue.dropping<string>(MAX_PENDING)
  const clear = Effect.fn("clearStaleMeta")(function* (topic: string) {
    const publisher = yield* Publisher
    yield* publisher.publish(topic, "", { retain: true }).pipe(
      Effect.andThen(Effect.logInfo("cleared the retained metadata of a point no longer in the config")),
      Effect.catchTag("PublishError", (error) =>
        Effect.logWarning("could not clear the retained metadata of a point no longer in the config").pipe(
          Effect.annotateLogs({ error: error.message })
        )
      ),
      Effect.annotateLogs({ topic })
    )
  })
  return {
    subscriptions: metaSubscriptions(config),
    onMessage: (message) => {
      const topic = staleMetaTopic(config, message)
      return topic === undefined ? Effect.void : Queue.offer(pending, topic).pipe(Effect.asVoid)
    },
    run: Effect.forever(Effect.flatMap(Queue.take(pending), clear))
  } satisfies StaleMetaCleaner
})
