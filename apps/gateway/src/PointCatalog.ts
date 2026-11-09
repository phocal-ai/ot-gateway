/**
 * The points page's catalog (`GET /api/points`): every configured point with
 * its topic, where it is read, how its values go out and its semantics. Pure
 * and taken from the config alone, so the gateway builds it once.
 */
import type { PointCatalog, PointInfo } from "@ot-gateway/api"
import {
  type AnyPoint,
  type BacnetPoint,
  type Device,
  type GatewayConfig,
  type ModbusPoint,
  type Publish,
  pointTopic,
  publishOf,
  type SimulatedPoint
} from "@ot-gateway/core"

/** 60000 → "1 min", 900000 → "15 min", 3600000 → "1 h": publish intervals divide a day, so these stay whole. */
export const durationLabel = (ms: number) => {
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(1))} s`
  if (ms < 3_600_000) return `${Number((ms / 60_000).toFixed(1))} min`
  return `${Number((ms / 3_600_000).toFixed(1))} h`
}

/** A publish mode in a few words, as the page shows it. */
export const publishLabel = (publish: Publish): string => {
  switch (publish.mode) {
    case "sample":
      return publish.intervalMs === undefined ? "every read" : `latest, every ${durationLabel(publish.intervalMs)}`
    case "aggregate":
      return `aggregate every ${durationLabel(publish.intervalMs)}`
    case "change": {
      const change =
        publish.deadband === undefined || publish.deadband === 0 ? "on change" : `on change ≥ ${publish.deadband}`
      return publish.maxSilenceMs === undefined
        ? change
        : `${change}, at least every ${durationLabel(publish.maxSilenceMs)}`
    }
  }
}

/** Where a point is read, in the config's words. */
const modbusSource = (point: ModbusPoint) => {
  const bit = point.bit === undefined ? "" : ` bit ${point.bit}`
  const order = point.table === "holding" || point.table === "input" ? ` ${point.byteOrder}` : ""
  return `${point.table} ${point.address}${bit} · ${point.dataType}${order}`
}

const bacnetSource = (point: BacnetPoint) =>
  `${point.objectType} ${point.instance} · ${point.property}${point.writable ? ` · priority ${point.priority}` : ""}`

const simulatedSource = (point: SimulatedPoint) =>
  point.waveform === "constant"
    ? `constant ${point.min}`
    : `${point.waveform} ${point.min} to ${point.max} · ${durationLabel(point.periodSeconds * 1000)}`

/** Each point of a device with where it is read. */
const sourcedPoints = (device: Device): ReadonlyArray<readonly [AnyPoint, string]> => {
  switch (device.protocol) {
    case "modbus-tcp":
      return device.points.map((point) => [point, modbusSource(point)] as const)
    case "bacnet-ip":
      return device.points.map((point) => [point, bacnetSource(point)] as const)
    case "simulator":
      return device.points.map((point) => [point, simulatedSource(point)] as const)
  }
}

export const pointCatalog = (config: GatewayConfig): PointCatalog => ({
  points: config.devices.flatMap((device) =>
    sourcedPoints(device).map(([point, source]): PointInfo => {
      const semantics = point.semantics
      return {
        device: device.id,
        id: point.id,
        name: point.name,
        ...(point.unit === undefined ? {} : { unit: point.unit }),
        writable: point.writable,
        topic: pointTopic({ site: config.site, building: config.building, device: device.id, point: point.id }),
        source,
        publish: publishLabel(publishOf(device.publish, point)),
        ...(point.limits === undefined ? {} : { limits: point.limits }),
        ...(point.scaling === undefined ? {} : { scaling: point.scaling }),
        ...(semantics?.brick === undefined ? {} : { brick: semantics.brick }),
        ...(semantics?.haystack === undefined ? {} : { haystack: semantics.haystack })
      }
    })
  )
})
