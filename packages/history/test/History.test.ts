/**
 * The history keeps every read for a day and per-minute rollups for `retentionDays`, writes in batches, and never
 * stops the gateway: a file it cannot open leaves it without history, a corrupt one is moved aside.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { historyDisabled, historyDropped } from "@ot-gateway/core"
import { Effect, FileSystem, Metric } from "effect"
import { TestClock } from "effect/testing"
import { MAX_PENDING, openHistory, rollup, stepFor } from "../src/index.ts"

const DAY = 86_400_000

const tempPath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ot-gateway-history-" })
  return `${dir}/history.sqlite`
})

describe("rollup and stepFor", () => {
  it("rolls reads up per point and minute", () => {
    expect(
      rollup([
        { device: "d", point: "p", ts: 0, value: 1 },
        { device: "d", point: "p", ts: 59_999, value: 3 },
        { device: "d", point: "p", ts: 60_000, value: 5 },
        { device: "d", point: "q", ts: 0, value: 7 }
      ])
    ).toEqual([
      { device: "d", point: "p", minute: 0, min: 1, max: 3, sum: 4, count: 2 },
      { device: "d", point: "p", minute: 60_000, min: 5, max: 5, sum: 5, count: 1 },
      { device: "d", point: "q", minute: 0, min: 7, max: 7, sum: 7, count: 1 }
    ])
  })

  it("steps in whole seconds or minutes, and never past 2,000 buckets", () => {
    expect(stepFor(0, 3_600_000, 300, 1_000)).toBe(12_000)
    expect(stepFor(0, 10_000, 300, 1_000)).toBe(1_000)
    expect(stepFor(0, 7 * DAY, 300, 60_000)).toBe(2_040_000)
    expect(stepFor(0, DAY, 1_000_000, 1_000)).toBe(44_000)
  })
})

describe("openHistory", () => {
  it.effect("writes reads in batches and returns them in buckets", () =>
    Effect.gen(function* () {
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 })
      for (let second = 0; second < 10; second++) history.sink.record("ahu-1", "temp", second, second * 1000)
      // Nothing is written before the first flush.
      expect(
        (yield* history.series({ device: "ahu-1", point: "temp", from: 0, to: 10_000, buckets: 2 })).buckets
      ).toEqual([])
      yield* TestClock.adjust("5 seconds")
      const series = yield* history.series({ device: "ahu-1", point: "temp", from: 0, to: 10_000, buckets: 2 })
      expect(series).toMatchObject({ stepMs: 5_000, resolution: "read" })
      expect(series.buckets).toEqual([
        { t: 0, min: 0, max: 4, avg: 2, count: 5 },
        { t: 5_000, min: 5, max: 9, avg: 7, count: 5 }
      ])
      // Another point, or another device, is another series.
      expect((yield* history.series({ device: "ahu-1", point: "other", from: 0, to: 10_000 })).buckets).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps booleans as 0 and 1, so the average is the share of time true", () =>
    Effect.gen(function* () {
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 })
      for (const [index, value] of [true, true, false, true].entries())
        history.sink.record("d", "on", value, index * 1000)
      yield* TestClock.adjust("5 seconds")
      const series = yield* history.series({ device: "d", point: "on", from: 0, to: 4_000, buckets: 1 })
      expect(series.buckets).toEqual([{ t: 0, min: 0, max: 1, avg: 0.75, count: 4 }])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("answers from the minute rollups beyond the last day, and prunes both after their time", () =>
    Effect.gen(function* () {
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 2 })
      for (let second = 0; second < 120; second++) history.sink.record("m", "power", second, second * 1000)
      yield* TestClock.adjust("5 seconds")
      yield* TestClock.adjust(DAY + 3_600_000)
      const older = yield* history.series({ device: "m", point: "power", from: 0, to: 120_000, buckets: 2 })
      expect(older).toMatchObject({ resolution: "minute", stepMs: 60_000 })
      expect(older.buckets).toEqual([
        { t: 0, min: 0, max: 59, avg: 29.5, count: 60 },
        { t: 60_000, min: 60, max: 119, avg: 89.5, count: 60 }
      ])
      // Two days on, the rollups are gone too.
      yield* TestClock.adjust(2 * DAY)
      expect((yield* history.series({ device: "m", point: "power", from: 0, to: 120_000 })).buckets).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("writes what is still waiting when it closes", () =>
    Effect.gen(function* () {
      const path = yield* tempPath
      yield* Effect.scoped(
        Effect.gen(function* () {
          const history = yield* openHistory({ path, retentionDays: 7 })
          history.sink.record("d", "p", 42, 0)
        })
      )
      const reopened = yield* openHistory({ path, retentionDays: 7 })
      expect((yield* reopened.series({ device: "d", point: "p", from: 0, to: 1_000 })).buckets).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps at most MAX_PENDING reads in memory, dropping the oldest and counting them", () =>
    Effect.gen(function* () {
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 })
      const total = MAX_PENDING * 2
      for (let index = 0; index < total; index++) history.sink.record("d", "p", index, index)
      yield* TestClock.adjust("5 seconds")
      const series = yield* history.series({ device: "d", point: "p", from: 0, to: total, buckets: 1 })
      expect(series.buckets[0]?.count).toBeLessThanOrEqual(MAX_PENDING + MAX_PENDING / 10)
      expect(series.buckets[0]?.max).toBe(total - 1)
      expect((yield* Metric.value(historyDropped)).count).toBeGreaterThanOrEqual(MAX_PENDING - MAX_PENDING / 10)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("moves a corrupt file aside and starts a new one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* tempPath
      yield* fs.writeFileString(path, "this is not a database, but it is long enough to have a header ".repeat(20))
      const history = yield* openHistory({ path, retentionDays: 7 })
      history.sink.record("d", "p", 1, 0)
      yield* TestClock.adjust("5 seconds")
      expect((yield* history.series({ device: "d", point: "p", from: 0, to: 1_000 })).buckets).toHaveLength(1)
      const dir = path.slice(0, path.lastIndexOf("/"))
      expect((yield* fs.readDirectory(dir)).some((name) => name.startsWith("history.sqlite.corrupt-"))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("runs without history when the file cannot be opened, and says why", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* tempPath
      yield* fs.writeFileString(path, "")
      // A directory where a file is: the history's own file cannot be made under it.
      const history = yield* openHistory({ path: `${path}/history.sqlite`, retentionDays: 7 })
      history.sink.record("d", "p", 1, 0)
      const error = yield* Effect.flip(history.series({ device: "d", point: "p", from: 0, to: 1_000 }))
      expect(error._tag).toBe("HistoryUnavailable")
      expect(error.message).toContain("keeps no history")
      expect((yield* Metric.value(historyDisabled)).value).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
