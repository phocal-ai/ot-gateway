/**
 * The host monitor: parsing what Linux and the Raspberry Pi firmware print,
 * telling an NTP step from slewing, and logging problems when they start and
 * end rather than on every sample.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import {
  bufferDiskFree,
  clockSteps,
  eventLoopLag,
  hostThrottled,
  processCpu,
  processDiskWritten,
  processMemory,
  withMetricAttributes
} from "@ot-gateway/core"
import { Effect, Fiber, FileSystem, Logger, Metric } from "effect"
import { TestClock } from "effect/testing"
import {
  clockStep,
  type HostSources,
  hostHealth,
  liveHostSources,
  makeHostMonitor,
  parseMillidegrees,
  parseThrottled,
  parseUnderVoltageAlarm,
  parseWriteBytes,
  SAMPLE_INTERVAL_MS,
  THROTTLE_CONDITIONS,
  throttlingSource
} from "../src/Host.ts"
import { parseVersion, versionFile } from "../src/Version.ts"

describe("parsing", () => {
  it("reads the firmware's throttle mask, now and since boot", () => {
    expect(parseThrottled("0\n")).toEqual({ now: [], sinceBoot: [], watched: THROTTLE_CONDITIONS })
    // Under-voltage now, and under-voltage and throttling since boot: the classic weak power supply.
    expect(parseThrottled("50005\n")).toEqual({
      now: ["under_voltage", "throttled"],
      sinceBoot: ["under_voltage", "throttled"],
      watched: THROTTLE_CONDITIONS
    })
    expect(parseThrottled("throttled=0x80008")).toMatchObject({
      now: ["soft_temperature_limit"],
      sinceBoot: ["soft_temperature_limit"]
    })
    expect(parseThrottled("")).toBeUndefined()
    expect(parseThrottled("not a mask")).toBeUndefined()
  })

  it("reads the kernel's under-voltage alarm as under-voltage now, and nothing else", () => {
    expect(parseUnderVoltageAlarm("0\n")).toEqual({ now: [], watched: ["under_voltage"] })
    expect(parseUnderVoltageAlarm("1\n")).toEqual({ now: ["under_voltage"], watched: ["under_voltage"] })
    expect(parseUnderVoltageAlarm("")).toBeUndefined()
    expect(parseUnderVoltageAlarm("2")).toBeUndefined()
  })

  it("reads a thermal zone in millidegrees, and refuses what is not a temperature", () => {
    expect(parseMillidegrees("48312\n")).toBe(48.3)
    expect(parseMillidegrees("-5000")).toBe(-5)
    expect(parseMillidegrees("999999")).toBeUndefined()
    expect(parseMillidegrees("hot")).toBeUndefined()
  })

  it("reads write_bytes from /proc/self/io", () => {
    const io =
      "rchar: 1\nwchar: 2\nsyscr: 3\nsyscw: 4\nread_bytes: 4096\nwrite_bytes: 1236992\ncancelled_write_bytes: 0\n"
    expect(parseWriteBytes(io)).toBe(1_236_992)
    expect(parseWriteBytes("rchar: 1\n")).toBeUndefined()
  })

  it("tells an NTP step from slewing", () => {
    expect(clockStep(1000, 1007)).toBeUndefined()
    expect(clockStep(0, 3_600_000)).toBe(3_600_000)
    expect(clockStep(5000, 2000)).toBe(-3000)
  })

  it("takes a version that is safe for a metric attribute, and nothing else", () => {
    expect(parseVersion("v0.4.0\n")).toBe("v0.4.0")
    expect(parseVersion("v0.4.0-3-g1e57130-dirty")).toBe("v0.4.0-3-g1e57130-dirty")
    expect(parseVersion("")).toBeUndefined()
    expect(parseVersion("v1 with spaces")).toBeUndefined()
  })
})

/** A machine the test sets by hand. */
const fakeHost = () => {
  const state = {
    rss: 100e6,
    heap: 40e6,
    cpu: 1,
    offset: 0,
    written: 1000 as number | undefined,
    lag: { p99Ms: 5, maxMs: 10 },
    fds: 30,
    temperature: 50 as number | undefined,
    throttled: "0" as string | undefined,
    free: 1e9 as number | undefined
  }
  const sources: HostSources = {
    memory: Effect.sync(() => ({ rss: state.rss, heap: state.heap })),
    cpuSeconds: Effect.sync(() => state.cpu),
    eventLoopLag: Effect.sync(() => state.lag),
    clockOffsetMs: Effect.sync(() => state.offset),
    openFds: Effect.sync(() => state.fds),
    diskWrittenBytes: Effect.sync(() => state.written),
    temperatureC: Effect.sync(() => state.temperature),
    throttling: Effect.sync(() => (state.throttled === undefined ? undefined : parseThrottled(state.throttled))),
    diskFreeBytes: () => Effect.sync(() => state.free)
  }
  return { state, sources }
}

