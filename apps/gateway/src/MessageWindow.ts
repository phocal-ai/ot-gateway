/**
 * Messages per topic per minute, for `/api/messages/window` and `ot-gateway messages --since`: how many the gateway
 * published on each topic, and how many reached the broker, in each of the last `MESSAGE_WINDOW_MINUTES` minutes.
 *
 * Memory is fixed per topic and bounded by the topics the status page keeps anyway (2,000 at most): one `Uint16Array`
 * of two counts per minute, 240 bytes plus the array's own, about a third of a kilobyte, so 0.7 MB at the most and
 * some 100 kB on a site of a few hundred topics. A count stops at 65,535 a minute (a thousand a second on one topic,
 * which the gateway never sends). The minutes run on the monotonic clock, so an NTP step does not move them; when a
 * new minute starts, its slot is cleared in every ring, a pass over the topics once a minute.
 */

const MINUTE_MS = 60_000
const MAX_COUNT = 65_535

/** One more message in `ring[index]`, up to what the slot holds. */
const bump = (ring: Uint16Array, index: number) => {
  ring[index] = Math.min(MAX_COUNT, (ring[index] ?? 0) + 1)
}

export interface MessageMinutes {
  /** A message published on `topic` at monotonic `nowMs`; the topic gets a ring if it has none. */
  readonly published: (topic: string, nowMs: number) => void
  /** A message on `topic` reached the broker at monotonic `nowMs`; nothing for a topic without a ring. */
  readonly delivered: (topic: string, nowMs: number) => void
  /** Forget `topic` (its retained message was cleared). */
  readonly remove: (topic: string) => void
  /**
   * The counts of the last `minutes` minutes up to monotonic `nowMs` (the current minute and the ones before it,
   * at most the ring's length), per topic with any, and the monotonic ms the first of those minutes started.
   */
  readonly window: (
    minutes: number,
    nowMs: number
  ) => {
    readonly fromMs: number
    readonly counts: ReadonlyMap<string, { readonly published: number; readonly delivered: number }>
  }
}

export const makeMessageMinutes = (length: number): MessageMinutes => {
  /** Which minute each slot holds now, on the monotonic clock. */
  const slotMinute = new Float64Array(length).fill(Number.NEGATIVE_INFINITY)
  let current = Number.NEGATIVE_INFINITY
  /** Per topic: published counts in `[0, length)`, delivered in `[length, 2 * length)`. */
  const rings = new Map<string, Uint16Array>()
  const slotOf = (minute: number) => ((minute % length) + length) % length

  /** Moves to the minute of `nowMs`, clearing the slots of the minutes it passes. Returns its slot. */
  const advance = (nowMs: number) => {
    const minute = Math.floor(nowMs / MINUTE_MS)
    if (minute > current) {
      const steps = current === Number.NEGATIVE_INFINITY ? length : Math.min(length, minute - current)
      for (let passed = minute - steps + 1; passed <= minute; passed++) {
        const slot = slotOf(passed)
        slotMinute[slot] = passed
        for (const ring of rings.values()) {
          ring[slot] = 0
          ring[length + slot] = 0
        }
      }
      current = minute
    }
    // A time before the current minute (the clock does not go back, but a caller may be late) counts in it.
    return slotOf(current)
  }

  return {
    published: (topic, nowMs) => {
      const slot = advance(nowMs)
      let ring = rings.get(topic)
      if (ring === undefined) {
        ring = new Uint16Array(2 * length)
        rings.set(topic, ring)
      }
      bump(ring, slot)
    },
    delivered: (topic, nowMs) => {
      const slot = advance(nowMs)
      const ring = rings.get(topic)
      if (ring !== undefined) bump(ring, length + slot)
    },
    remove: (topic) => {
      rings.delete(topic)
    },
    window: (minutes, nowMs) => {
      advance(nowMs)
      const span = Math.max(1, Math.min(length, Math.floor(minutes)))
      const first = current - span + 1
      const counts = new Map<string, { readonly published: number; readonly delivered: number }>()
      for (const [topic, ring] of rings) {
        let published = 0
        let delivered = 0
        for (let slot = 0; slot < length; slot++) {
          const minute = slotMinute[slot] ?? Number.NEGATIVE_INFINITY
          if (minute < first || minute > current) continue
          published += ring[slot] ?? 0
          delivered += ring[length + slot] ?? 0
        }
        if (published > 0 || delivered > 0) counts.set(topic, { published, delivered })
      }
      return { fromMs: first * MINUTE_MS, counts }
    }
  }
}
