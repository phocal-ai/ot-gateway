/**
 * The history keeps every read for a day and per-minute rollups for `retentionDays`, writes in batches, and never
 * stops the gateway: a file it cannot open leaves it without history, a corrupt one is moved aside.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { historyDisabled, historyDropped } from "@ot-gateway/core"
import { Clock, Effect, FileSystem, Metric, Tracer } from "effect"
import { SqlError, UnknownError } from "effect/sql/SqlError"
import { TestClock } from "effect/testing"
import { HISTORY_CHANGES_MAX, type HistoryBucket } from "@ot-gateway/api"
import { type History, MAX_PENDING, openHistory, rollup, type Store, stepFor } from "../src/index.ts"

const DAY = 86_400_000

const tempPath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ot-gateway-history-" })
  return `${dir}/history.sqlite`
})

/** SQLite result codes a write can fail with: CORRUPT, and FULL for a disk that is full but not damaged. */
const SQLITE_CORRUPT = 11
const SQLITE_FULL = 13

/** Writes fail with `code` while it is set, as `node:sqlite` reports it; every store opened, replacements too. */
const faultyWrites = () => {
  const faults: { code: number | undefined } = { code: undefined }
  const wrapStore = (store: Store): Store => ({
    ...store,
    write: (rows) =>
      faults.code === undefined
        ? store.write(rows)
        : Effect.fail(
            new SqlError({ reason: new UnknownError({ cause: { errcode: faults.code }, message: "injected" }) })
          )
  })
  return { faults, wrapStore }
}

/**
 * Wait for a flush that is still running: replacing a file renames it, which is real I/O that `TestClock.adjust`
 * does not wait for. A read waits for the same permit as the flush, so it returns once the flush is done.
 */
const settle = (history: History) =>
  Effect.ignore(history.series({ device: "settle", point: "settle", from: 0, to: 1 }))

