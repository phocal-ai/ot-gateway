/**
 * The points page's pure parts: the catalog from `/api/points`, joined with the live values of `/api/status`,
 * filtered by what the user types and picks. Kept here so they are tested without a browser.
 */
import {
  type DeviceStatus,
  type GatewayStatus,
  MAX_VALUES_PER_REQUEST,
  type PointCatalog,
  type PointInfo,
  type PointReading
} from "@ot-gateway/api"

/** A point's key across the gateway: `device/point`, as in its topic. */
export const pointKey = (point: { readonly device: string; readonly id: string }) => `${point.device}/${point.id}`

/**
 * What a point is called on the page: its name as people read it ("Active power"), or its id when the name is empty.
 * The id (and topic) go under the title, for copying.
 */
export const pointTitle = (point: { readonly id: string; readonly name: string }) => {
  const name = point.name.trim()
  return name === "" ? point.id : name
}

/** Whether the point's title is its id, so the id need not be repeated under it. */
export const titledById = (point: { readonly id: string; readonly name: string }) => pointTitle(point) === point.id

/** What the user filters by; empty strings mean no filter. */
export interface PointFilter {
  readonly query: string
  readonly device: string
}

export const noFilter: PointFilter = { query: "", device: "" }

/**
 * Whether a point matches: every word of the query is found somewhere in its id, name, device, topic, source, unit,
 * Brick class or Haystack tags (case ignored), so "ahu temp" finds the AHU's temperatures.
 */
export const matches = (point: PointInfo, filter: PointFilter) => {
  if (filter.device !== "" && point.device !== filter.device) return false
  return matchesWords(
    [
      point.device,
      point.id,
      point.name,
      point.topic,
      point.source,
      point.unit ?? "",
      point.brick ?? "",
      ...(point.haystack ?? [])
    ].join(" "),
    filter.query
  )
}

/** Whether every word of `query` is found in `text`, case ignored; an empty query matches everything. */
export const matchesWords = (text: string, query: string) => {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
  const haystack = text.toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** A point's last read, as `/api/values` and `/api/status` give it. */
export interface LastRead {
  readonly value?: number | boolean
  readonly ts?: number
}

/** A point's live state: its last read (from `/api/values`) and its device's health (from `/api/status`). */
export interface LivePoint {
  readonly value: LastRead | undefined
  readonly device: DeviceStatus | undefined
}

/** The latest status's devices by id. */
export const devicesById = (status: GatewayStatus | undefined): ReadonlyMap<string, DeviceStatus> =>
  new Map((status?.devices ?? []).map((device) => [device.id, device]))

/** Readings by `device/point`, the newest over what was known. */
export const withReadings = (
  known: ReadonlyMap<string, PointReading>,
  readings: ReadonlyArray<PointReading>
): ReadonlyMap<string, PointReading> => {
  const next = new Map(known)
  for (const reading of readings) next.set(`${reading.device}/${reading.point}`, reading)
  return next
}

/** Longest list of keys in one `/api/values` URL: well under the 16 KB a Node server takes for a request line. */
const MAX_KEY_CHARS = 4000

/** Keys split into `/api/values` requests: at most the server's count each, and short enough for a URL. */
export const chunkKeys = (
  keys: ReadonlyArray<string>,
  limits: { readonly maxKeys: number; readonly maxChars: number } = {
    maxKeys: MAX_VALUES_PER_REQUEST,
    maxChars: MAX_KEY_CHARS
  }
): ReadonlyArray<ReadonlyArray<string>> => {
  const chunks: Array<Array<string>> = []
  let chunk: Array<string> = []
  let chars = 0
  for (const key of keys) {
    if (chunk.length > 0 && (chunk.length >= limits.maxKeys || chars + key.length + 1 > limits.maxChars)) {
      chunks.push(chunk)
      chunk = []
      chars = 0
    }
    chunk.push(key)
    chars += key.length + 1
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

/** The filter as URL query parameters, so a filtered view can be linked; defaults are left out. */
export const filterToSearch = (filter: PointFilter, open: string | undefined) => {
  const params = new URLSearchParams()
  if (filter.query !== "") params.set("q", filter.query)
  if (filter.device !== "") params.set("device", filter.device)
  if (open !== undefined) params.set("point", open)
  const search = params.toString()
  return search === "" ? "" : `?${search}`
}

/** The filter and the open point from a URL's query; unknown devices and points are dropped by the caller. */
export const filterFromSearch = (search: string): { readonly filter: PointFilter; readonly open?: string } => {
  const params = new URLSearchParams(search)
  const open = params.get("point")
  return {
    filter: {
      query: params.get("q") ?? "",
      device: params.get("device") ?? ""
    },
    ...(open === null ? {} : { open })
  }
}

/** The devices of a catalog, in config order, each once with how many points it has. */
export const devicesOf = (catalog: PointCatalog): ReadonlyArray<{ readonly id: string; readonly points: number }> => {
  const counts = new Map<string, number>()
  for (const point of catalog.points) counts.set(point.device, (counts.get(point.device) ?? 0) + 1)
  return [...counts].map(([id, points]) => ({ id, points }))
}
