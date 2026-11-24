/**
 * The pure helpers the CLI and the status page share: gaps between buckets with reads, message totals, and the words
 * for a counter jump and an alarm state nobody saw.
 */
import { describe, expect, it } from "@effect/vitest"
import {
  counterShareText,
  type MessageStatus,
  messageTotals,
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

const message = (topic: string, count: number, delivered = count): MessageStatus => ({
  topic,
  payload: "",
  truncated: false,
  retained: false,
  at: 0,
  count,
  delivered
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
    ).toEqual({ values: 10, meta: 1, health: 3, other: 2, all: 16, delivered: 14 })
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
