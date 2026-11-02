/**
 * Topic convention: `site/building/device/point`.
 * Point metadata is published retained on `site/building/device/point/$meta`.
 */
import type { Slug } from "./Point.ts"

export interface TopicParts {
  readonly site: Slug
  readonly building: Slug
  readonly device: Slug
  readonly point: Slug
}

export const pointTopic = (parts: TopicParts): string =>
  `${parts.site}/${parts.building}/${parts.device}/${parts.point}`

export const metaTopic = (parts: TopicParts): string => `${pointTopic(parts)}/$meta`

/** Gateway health, published retained and used as the MQTT last will. */
export const healthTopic = (site: Slug, building: Slug, gatewayId: string): string =>
  `${site}/${building}/$gateway/${gatewayId}/health`
