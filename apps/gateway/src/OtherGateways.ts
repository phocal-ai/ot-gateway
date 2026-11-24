/**
 * Another gateway publishing into this gateway's topics. Gateways may share a building (`site/building`) as long
 * as their devices differ; two that run a device of the same id publish into the same `site/building/device/...`
 * topics, and whoever reads them gets both gateways' values mixed, with nothing to say so. That is easy to do by
 * copying a folder, or by starting a second gateway on a laptop to test.
 *
 * So the gateway subscribes to the health of every gateway of its building (`site/building/$gateway/+/health`):
 * the broker sends each one's retained health on subscribing, and each gateway refreshes it every
 * `healthIntervalMs`. When one with another id is online and lists a device this gateway also has, it says so
 * loudly, once per other gateway per run: a warning in the log and an event (the status page's Events card,
 * `ot-gateway events`). Gateways that share a building with different devices are left in peace.
 *
 * A copy with the same gateway id publishes on this gateway's own health topic. Its retained message cannot be told
 * from this gateway's own of a previous run, so only live ones count: one whose `since` is not this run's start came
 * from another process.
 */
import type { InboundMessage, Subscription } from "@ot-gateway/mqtt"
import { Effect, Option, Schema } from "effect"

/** What the check reads of a config: who this gateway is, where, and its devices. */
export interface GatewayIdentity {
  readonly id: string
  readonly site: string
  readonly building: string
  readonly devices: ReadonlyArray<{ readonly id: string }>
}

/** The health of every gateway in the building, this one's included (it is told apart by its id). */
export const healthSubscription = (config: GatewayIdentity): Subscription => ({
  filter: `${config.site}/${config.building}/$gateway/+/health`,
  qos: 0,
  // This gateway's own health stays home: on MQTT 5, every message on its topic then comes from someone else.
  noLocal: true
})

/** The part of a health message the check reads: online, and which devices. */
const decodeHealth = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.String,
      since: Schema.optionalKey(Schema.Number),
      devices: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
    })
  )
)

/**
 * Another gateway online in the building with devices of the same ids as this one's, or (`sameId`) with this
 * gateway's own id.
 */
export interface GatewayOverlap {
  readonly gateway: string
  readonly devices: ReadonlyArray<string>
  readonly sameId: boolean
}

/**
 * The overlap a health message shows, or `undefined`: this gateway's own message, another building, offline, or no
 * shared device. `startedAt` is this run's `since`, which tells this gateway's own health from a copy's.
 */
export const overlapOf = (
  config: GatewayIdentity,
  startedAt: number,
  message: Pick<InboundMessage, "topic" | "payload" | "retain">
): GatewayOverlap | undefined => {
  const parts = message.topic.split("/")
  if (
    parts.length !== 5 ||
    parts[0] !== config.site ||
    parts[1] !== config.building ||
    parts[2] !== "$gateway" ||
    parts[4] !== "health"
  ) {
    return undefined
  }
  const gateway = parts[3]
  if (gateway === undefined) return undefined
  const health = Option.getOrUndefined(decodeHealth(message.payload))
  if (health?.status !== "online") return undefined
  if (gateway === config.id) {
    if (message.retain || health.since === undefined || health.since === startedAt) return undefined
    return { gateway, devices: [], sameId: true }
  }
  const theirs = health.devices ?? {}
  const devices = config.devices.map((device) => device.id).filter((id) => Object.hasOwn(theirs, id))
  return devices.length === 0 ? undefined : { gateway, devices, sameId: false }
}

/** What the gateway was told of an overlap, for the log and the events. */
export const overlapMessage = (config: GatewayIdentity, overlap: GatewayOverlap) =>
  overlap.sameId
    ? `another gateway with this gateway's id, "${overlap.gateway}", is online in ${config.site}/${config.building}: both publish into the same topics and their values mix. Stop one of them, or give each its own "id" and "mqtt.clientId".`
    : `another gateway, "${overlap.gateway}", is online in ${config.site}/${config.building} with the same device ids (${overlap.devices.join(", ")}): both publish into the same topics and their values mix. Stop one of them, or give one of them another site, building or device ids.`

export interface OtherGatewaysCheck {
  readonly subscription: Subscription
  /** For the MQTT client's read loop: quick, it decodes one small message and at most logs once. */
  readonly onMessage: (message: InboundMessage) => Effect.Effect<void>
}

/** The check, telling `onOverlap` the first time each other gateway is seen publishing a device of this one's. */
export const makeOtherGatewaysCheck = (
  config: GatewayIdentity,
  startedAt: number,
  onOverlap: (overlap: GatewayOverlap) => void
): OtherGatewaysCheck => {
  const reported = new Set<string>()
  return {
    subscription: healthSubscription(config),
    onMessage: (message) => {
      const overlap = overlapOf(config, startedAt, message)
      if (overlap === undefined || reported.has(overlap.gateway)) return Effect.void
      reported.add(overlap.gateway)
      onOverlap(overlap)
      return Effect.logWarning(overlapMessage(config, overlap)).pipe(
        Effect.annotateLogs({ otherGateway: overlap.gateway, devices: overlap.devices.join(",") })
      )
    }
  }
}
