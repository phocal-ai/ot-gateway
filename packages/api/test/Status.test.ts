/**
 * The pure helpers the CLI and the status page share: gaps between buckets with reads, message totals, and the words
 * for a counter jump and an alarm state nobody saw.
 */
import { describe, expect, it } from "@effect/vitest"
import {
  counterShareText,
  drainedParts,
  type MessageStatus,
  messageShortfall,
  messageTotals,
  shortfallWords,
  readGapMs,
  readGaps,
  topicKind,
  unknownStateText
} from "../src/Status.ts"

const bucket = (t: number, first?: number, last?: number) => ({
  t,
  min: 1,
  max: 1,
  avg: 1,
  count: 1,
  ...(first === undefined ? {} : { first }),
  ...(last === undefined ? {} : { last })
})

describe("readGaps", () => {
  it("waits a few poll intervals, and never less than 30 s", () => {
    expect(readGapMs(5_000)).toBe(30_000)
    expect(readGapMs(60_000)).toBe(180_000)
  })

  it("finds reads far apart in neighbouring buckets, and leaves wider pairs and buckets without times alone", () => {
    const buckets = [
      bucket(0, 0, 20_000),
      bucket(60_000, 113_000, 119_000),
      bucket(120_000, 120_000, 170_000),
      // Two steps on: the caller's empty bucket between says it.
      bucket(240_000, 290_000, 299_000),
      bucket(300_000)
    ]
    expect(readGaps(buckets, { apartMs: 60_000, minGapMs: 30_000 })).toEqual([
      { from: 20_000, to: 113_000, before: 60_000 }
    ])
    expect(readGaps(buckets, { apartMs: 120_000, minGapMs: 30_000 })).toEqual([
      { from: 20_000, to: 113_000, before: 60_000 },
      { from: 170_000, to: 290_000, before: 240_000 }
    ])
  })
})

const message = (
  topic: string,
  count: number,
  delivered = count,
  unsent: { readonly notSent?: number; readonly lost?: number } = {}
): MessageStatus => ({
  topic,
  payload: "",
  truncated: false,
  retained: topic.endsWith("/$meta") || topic.endsWith("/health"),
  at: 0,
  count,
  delivered,
  ...unsent
})

describe("messageTotals", () => {
  it("adds the topics up by kind, and what reached the broker", () => {
    expect(topicKind("s/b/$gateway/main/health")).toBe("health")
    expect(
      messageTotals([
        message("s/b/meter/power", 10, 8),
        message("s/b/meter/power/$meta", 1),
        message("s/b/$gateway/main/health", 3),
        message("s/b/meter/valve/$set/result", 2)
      ])
    ).toEqual({ values: 10, meta: 1, health: 3, other: 2, all: 16, delivered: 14, waiting: 2, notSent: 0, lost: 0 })
  })

  it("tells waiting values from retained messages not sent while the broker was away, and from lost ones", () => {
    // The outage of the report: 5 health messages missed the broker, values waited in the buffer and went out.
    const totals = messageTotals([
      message("s/b/meter/power", 1_420, 1_408, { lost: 2 }),
      message("s/b/$gateway/main/health", 14, 9, { notSent: 5 })
    ])
    expect(totals).toMatchObject({ all: 1_434, delivered: 1_417, waiting: 10, notSent: 5, lost: 2 })
    expect(shortfallWords(totals, { dropped: 0 })).toEqual([
      "10 waiting in the buffer",
      "5 not sent while the broker was away: retained, not buffered, the latest goes out on reconnect",
      "2 lost: not sent, not buffered"
    ])
    // Once the buffer dropped any, a waiting one may be among them; without a buffer, they wait for the broker.
    expect(
      shortfallWords({ waiting: 1_200, notSent: 0, lost: 0 }, { dropped: 3 }, (count) => count.toLocaleString("en-US"))
    ).toEqual(["1,200 waiting in the buffer or dropped by it"])
    expect(shortfallWords({ waiting: 1, notSent: 0, lost: 0 }, undefined)).toEqual(["1 waiting for the broker"])
    // Everything arrived: nothing to say.
    expect(shortfallWords(messageTotals([message("s/b/meter/power", 3)]), undefined)).toEqual([])
  })

  it("reads an older gateway's topic without the new counts, and never waits less than nothing", () => {
    expect(messageShortfall(message("s/b/meter/power", 3, 1))).toEqual({ waiting: 2, notSent: 0, lost: 0 })
    // The buffer kept rows from before a restart: more reached the broker than this run published.
    expect(messageShortfall(message("s/b/meter/power", 3, 5))).toEqual({ waiting: 0, notSent: 0, lost: 0 })
  })
})

describe("drainedParts", () => {
  it("adds a drained buffer up: waiting at the reconnect, queued behind, dropped meanwhile", () => {
    expect(drainedParts({ delivered: 130, buffered: 124, queued: 6 })).toEqual({ buffered: 124, queued: 6, dropped: 0 })
    expect(drainedParts({ delivered: 128, buffered: 124, queued: 6 })).toEqual({ buffered: 124, queued: 6, dropped: 2 })
    // Nothing waited at the reconnect, or an older gateway's event: the count says it all.
    expect(drainedParts({ delivered: 6, buffered: 0, queued: 6 })).toBeUndefined()
    expect(drainedParts({ delivered: 66 })).toBeUndefined()
  })
})

describe("words", () => {
  it("say a counter's rise against its reading", () => {
    expect(counterShareText(12_055, 24_936)).toBe("1.1× its reading")
    expect(counterShareText(1_000, 1_200)).toBe("20 % of its reading")
    expect(counterShareText(0, 5)).toBe("more than its whole reading")
  })

  it("say how long an alarm's state was unknown, when the gateway says", () => {
    expect(unknownStateText(93_000)).toBe("unknown during the 1 min 33 s without data")
    expect(unknownStateText(undefined)).toBe("unknown while its device had no data")
  })
})