const value = (metric: Metric.Gauge<number>, attributes: Record<string, string>) =>
  Effect.map(Metric.value(Metric.withAttributes(metric, attributes)), (state) => state.value)
const count = (metric: Metric.Counter<number>, attributes: Record<string, string>) =>
  Effect.map(Metric.value(Metric.withAttributes(metric, attributes)), (state) => state.count)

describe("host monitor", () => {
  it.effect("exports the process and the machine, and logs each problem when it starts and when it ends", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const logger = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          lines.push(`${logLevel}: ${(Array.isArray(message) ? message : [message]).join(" ")}`)
        })
      ])
      const tag = { test: "host-monitor" }
      const { state, sources } = fakeHost()
      const monitor = yield* makeHostMonitor(sources, {
        version: "v9.9.9",
        bufferPath: "/var/lib/ot-gateway/buffer.sqlite"
      })
      const fiber = yield* monitor.run.pipe(withMetricAttributes(tag), Effect.provide(logger), Effect.forkChild)
      const tick = TestClock.adjust(SAMPLE_INTERVAL_MS)
      yield* Effect.yieldNow

      expect(yield* value(processMemory, { ...tag, kind: "rss" })).toBe(100e6)
      expect(yield* value(bufferDiskFree, tag)).toBe(1e9)
      expect(monitor.latest()?.openFds).toBe(30)
      expect(lines).toEqual([])

      // A minute of trouble: a stall, a weak power supply, a hot SoC, a full disk, NTP setting the time.
      state.cpu = 4
      state.written = 5096
      state.lag = { p99Ms: 400, maxMs: 2500 }
      state.throttled = "50005"
      state.temperature = 82.5
      state.free = 10e6
      state.offset = 3_600_000
      yield* tick
      // The same trouble on the next sample is not logged again.
      state.lag = { p99Ms: 300, maxMs: 1500 }
      yield* tick

      expect(yield* count(processCpu, tag)).toBe(3)
      expect(yield* count(processDiskWritten, tag)).toBe(4096)
      expect(yield* count(clockSteps, { ...tag, direction: "forward" })).toBe(1)
      expect(yield* value(hostThrottled, { ...tag, condition: "under_voltage" })).toBe(1)
      expect(yield* value(hostThrottled, { ...tag, condition: "frequency_capped" })).toBe(0)
      expect(yield* value(eventLoopLag, { ...tag, quantile: "max" })).toBe(2.5)
      expect(monitor.latest()).toMatchObject({
        clockSteps: 1,
        temperatureC: 82.5,
        diskFreeBytes: 10e6,
        eventLoopLagMs: { p99: 400, max: 2500 },
        throttled: { now: ["under_voltage", "throttled"] }
      })
      const snapshot = monitor.latest()
      expect(snapshot === undefined ? undefined : hostHealth(snapshot)).toEqual({
        memoryBytes: 100e6,
        eventLoopLagMs: 2500,
        clockSteps: 1,
        temperatureC: 82.5,
        throttled: ["under_voltage", "throttled"],
        throttledWatched: THROTTLE_CONDITIONS,
        diskFreeBytes: 10e6
      })
      expect(lines).toEqual([
        "Warn: event loop stalled: every device and deadline waits for it",
        "Warn: wall clock stepped; timestamps jump with it, deadlines do not",
        "Warn: host is hot",
        "Warn: host reports a power or thermal condition",
        "Warn: the outbox's disk is nearly full"
      ])

      // Everything recovers.
      lines.length = 0
      state.lag = { p99Ms: 5, maxMs: 10 }
      state.throttled = "50000"
      state.temperature = 60
      state.free = 1e9
      yield* tick
      expect(lines).toEqual([
        "Info: event loop responsive again",
        "Info: host has cooled down",
        "Info: the outbox's disk has room again"
      ])
      // The gauges keep the worst of the last minute, so a stall or a dip between two exports still shows.
      expect(yield* value(eventLoopLag, { ...tag, quantile: "max" })).toBe(2.5)
      expect(yield* value(hostThrottled, { ...tag, condition: "under_voltage" })).toBe(1)
      expect(monitor.latest()?.throttled?.now).toEqual(["under_voltage", "throttled"])
      // Conditions clear after four clean samples (a minute), not before.
      yield* Effect.all([tick, tick])
      expect(yield* value(hostThrottled, { ...tag, condition: "under_voltage" })).toBe(1)
      expect(lines).not.toContain("Info: host conditions cleared")
      yield* tick
      expect(yield* value(eventLoopLag, { ...tag, quantile: "max" })).toBe(0.01)
      expect(yield* value(hostThrottled, { ...tag, condition: "under_voltage" })).toBe(0)
      expect(monitor.latest()?.throttled?.now).toEqual([])
      expect(lines).toEqual([
        "Info: event loop responsive again",
        "Info: host has cooled down",
        "Info: the outbox's disk has room again",
        "Info: host conditions cleared"
      ])
      yield* Fiber.interrupt(fiber)
    })
  )

  it.effect("reports conditions from before it started once, and leaves out what the machine cannot tell", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const logger = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          lines.push(`${logLevel}: ${(Array.isArray(message) ? message : [message]).join(" ")}`)
        })
      ])
      const { state, sources } = fakeHost()
      state.throttled = "10000"
      const monitor = yield* makeHostMonitor(sources, { version: "dev" })
      const fiber = yield* monitor.run.pipe(
        withMetricAttributes({ test: "host-since-boot" }),
        Effect.provide(logger),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust(SAMPLE_INTERVAL_MS)
      expect(lines).toEqual(["Warn: host has reported power or thermal conditions since boot"])

      // Not a Pi, no thermal zone, not Linux, no buffer: those fields are absent, not 0.
      state.throttled = undefined
      state.temperature = undefined
      state.written = undefined
      yield* TestClock.adjust(SAMPLE_INTERVAL_MS)
      const snapshot = monitor.latest()
      expect(snapshot).toBeDefined()
      expect(snapshot).not.toHaveProperty("temperatureC")
      expect(snapshot).not.toHaveProperty("throttled")
      expect(snapshot).not.toHaveProperty("diskFreeBytes")
      yield* Fiber.interrupt(fiber)
    })
  )
})

