/**
 * What the Status page's Broker, Devices and Buffer cards open into: the counts and words behind each card.
 */
import type { BufferStatus, DeviceStatus } from "@ot-gateway/api"
import { formatNumber } from "./format"
import { failureLabel, type Freshness, freshness, protocolName } from "./status"

/** Why the buffer gave messages up, in words (the `reason` of `ot_gateway_buffer_dropped`). */
const dropWords: Readonly<Record<string, string>> = {
  overflow: "the buffer was full, so the oldest were dropped",
  rejected: "the broker refused them",
  unreadable: "they could no longer be read from disk",
  undeliverable: "they broke the connection three times in a row",
  lost: "the buffer file was replaced or damaged"
}

export const dropReason = (reason: string) => dropWords[reason] ?? reason

/** The reasons something was dropped for, most first, in words. */
export const dropReasons = (droppedBy: Readonly<Record<string, number>>) =>
  Object.entries(droppedBy)
    .filter(([, count]) => count > 0)
    .toSorted(([, a], [, b]) => b - a)
    .map(([reason, count]) => ({ reason, count, words: dropReason(reason) }))

/** How many devices are in each state, as the Devices list shows them. */
export const deviceCounts = (devices: ReadonlyArray<DeviceStatus>, now: number) => {
  const counts: Record<Freshness["_tag"], number> = { live: 0, starting: 0, late: 0, failing: 0 }
  for (const device of devices) counts[freshness(device, now)._tag]++
  return counts
}

/**
 * The failing devices the Devices card names, in config order: the first `max` with why ("cannot connect"), and how
 * many more fail, so a phone shows which device it is without scrolling to the list.
 */
export const failingDevices = (devices: ReadonlyArray<DeviceStatus>, max = 2) => {
  const failing = devices.filter((device) => device.status === "failing")
  return {
    shown: failing.slice(0, max).map((device) => ({ id: device.id, why: failureLabel(device.reason ?? "failing") })),
    more: Math.max(0, failing.length - max)
  }
}

/** Devices and points per protocol, the most devices first. */
export const protocolCounts = (devices: ReadonlyArray<DeviceStatus>) => {
  const byProtocol = new Map<string, { devices: number; points: number }>()
  for (const device of devices) {
    const entry = byProtocol.get(device.protocol) ?? { devices: 0, points: 0 }
    entry.devices++
    entry.points += device.pointCount
    byProtocol.set(device.protocol, entry)
  }
  return [...byProtocol]
    .toSorted(([, a], [, b]) => b.devices - a.devices)
    .map(([protocol, counts]) => ({ protocol, name: protocolName[protocol] ?? protocol, ...counts }))
}

/** Reconnects: every successful connect after the first. */
export const reconnects = (connects: number) => Math.max(0, connects - 1)

/** The buffer's size at one poll, by the gateway's clock, and which run of the gateway it is from. */
export interface BufferSample {
  readonly at: number
  readonly since: number
  readonly rows: number
}

/** The trend is taken over the last minute of polls, and only once they span this much, so one poll cannot swing it. */
export const TREND_WINDOW_MS = 60_000
export const TREND_MIN_SPAN_MS = 10_000

/**
 * The samples with a new one: those older than a minute go, and all of them when the gateway restarted or its clock
 * went back (an NTP step), since a trend across either means nothing.
 */
export const addSample = (samples: ReadonlyArray<BufferSample>, sample: BufferSample): ReadonlyArray<BufferSample> => {
  const last = samples.at(-1)
  if (last !== undefined && (last.since !== sample.since || sample.at < last.at)) return [sample]
  if (last !== undefined && last.at === sample.at) return samples
  return [...samples.filter((kept) => sample.at - kept.at <= TREND_WINDOW_MS), sample]
}

/** How fast the buffer grows (positive) or empties (negative), in messages per second; unknown until it can tell. */
export const bufferRate = (samples: ReadonlyArray<BufferSample>): number | undefined => {
  const first = samples[0]
  const last = samples.at(-1)
  if (first === undefined || last === undefined || samples.length < 3) return undefined
  const span = last.at - first.at
  return span < TREND_MIN_SPAN_MS ? undefined : ((last.rows - first.rows) / span) * 1000
}

/** A time ahead, as rough as an estimate from one minute deserves: "under a minute", "about 4 min", "about 3 h", "about 2 days". */
export const roughly = (ms: number) => {
  const minutes = ms / 60_000
  if (minutes < 1) return "under a minute"
  if (minutes < 60) return `about ${Math.round(minutes)} min`
  const hours = minutes / 60
  if (hours < 48) return `about ${Math.round(hours)} h`
  return `about ${Math.round(hours / 24)} days`
}

/** What the Buffer card says: whether values are safe while the broker is away, and for how long. */
export interface BufferView {
  readonly title: string
  readonly note: string
  /** Values are being lost, or will be if the broker goes. */
  readonly bad: boolean
  /** Messages given up since the gateway started; shown apart, since they are past and the rest is now. */
  readonly dropped: number
}

export const bufferView = (
  buffer: BufferStatus | undefined,
  brokerConnected: boolean,
  rate: number | undefined
): BufferView => {
  if (buffer === undefined)
    return {
      title: "Off",
      note: brokerConnected ? "values are lost while the broker is down" : "values are lost until the broker is back",
      bad: !brokerConnected,
      dropped: 0
    }
  const { rows, maxRows, dropped } = buffer
  if (buffer.disabled) return { title: "Failed", note: "values are lost while the broker is down", bad: true, dropped }
  if (rows >= maxRows) return { title: "Full", note: "the oldest values are being dropped", bad: true, dropped }
  if (rows === 0)
    return {
      title: "Nothing waiting",
      note: brokerConnected ? "values go straight to the broker" : "values wait here until the broker is back",
      bad: false,
      dropped
    }
  const title = `${formatNumber(rows)} waiting`
  if (!brokerConnected)
    return {
      title,
      note:
        rate !== undefined && rate > 0
          ? `full in ${roughly(((maxRows - rows) / rate) * 1000)} at this rate`
          : "for the broker to be back",
      bad: false,
      dropped
    }
  return {
    title,
    note: rate !== undefined && rate < 0 ? `sending, ${roughly((rows / -rate) * 1000)} left` : "sending to the broker",
    bad: false,
    dropped
  }
}