/** The files a corrupt history was moved to, without their WAL companions. */
const movedAside = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const names = yield* fs.readDirectory(path.slice(0, path.lastIndexOf("/")))
    return names.filter(
      (name) => name.startsWith("history.sqlite.corrupt-") && !name.endsWith("-wal") && !name.endsWith("-shm")
    )
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
      { device: "d", point: "p", minute: 0, min: 1, max: 3, sum: 4, count: 2, first: 0, last: 59_999 },
      { device: "d", point: "p", minute: 60_000, min: 5, max: 5, sum: 5, count: 1, first: 60_000, last: 60_000 },
      { device: "d", point: "q", minute: 0, min: 7, max: 7, sum: 7, count: 1, first: 0, last: 0 }
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
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { flushEveryMs: 5_000 })
      for (let second = 0; second < 10; second++) history.sink.record("ventilation-1", "temp", second, second * 1000)
      const expected = [
        { t: 0, min: 0, max: 4, avg: 2, count: 5, first: 0, last: 4_000 },
        { t: 5_000, min: 5, max: 9, avg: 7, count: 5, first: 5_000, last: 9_000 }
      ]
      // Before the first write, the reads waiting for it are in the answer already.
      const before = yield* history.series({ device: "ventilation-1", point: "temp", from: 0, to: 10_000, buckets: 2 })
      expect(before).toMatchObject({ stepMs: 5_000, resolution: "read", live: true })
      expect(before.buckets).toEqual(expected)
      yield* TestClock.adjust("5 seconds")
      const series = yield* history.series({ device: "ventilation-1", point: "temp", from: 0, to: 10_000, buckets: 2 })
      expect(series).toMatchObject({ stepMs: 5_000, resolution: "read" })
      expect(series.buckets).toEqual(expected)
      // Another point, or another device, is another series.
      expect((yield* history.series({ device: "ventilation-1", point: "other", from: 0, to: 10_000 })).buckets).toEqual(
        []
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps booleans as 0 and 1, so the average is the share of time true", () =>
    Effect.gen(function* () {
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { flushEveryMs: 5_000 })
      for (const [index, value] of [true, true, false, true].entries())
        history.sink.record("d", "on", value, index * 1000)
      yield* TestClock.adjust("5 seconds")
      const series = yield* history.series({ device: "d", point: "on", from: 0, to: 4_000, buckets: 1 })
      expect(series.buckets).toEqual([{ t: 0, min: 0, max: 1, avg: 0.75, count: 4, first: 0, last: 3_000 }])
      expect(series.changes).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("lists when a value changed, from every read, when asked", () =>
    Effect.gen(function* () {
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { flushEveryMs: 5_000 })
      for (const [index, value] of [false, false, true, true, true, false, true].entries())
        history.sink.record("d", "on", value, index * 500)
      // Another point between them changes nothing.
      history.sink.record("d", "other", 7, 600)
      yield* TestClock.adjust("5 seconds")
      const series = yield* history.series({ device: "d", point: "on", from: 0, to: 4_000, changes: true })
      expect(series.changes).toEqual({
        list: [
          { t: 0, value: 0 },
          { t: 1_000, value: 1 },
          { t: 2_500, value: 0 },
          { t: 3_000, value: 1 }
        ],
        truncated: false
      })
      // Within the range only: the first read in it starts the list.
      const later = yield* history.series({ device: "d", point: "on", from: 1_500, to: 4_000, changes: true })
      expect(later.changes?.list).toEqual([
        { t: 1_500, value: 1 },
        { t: 2_500, value: 0 },
        { t: 3_000, value: 1 }
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("lists at most HISTORY_CHANGES_MAX changes and says there were more", () =>
    Effect.gen(function* () {
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { flushEveryMs: 5_000 })
      for (let index = 0; index < HISTORY_CHANGES_MAX + 10; index++) history.sink.record("d", "on", index % 2, index)
      yield* TestClock.adjust("5 seconds")
      const series = yield* history.series({ device: "d", point: "on", from: 0, to: 4_000, changes: true })
      expect(series.changes?.list).toHaveLength(HISTORY_CHANGES_MAX)
      expect(series.changes?.truncated).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect(
    "answers from the minute rollups beyond the last day, and prunes both after their time",
    () =>
      Effect.gen(function* () {
        // A write a minute. Three days of virtual time are also about 52,000 of the writer's 5 s ticks: under a
        // second here, but past the default 5 s timeout on a busy CI runner, so this test gets 30 s.
        const history = yield* openHistory({ path: yield* tempPath, retentionDays: 2 }, { flushEveryMs: 60_000 })
        for (let second = 0; second < 120; second++) history.sink.record("m", "power", second, second * 1000)
        yield* TestClock.adjust("1 minute")
        yield* TestClock.adjust(DAY + 3_600_000)
        const older = yield* history.series({ device: "m", point: "power", from: 0, to: 120_000, buckets: 2 })
        expect(older).toMatchObject({ resolution: "minute", stepMs: 60_000 })
        expect(older.buckets).toEqual([
          { t: 0, min: 0, max: 59, avg: 29.5, count: 60, first: 0, last: 59_000 },
          { t: 60_000, min: 60, max: 119, avg: 89.5, count: 60, first: 60_000, last: 119_000 }
        ])
        // Two days on, the rollups are gone too.
        yield* TestClock.adjust(2 * DAY)
        expect((yield* history.series({ device: "m", point: "power", from: 0, to: 120_000 })).buckets).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000
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
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { flushEveryMs: 5_000 })
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
      const history = yield* openHistory({ path, retentionDays: 7 }, { flushEveryMs: 5_000 })
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

/** Counts every write the history tries, failed ones too, around `inner` (unchanged by default). */
const countWrites = (inner: (store: Store) => Store = (store) => store) => {
  const counter = { writes: 0 }
  const wrapStore = (store: Store): Store => {
    const wrapped = inner(store)
    return {
      ...wrapped,
      write: (rows) =>
        Effect.suspend(() => {
          counter.writes++
          return wrapped.write(rows)
        })
    }
  }
  return { counter, wrapStore }
}

describe("a query between two writes", () => {
  it.effect("sees every read up to now: the stored ones and the waiting ones in one bucket, without a write", () =>
    Effect.gen(function* () {
      const { counter, wrapStore } = countWrites()
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { wrapStore })
      // A read every 5 s for a minute goes to the file in the writes at 30 s and 60 s; two more then wait.
      for (let second = 0; second < 60; second += 5) {
        history.sink.record("meter", "power", second, second * 1_000)
        yield* TestClock.adjust("5 seconds")
      }
      yield* settle(history)
      expect(counter.writes).toBe(2)
      history.sink.record("meter", "power", 100, 60_000)
      history.sink.record("meter", "power", 102, 65_000)
      const series = yield* history.series({ device: "meter", point: "power", from: 0, to: 70_000, buckets: 2 })
      expect(series.buckets).toEqual([
        { t: 0, min: 0, max: 30, avg: 15, count: 7, first: 0, last: 30_000 },
        {
          t: 35_000,
          min: 35,
          max: 102,
          avg: (35 + 40 + 45 + 50 + 55 + 100 + 102) / 7,
          count: 7,
          first: 35_000,
          last: 65_000
        }
      ])
      // Asking wrote nothing.
      expect(counter.writes).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("lists a change that is still waiting, after the stored ones, and not a repeat of the last", () =>
    Effect.gen(function* () {
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { flushEveryMs: 5_000 })
      history.sink.record("pump", "alarm", false, 0)
      history.sink.record("pump", "alarm", true, 1_000)
      yield* TestClock.adjust("5 seconds")
      history.sink.record("pump", "alarm", true, 6_000)
      history.sink.record("pump", "alarm", false, 7_000)
      const series = yield* history.series({ device: "pump", point: "alarm", from: 0, to: 8_000, changes: true })
      expect(series.changes?.list).toEqual([
        { t: 0, value: 0 },
        { t: 1_000, value: 1 },
        { t: 7_000, value: 0 }
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("sees waiting reads in the per-minute buckets too, by their minute", () =>
    Effect.gen(function* () {
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { flushEveryMs: 60_000 })
      yield* TestClock.adjust("2 hours")
      const now = yield* Clock.currentTimeMillis
      history.sink.record("m", "p", 4, now - 30_000)
      history.sink.record("m", "p", 6, now - 1_000)
      const series = yield* history.series({ device: "m", point: "p", from: now - 2 * 3_600_000, to: now, buckets: 2 })
      expect(series.resolution).toBe("minute")
      expect(series.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("when the history writes", () => {
  it.effect("writes every 30 s by default: twice a minute for 200 points read every 5 s, every read kept", () =>
    Effect.gen(function* () {
      const { counter, wrapStore } = countWrites()
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { wrapStore })
      for (let cycle = 0; cycle < 12; cycle++) {
        for (let point = 0; point < 200; point++) history.sink.record("d", `p-${point}`, cycle, cycle * 5_000)
        yield* TestClock.adjust("5 seconds")
      }
      yield* settle(history)
      expect(counter.writes).toBe(2)
      let total = 0
      for (let point = 0; point < 200; point++) {
        const series = yield* history.series({ device: "d", point: `p-${point}`, from: 0, to: 60_000, buckets: 1 })
        total += series.buckets[0]?.count ?? 0
      }
      expect(total).toBe(2_400)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("writes sooner when half the cap is waiting, and drops nothing", () =>
    Effect.gen(function* () {
      const { counter, wrapStore } = countWrites()
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { wrapStore })
      const droppedBefore = (yield* Metric.value(historyDropped)).count
      for (let index = 0; index < MAX_PENDING / 2; index++) history.sink.record("d", "p", index, index)
      // The next tick, well before the 30 s interval is over.
      yield* TestClock.adjust("5 seconds")
      yield* settle(history)
      expect(counter.writes).toBe(1)
      const series = yield* history.series({ device: "d", point: "p", from: 0, to: MAX_PENDING, buckets: 1 })
      expect(series.buckets[0]?.count).toBe(MAX_PENDING / 2)
      expect((yield* Metric.value(historyDropped)).count).toBe(droppedBefore)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("retries a failed write only once the interval has passed again", () =>
    Effect.gen(function* () {
      const faulty = faultyWrites()
      const { counter, wrapStore } = countWrites(faulty.wrapStore)
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { wrapStore })
      faulty.faults.code = SQLITE_FULL
      history.sink.record("d", "p", 1, 0)
      yield* TestClock.adjust("30 seconds")
      yield* settle(history)
      expect(counter.writes).toBe(1)
      // Ticks come every 5 s, but none of them tries again within the interval.
      yield* TestClock.adjust("25 seconds")
      yield* settle(history)
      expect(counter.writes).toBe(1)
      faulty.faults.code = undefined
      yield* TestClock.adjust("5 seconds")
      yield* settle(history)
      expect(counter.writes).toBe(2)
      expect((yield* history.series({ device: "d", point: "p", from: 0, to: 1_000 })).buckets).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** Records which table each read asks the store for. */
const tablesAsked = () => {
  const tables: Array<string> = []
  const wrapStore = (store: Store): Store => ({
    ...store,
    buckets: (table, query) =>
      Effect.suspend(() => {
        tables.push(table)
        return store.buckets(table, query)
      })
  })
  return { tables, wrapStore }
}

describe("which table a range is read from", () => {
  it.effect("reads a day in 240 buckets from the rollups, whatever the caller's clock says about its age", () =>
    Effect.gen(function* () {
      const { tables, wrapStore } = tablesAsked()
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { wrapStore })
      const now = yield* Clock.currentTimeMillis
      // A browser clock a second behind, in step with, or a second ahead of the gateway's.
      for (const skew of [-1_000, 0, 1_000]) {
        const series = yield* history.series({
          device: "d",
          point: "p",
          from: now - DAY + skew,
          to: now + skew,
          buckets: 240
        })
        expect(series).toMatchObject({ resolution: "minute", stepMs: 360_000 })
      }
      expect(tables).toEqual(["minutes", "minutes", "minutes"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("reads 15 minutes in 240 buckets from every read", () =>
    Effect.gen(function* () {
      const { tables, wrapStore } = tablesAsked()
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { wrapStore })
      const now = yield* Clock.currentTimeMillis
      const series = yield* history.series({ device: "d", point: "p", from: now - 900_000, to: now, buckets: 240 })
      expect(series).toMatchObject({ resolution: "read", stepMs: 4_000 })
      expect(tables).toEqual(["readings"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("reads the last 10 minutes in minute buckets from every read, on whole minutes, up to now", () =>
    Effect.gen(function* () {
      const { tables, wrapStore } = tablesAsked()
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { wrapStore })
      // Half a minute past a whole minute: rollups would start at the minute before and lag the last 30 s.
      yield* TestClock.adjust("90 seconds")
      const now = yield* Clock.currentTimeMillis
      const series = yield* history.series({ device: "d", point: "p", from: now - 600_000, to: now, buckets: 10 })
      // The buckets start on the whole minute before the range: the newest is the current minute, up to now.
      expect(series).toMatchObject({ resolution: "read", stepMs: 60_000, from: now - 630_000, to: now })
      // An hour and a half in 10 buckets is past an hour, so from the rollups.
      yield* history.series({ device: "d", point: "p", from: now - 5_400_000, to: now, buckets: 10 })
      expect(tables).toEqual(["readings", "minutes"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("reads a range from more than a day back from the rollups, even in buckets finer than a minute", () =>
    Effect.gen(function* () {
      const { tables, wrapStore } = tablesAsked()
      // A write a minute, as in the retention test, so a day of virtual time stays quick.
      const history = yield* openHistory(
        { path: yield* tempPath, retentionDays: 7 },
        { wrapStore, flushEveryMs: 60_000 }
      )
      for (let second = 0; second < 120; second++) history.sink.record("m", "power", second, second * 1000)
      yield* TestClock.adjust("1 minute")
      yield* TestClock.adjust(DAY + 3_600_000)
      tables.length = 0
      const series = yield* history.series({ device: "m", point: "power", from: 0, to: 120_000, buckets: 240 })
      expect(series).toMatchObject({ resolution: "minute", stepMs: 60_000 })
      expect(series.buckets).toEqual([
        { t: 0, min: 0, max: 59, avg: 29.5, count: 60, first: 0, last: 59_000 },
        { t: 60_000, min: 60, max: 119, avg: 89.5, count: 60, first: 60_000, last: 119_000 }
      ])
      expect(tables).toEqual(["minutes"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("a file that goes corrupt while the gateway runs", () => {
  it.effect("is moved aside, and the reads before and after go to a new file", () =>
    Effect.gen(function* () {
      const path = yield* tempPath
      const { faults, wrapStore } = faultyWrites()
      const history = yield* openHistory({ path, retentionDays: 7 }, { wrapStore, flushEveryMs: 5_000 })
      faults.code = SQLITE_CORRUPT
      history.sink.record("d", "p", 1, 0)
      yield* TestClock.adjust("5 seconds")
      yield* settle(history)
      expect(yield* movedAside(path)).toHaveLength(1)
      faults.code = undefined
      history.sink.record("d", "p", 2, 1_000)
      yield* TestClock.adjust("5 seconds")
      const series = yield* history.series({ device: "d", point: "p", from: 0, to: 2_000, buckets: 1 })
      expect(series.buckets).toEqual([{ t: 0, min: 1, max: 2, avg: 1.5, count: 2, first: 0, last: 1_000 }])
      expect((yield* Metric.value(historyDisabled)).value).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("is replaced at most once an hour", () =>
    Effect.gen(function* () {
      const path = yield* tempPath
      const { faults, wrapStore } = faultyWrites()
      const history = yield* openHistory({ path, retentionDays: 7 }, { wrapStore, flushEveryMs: 5_000 })
      faults.code = SQLITE_CORRUPT
      history.sink.record("d", "p", 1, 0)
      yield* TestClock.adjust("5 seconds")
      yield* settle(history)
      expect(yield* movedAside(path)).toHaveLength(1)
      // The new file fails the same way: within the hour the reads wait in memory, and no file is moved.
      yield* TestClock.adjust("10 minutes")
      yield* settle(history)
      expect(yield* movedAside(path)).toHaveLength(1)
      yield* TestClock.adjust("1 hour")
      yield* settle(history)
      expect(yield* movedAside(path)).toHaveLength(2)
      faults.code = undefined
      yield* TestClock.adjust("5 seconds")
      expect((yield* history.series({ device: "d", point: "p", from: 0, to: 1_000 })).buckets).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("turns the history off when no new file can be opened, and keeps nothing in memory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* tempPath
      const { faults, wrapStore } = faultyWrites()
      const history = yield* openHistory({ path, retentionDays: 7 }, { wrapStore, flushEveryMs: 5_000 })
      // A file where the history's directory was: nothing can be moved or created under it, even by root.
      const dir = path.slice(0, path.lastIndexOf("/"))
      yield* fs.remove(dir, { recursive: true })
      yield* fs.writeFileString(dir, "")
      faults.code = SQLITE_CORRUPT
      history.sink.record("d", "p", 1, 0)
      yield* TestClock.adjust("5 seconds")
      // Waits for the flush that tries to replace the file, as `settle` does.
      const error = yield* Effect.flip(history.series({ device: "d", point: "p", from: 0, to: 1_000 }))
      expect(error._tag).toBe("HistoryUnavailable")
      expect(error.message).toContain("keeps no history")
      expect((yield* Metric.value(historyDisabled)).value).toBe(1)
      // Reads are no longer kept: past the cap they would be dropped and counted on the next flush.
      const droppedBefore = (yield* Metric.value(historyDropped)).count
      for (let index = 0; index < MAX_PENDING * 2; index++) history.sink.record("d", "p", index, index)
      yield* TestClock.adjust("5 seconds")
      expect((yield* Metric.value(historyDropped)).count).toBe(droppedBefore)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("is not confused with a full disk, which moves no file and keeps the reads", () =>
    Effect.gen(function* () {
      const path = yield* tempPath
      const { faults, wrapStore } = faultyWrites()
      const history = yield* openHistory({ path, retentionDays: 7 }, { wrapStore, flushEveryMs: 5_000 })
      faults.code = SQLITE_FULL
      history.sink.record("d", "p", 1, 0)
      yield* TestClock.adjust("5 seconds")
      yield* settle(history)
      expect(yield* movedAside(path)).toHaveLength(0)
      faults.code = undefined
      yield* TestClock.adjust("5 seconds")
      expect((yield* history.series({ device: "d", point: "p", from: 0, to: 1_000 })).buckets).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("tracing", () => {
  it.effect("exports no span for its SQL statements, so the trace sampler is not bypassed", () => {
    const names: Array<string> = []
    const tracer = Tracer.make({
      span: (options) => {
        names.push(options.name)
        return new Tracer.NativeSpan(options)
      }
    })
    return Effect.gen(function* () {
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { flushEveryMs: 5_000 })
      for (let second = 0; second < 3; second++) history.sink.record("d", "p", second, second * 1000)
      yield* TestClock.adjust("5 seconds")
      const series = yield* history
        .series({ device: "d", point: "p", from: 0, to: 3_000 })
        .pipe(Effect.withSpan("caller"))
      expect(series.buckets.length).toBeGreaterThan(0)
      // The caller's own span stays; only the SQL statements under it are gone.
      expect(names).toContain("caller")
      expect(names.filter((name) => name.startsWith("sql"))).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.withTracer(tracer))
  })
})

/** Each bucket's start and the times of its first and last read. */
const times = (series: { readonly buckets: ReadonlyArray<HistoryBucket> }) =>
  series.buckets.map(({ t, first, last }) => ({ t, first, last }))

describe("buckets on whole multiples of their width", () => {
  it.effect("put a read in the same bucket however late it is asked, so two answers seconds apart agree", () =>
    Effect.gen(function* () {
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { flushEveryMs: 5_000 })
      // A read every 5 s from 0:00 to 4:55, then asked at 5:42 and again at 5:47 for the last 5 minutes.
      for (let second = 0; second < 300; second += 5) history.sink.record("m", "p", second, second * 1_000)
      yield* TestClock.adjust("342 seconds")
      const asked = Effect.flatMap(Clock.currentTimeMillis, (now) =>
        history.series({ device: "m", point: "p", from: now - 300_000, to: now, buckets: 5 })
      )
      const first = yield* asked
      yield* TestClock.adjust("5 seconds")
      const second = yield* asked
      // The buckets start on whole minutes, the first on the minute the range starts in.
      expect(first).toMatchObject({ stepMs: 60_000, from: 0 })
      expect(second).toMatchObject({ stepMs: 60_000, from: 0 })
      expect(first.buckets.map((bucket) => [bucket.t, bucket.count])).toEqual([
        [0, 12],
        [60_000, 12],
        [120_000, 12],
        [180_000, 12],
        [240_000, 12]
      ])
      expect(second.buckets).toEqual(first.buckets)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("say when each bucket's first and last read came, from the waiting reads and the rollups alike", () =>
    Effect.gen(function* () {
      const history = yield* openHistory({ path: yield* tempPath, retentionDays: 7 }, { flushEveryMs: 60_000 })
      // Reads until 1:04, then none until 3:09: a gap of 125 s, whatever the buckets.
      for (const at of [10_000, 40_000, 64_000, 189_000, 200_000]) history.sink.record("m", "p", 1, at)
      // Still waiting for the write: from the merge.
      const waiting = yield* history.series({ device: "m", point: "p", from: 0, to: 240_000, buckets: 4 })
      expect(times(waiting)).toEqual([
        { t: 0, first: 10_000, last: 40_000 },
        { t: 60_000, first: 64_000, last: 64_000 },
        { t: 180_000, first: 189_000, last: 200_000 }
      ])
      yield* TestClock.adjust("1 minute")
      yield* TestClock.adjust(DAY + 3_600_000)
      // A day later, from the rollups: the same times.
      const rolled = yield* history.series({ device: "m", point: "p", from: 0, to: 240_000, buckets: 4 })
      expect(rolled.resolution).toBe("minute")
      expect(times(rolled)).toEqual(times(waiting))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
