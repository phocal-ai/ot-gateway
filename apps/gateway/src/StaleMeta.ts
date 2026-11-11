/**
 * Retained metadata of points that are gone. A point's `.../$meta` is published retained, so after a point is
 * renamed or removed from the config the broker keeps describing it to every new subscriber: a ghost point.
 *
 * So on every connection the gateway subscribes to the `$meta` of its own devices, and clears (an empty retained
 * message, MQTT 5 §3.3.1.3) each retained one whose point is not in its config and that it published itself: every
 * `$meta` names its gateway (`"gateway": "<id>"`). Metadata without that field (from a release before it, or from
 * another publisher) or naming another gateway is left alone, so two gateways that share a device id in one
 * building never clear each other's points. Devices it does not have are never touched either; the metadata of a
 * device removed from the config stays, as nothing says whose it is now.
 *
 * Only retained deliveries count: the broker sends those on subscribing, and the gateway's own live metadata
 * comes back without the flag.
 */
import { Publisher } from "@ot-gateway/core"
import type { InboundMessage, Subscription } from "@ot-gateway/mqtt"
import { Effect, Option, Queue, Schema } from "effect"

/** Ghosts waiting to be cleared; more are dropped and come back with the next connection's retained messages. */
const MAX_PENDING = 1024

/** What the cleaner reads of a config: who it is, where, and which devices and points it has. */
export interface MetaOwner {
  /** The gateway's id, which its `$meta` names. */
  readonly id: string
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

/** The one field of a `$meta` payload the cleaner reads: the gateway that published it. */
const decodeMetaGateway = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ gateway: Schema.optionalKey(Schema.String) }))
)

/**
 * What to do with a retained `$meta` of a point that one of the config's devices no longer has: `clear` it when this
 * gateway published it, `skip` it when another gateway did or the payload does not say (`owner` undefined).
 */
export type StaleMeta =
  | { readonly _tag: "clear"; readonly topic: string }
  | { readonly _tag: "skip"; readonly topic: string; readonly owner: string | undefined }

/** `undefined` for everything else: a point the config has, another device or building, a live or empty message. */
export const staleMeta = (
  config: MetaOwner,
  message: Pick<InboundMessage, "topic" | "payload" | "retain">
): StaleMeta | undefined => {
  if (!message.retain || message.payload === "") return undefined
  const parts = message.topic.split("/")
  if (parts.length !== 5 || parts[0] !== config.site || parts[1] !== config.building || parts[4] !== "$meta") {
    return undefined
  }
  const device = config.devices.find((candidate) => candidate.id === parts[2])
  if (device === undefined || device.points.some((point) => point.id === parts[3])) return undefined
  const owner = Option.getOrUndefined(decodeMetaGateway(message.payload))?.gateway
  return owner === config.id ? { _tag: "clear", topic: message.topic } : { _tag: "skip", topic: message.topic, owner }
}

/** The topic of a retained message to clear: this gateway's metadata of a point its config no longer has. */
export const staleMetaTopic = (config: MetaOwner, message: Pick<InboundMessage, "topic" | "payload" | "retain">) => {
  const found = staleMeta(config, message)
  return found?._tag === "clear" ? found.topic : undefined
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
  // Metadata the gateway leaves alone is said once per run, at debug: it is normal where gateways share a building.
  let skipped = false
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
      const found = staleMeta(config, message)
      if (found === undefined) return Effect.void
      if (found._tag === "clear") return Queue.offer(pending, found.topic).pipe(Effect.asVoid)
      if (skipped) return Effect.void
      skipped = true
      return Effect.logDebug(
        "left the retained metadata of a point not in the config alone: this gateway did not publish it"
      ).pipe(Effect.annotateLogs({ topic: found.topic, publishedBy: found.owner ?? "unknown" }))
    },
    run: Effect.forever(Effect.flatMap(Queue.take(pending), clear))
  } satisfies StaleMetaCleaner
})