/** A /sys tree of our own: what a Pi exposes depends on its kernel. */
const sysfs = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ot-gateway-sysfs-" })
    for (const [path, text] of Object.entries(files)) {
      yield* fs.makeDirectory(`${root}/${path.slice(0, path.lastIndexOf("/"))}`, { recursive: true })
      yield* fs.writeFileString(`${root}/${path}`, text)
    }
    return { fs, root }
  })

describe("throttling source", () => {
  it.effect("reads the firmware's mask where the kernel still exposes it (before 6.18)", () =>
    Effect.gen(function* () {
      const { fs, root } = yield* sysfs({
        "devices/platform/soc/soc:firmware/get_throttled": "50005\n",
        "class/hwmon/hwmon1/name": "rpi_volt\n",
        "class/hwmon/hwmon1/in0_lcrit_alarm": "0\n"
      })
      const source = yield* throttlingSource(fs, { sysfs: root })
      expect(source.kind).toBe("firmware-mask")
      expect(yield* source.read).toEqual(parseThrottled("50005"))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("passes over a mask that does not parse", () =>
    Effect.gen(function* () {
      const { fs, root } = yield* sysfs({
        "devices/platform/soc/soc:firmware/get_throttled": "\n",
        "class/hwmon/hwmon1/name": "rpi_volt\n",
        "class/hwmon/hwmon1/in0_lcrit_alarm": "0\n"
      })
      expect((yield* throttlingSource(fs, { sysfs: root })).kind).toBe("rpi-volt-sensor")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("falls back to the rpi_volt sensor's under-voltage alarm (6.18 and later), and follows it", () =>
    Effect.gen(function* () {
      const { fs, root } = yield* sysfs({
        "class/hwmon/hwmon0/name": "cpu_thermal\n",
        "class/hwmon/hwmon1/name": "rpi_volt\n",
        "class/hwmon/hwmon1/in0_lcrit_alarm": "0\n"
      })
      const { kind, read } = yield* throttlingSource(fs, { sysfs: root })
      expect(kind).toBe("rpi-volt-sensor")
      expect(yield* read).toEqual({ now: [], watched: ["under_voltage"] })
      yield* fs.writeFileString(`${root}/class/hwmon/hwmon1/in0_lcrit_alarm`, "1\n")
      expect(yield* read).toEqual({ now: ["under_voltage"], watched: ["under_voltage"] })
      yield* fs.writeFileString(`${root}/class/hwmon/hwmon1/in0_lcrit_alarm`, "0\n")
      expect(yield* read).toEqual({ now: [], watched: ["under_voltage"] })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("finds a sensor whose driver loads after the gateway started", () =>
    Effect.gen(function* () {
      const { fs, root } = yield* sysfs({ "class/hwmon/hwmon0/name": "cpu_thermal\n" })
      const source = yield* throttlingSource(fs, { sysfs: root })
      expect(source.kind).toBe("none")
      expect(yield* source.read).toBeUndefined()
      yield* fs.makeDirectory(`${root}/class/hwmon/hwmon1`)
      yield* fs.writeFileString(`${root}/class/hwmon/hwmon1/in0_lcrit_alarm`, "1\n")
      yield* fs.writeFileString(`${root}/class/hwmon/hwmon1/name`, "rpi_volt\n")
      expect(yield* source.read).toEqual({ now: ["under_voltage"], watched: ["under_voltage"] })
      // Found once: later reads follow that sensor without looking for it again (which would now find nothing).
      yield* fs.writeFileString(`${root}/class/hwmon/hwmon1/name`, "renamed\n")
      expect(yield* source.read).toEqual({ now: ["under_voltage"], watched: ["under_voltage"] })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live("keeps a dip the sensor showed between two reads until the next read", () =>
    Effect.gen(function* () {
      const { fs, root } = yield* sysfs({
        "class/hwmon/hwmon1/name": "rpi_volt\n",
        "class/hwmon/hwmon1/in0_lcrit_alarm": "0\n"
      })
      const alarm = `${root}/class/hwmon/hwmon1/in0_lcrit_alarm`
      const { read } = yield* throttlingSource(fs, { sysfs: root, pollMs: 5 })
      yield* fs.writeFileString(alarm, "1\n")
      yield* Effect.sleep("60 millis")
      yield* fs.writeFileString(alarm, "0\n")
      expect(yield* read).toEqual({ now: ["under_voltage"], watched: ["under_voltage"] })
      expect(yield* read).toEqual({ now: [], watched: ["under_voltage"] })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("reads nothing off a Pi", () =>
    Effect.gen(function* () {
      const { fs, root } = yield* sysfs({ "class/hwmon/hwmon0/name": "coretemp\n" })
      for (const path of [root, `${root}/missing`]) {
        const source = yield* throttlingSource(fs, { sysfs: path })
        expect(source.kind).toBe("none")
        expect(yield* source.read).toBeUndefined()
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("with the alarm alone, the monitor reports under-voltage and nothing since boot", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const logger = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          lines.push(`${logLevel}: ${(Array.isArray(message) ? message : [message]).join(" ")}`)
        })
      ])
      const { sources } = fakeHost()
      let alarm = "1"
      const monitor = yield* makeHostMonitor(
        { ...sources, throttling: Effect.sync(() => parseUnderVoltageAlarm(alarm)) },
        { version: "dev" }
      )
      const tag = { test: "host-alarm" }
      const fiber = yield* monitor.run.pipe(withMetricAttributes(tag), Effect.provide(logger), Effect.forkChild)
      yield* Effect.yieldNow
      expect(yield* value(hostThrottled, { ...tag, condition: "under_voltage" })).toBe(1)
      expect(monitor.latest()?.throttled).toEqual({ now: ["under_voltage"], watched: ["under_voltage"] })
      alarm = "0"
      // Still 1 at 15, 30 and 45 s, so every one-minute export sees the dip; 0 after a clean minute.
      for (let sample = 1; sample <= 3; sample++) {
        yield* TestClock.adjust(SAMPLE_INTERVAL_MS)
        expect(yield* value(hostThrottled, { ...tag, condition: "under_voltage" })).toBe(1)
      }
      yield* TestClock.adjust(SAMPLE_INTERVAL_MS)
      expect(yield* value(hostThrottled, { ...tag, condition: "under_voltage" })).toBe(0)
      // No series for what the sensor cannot see: a 0 would read as "not throttled".
      const series = (yield* Metric.snapshot).filter(
        (metric) => metric.id === "ot_gateway_host_throttled" && metric.attributes?.["test"] === "host-alarm"
      )
      expect(series.map((metric) => metric.attributes?.["condition"])).toEqual(["under_voltage"])
      expect(lines).toEqual(["Warn: host reports a power or thermal condition", "Info: host conditions cleared"])
      yield* Fiber.interrupt(fiber)
    })
  )
})

describe("live sources", () => {
  it.live("read this machine without privileges", () =>
    Effect.gen(function* () {
      const host = yield* liveHostSources
      const memory = yield* host.memory
      expect(memory.rss).toBeGreaterThan(0)
      expect(yield* host.cpuSeconds).toBeGreaterThan(0)
      expect(yield* host.diskFreeBytes(versionFile)).toBeGreaterThan(0)
      if (process.platform === "linux") {
        expect(yield* host.openFds).toBeGreaterThan(0)
        expect(yield* host.diskWrittenBytes).toBeGreaterThanOrEqual(0)
      }
      // Wherever the files are missing (not a Pi, no thermal zone) these are undefined, never a failure.
      yield* host.temperatureC
      yield* host.throttling
      yield* Effect.sleep("50 millis")
      const lag = yield* host.eventLoopLag
      if (lag !== undefined) expect(lag.maxMs).toBeGreaterThanOrEqual(0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
