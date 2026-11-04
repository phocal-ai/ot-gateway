/**
 * The host monitor: the gateway process and the machine under it, sampled
 * every 15 seconds into metrics, the health message and the status page.
 *
 * Built for a Raspberry Pi on an SD card with no real-time clock, and just as
 * valid in a container: everything is read from `/proc/self`, `/sys` (visible
 * read-only in a default container) and Node itself, with no privileges and
 * no external commands. What the machine cannot tell (no thermal zone, not a
 * Raspberry Pi kernel, not Linux) is left out rather than reported as 0.
 *
 * Problems are logged when they start and when they end, never per sample:
 * an event loop that stalls, a power or thermal condition, a hot SoC, a disk
 * that is nearly full. Every wall-clock step is logged, since each one is
 * rare and moves every timestamp the gateway publishes.
 */
import {
  bufferDiskFree,
  clockSteps,
  eventLoopLag,
  type HostHealth,
  hostTemperature,
  hostThrottled,
  monotonicMillis,
  processCpu,
  processDiskWritten,
  processMemory,
  processOpenFds,
  processStart
} from "@ot-gateway/core"
import { Clock, Effect, FileSystem, Metric, Schedule } from "effect"
import type { Scope } from "effect"
import { statfs } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"

/** How often the monitor samples. Metrics export once a minute, so four samples back each export. */
export const SAMPLE_INTERVAL_MS = 15_000
/** Samples of event-loop lag the gauges cover: the last minute. */
const LAG_WINDOWS = 4
/** A wall clock that moved this much further than the monotonic one between two samples was stepped. */
export const CLOCK_STEP_MS = 1_000
/** An event loop this late is stalled: every device, keepalive and deadline waits for it. */
export const STALL_MS = 1_000
/** Above this the SoC is hot (a Pi 4 starts throttling at 80 °C); it is fine again below `COOL_C`. */
export const HOT_C = 80
const COOL_C = 75
/** Below this the outbox's disk is nearly full; it is fine again above `ROOMY_BYTES`. */
export const LOW_DISK_BYTES = 64 * 1024 * 1024
const ROOMY_BYTES = 128 * 1024 * 1024

/** The Raspberry Pi firmware's power and thermal flags, by bit: now in bits 0–3, since boot in bits 16–19. */
export const THROTTLE_CONDITIONS = ["under_voltage", "frequency_capped", "throttled", "soft_temperature_limit"] as const
export type ThrottleCondition = (typeof THROTTLE_CONDITIONS)[number]

export interface Throttling {
  /** Conditions now; from the kernel's sensor, any seen since the previous read; in a snapshot, any in the last four samples (about a minute). */
  readonly now: ReadonlyArray<ThrottleCondition>
  /** What the firmware remembers since boot; absent when the source cannot tell. */
  readonly sinceBoot?: ReadonlyArray<ThrottleCondition>
  /** The conditions the source can see at all: all four from the firmware's mask, under-voltage alone from the kernel's sensor. */
  readonly watched: ReadonlyArray<ThrottleCondition>
}

/**
 * The firmware's `get_throttled` mask, as sysfs prints it (`50005`), or as
 * `vcgencmd get_throttled` does (`throttled=0x50005`). Anything else is not
 * a mask and gives `undefined`.
 */
export const parseThrottled = (text: string): Throttling | undefined => {
  const match = /^(?:throttled=)?(?:0x)?([0-9a-f]{1,8})$/i.exec(text.trim())
  if (match === null) return undefined
  const mask = Number.parseInt(match[1] ?? "", 16)
  return {
    now: THROTTLE_CONDITIONS.filter((_, bit) => (mask & (1 << bit)) !== 0),
    sinceBoot: THROTTLE_CONDITIONS.filter((_, bit) => (mask & (1 << (bit + 16))) !== 0),
    watched: THROTTLE_CONDITIONS
  }
}

/**
 * The kernel's `rpi_volt` sensor, `in0_lcrit_alarm`: `1` when the firmware
 * reported under-voltage at the driver's last poll. The driver polls every
 * 2 seconds and clears the firmware's sticky bits each time, so this is
 * under-voltage now, nothing since boot, and none of the other conditions.
 * Anything but `0` or `1` gives `undefined`.
 */
export const parseUnderVoltageAlarm = (text: string): Throttling | undefined => {
  const value = text.trim()
  if (value !== "0" && value !== "1") return undefined
  return { now: value === "1" ? ["under_voltage"] : [], watched: ["under_voltage"] }
}

/** A thermal zone's `temp`: millidegrees Celsius, as degrees to one decimal; `undefined` if it is not plausible. */
export const parseMillidegrees = (text: string): number | undefined => {
  const trimmed = text.trim()
  if (!/^-?\d{1,7}$/.test(trimmed)) return undefined
  const celsius = Number(trimmed) / 1000
  return celsius < -60 || celsius > 200 ? undefined : Math.round(celsius * 10) / 10
}

/** `write_bytes` from `/proc/self/io`. */
export const parseWriteBytes = (text: string): number | undefined => {
  const match = /^write_bytes:\s*(\d+)\s*$/m.exec(text)
  return match === null ? undefined : Number(match[1])
}

/**
 * Whether the wall clock was stepped between two samples, given each sample's
 * offset of the wall clock from the monotonic one: by how many ms, signed.
 * NTP slewing moves the offset by milliseconds a minute at most; a step moves
 * it at once.
 */
export const clockStep = (previousOffsetMs: number, offsetMs: number): number | undefined => {
  const step = offsetMs - previousOffsetMs
  return Math.abs(step) >= CLOCK_STEP_MS ? step : undefined
}

/** Where the monitor reads from. `liveHostSources` reads the real machine; tests give their own. */
export interface HostSources {
  readonly memory: Effect.Effect<{ readonly rss: number; readonly heap: number }>
  /** CPU time used so far, in seconds. */
  readonly cpuSeconds: Effect.Effect<number>
  /** Event-loop delay since the last call, which starts a new window; `undefined` with no data yet. */
  readonly eventLoopLag: Effect.Effect<{ readonly p99Ms: number; readonly maxMs: number } | undefined>
  /** Wall clock minus monotonic clock, in ms. */
  readonly clockOffsetMs: Effect.Effect<number>
  readonly openFds: Effect.Effect<number | undefined>
  /** Bytes written to storage so far. */
  readonly diskWrittenBytes: Effect.Effect<number | undefined>
  readonly temperatureC: Effect.Effect<number | undefined>
  readonly throttling: Effect.Effect<Throttling | undefined>
  /** Free bytes on the filesystem holding `path`, for this user. */
  readonly diskFreeBytes: (path: string) => Effect.Effect<number | undefined>
}

const THERMAL_ZONE = "/sys/class/thermal/thermal_zone0/temp"

/** How often the `rpi_volt` alarm is read: half the driver's 2 s poll, so no value it reports goes unread. */
export const UNDER_VOLTAGE_POLL_MS = 1_000

/** Where the Raspberry Pi's power and thermal flags come from, and an effect that reads them. */
export interface ThrottlingSource {
  /** What was found at startup. With `none` the reader keeps looking, in case the sensor's driver loads later. */
  readonly kind: "firmware-mask" | "rpi-volt-sensor" | "none"
  readonly read: Effect.Effect<Throttling | undefined>
}

/**
 * Where the Raspberry Pi's power and thermal flags can be read. Kernels before
 * 6.18 expose the firmware's whole mask as `get_throttled`. Later ones only
 * the under-voltage alarm of the `rpi_volt` hwmon sensor, which shows the
 * last 2 seconds: it is polled every `UNDER_VOLTAGE_POLL_MS` until the scope
 * closes, and a read reports under-voltage if any poll since the previous
 * read saw it, so a dip between two 15 s samples is not missed. Neither on a
 * machine that is not a Pi: the reader gives `undefined`, and looks again at
 * every read (a directory listing), since a service can start before udev has
 * loaded the sensor's driver. `sysfs` and `pollMs` are for tests.
 */
export const throttlingSource = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  options: { readonly sysfs?: string; readonly pollMs?: number } = {}
): Effect.fn.Return<ThrottlingSource, never, Scope.Scope> {
  const scope = yield* Effect.scope
  const sysfs = options.sysfs ?? "/sys"
  const readText = (path: string) =>
    fs.readFileString(path).pipe(Effect.orElseSucceed((): string | undefined => undefined))
  const parsedFrom = (path: string, parse: (text: string) => Throttling | undefined) =>
    Effect.map(readText(path), (text) => (text === undefined ? undefined : parse(text)))

  const mask = `${sysfs}/devices/platform/soc/soc:firmware/get_throttled`
  const hwmon = `${sysfs}/class/hwmon`
  const fromSensor = (sensor: string) =>
    Effect.gen(function* () {
      const alarm = parsedFrom(`${hwmon}/${sensor}/in0_lcrit_alarm`, parseUnderVoltageAlarm)
      let seenSinceRead = false
      // Every read looks at the alarm itself; the poller covers the time between reads, from one interval on.
      yield* Effect.sleep(options.pollMs ?? UNDER_VOLTAGE_POLL_MS).pipe(
        Effect.andThen(alarm),
        Effect.tap((alarmNow) =>
          Effect.sync(() => {
            if (alarmNow !== undefined && alarmNow.now.length > 0) seenSinceRead = true
          })
        ),
        Effect.forever,
        Effect.forkIn(scope)
      )
      yield* Effect.logInfo(
        "power conditions from the kernel's rpi_volt sensor: under-voltage only; this kernel does not show throttling"
      )
      return {
        kind: "rpi-volt-sensor",
        read: Effect.map(alarm, (alarmNow): Throttling | undefined => {
          if (alarmNow === undefined) return undefined
          const underVoltage = seenSinceRead || alarmNow.now.length > 0
          seenSinceRead = false
          return { now: underVoltage ? ["under_voltage"] : [], watched: alarmNow.watched }
        })
      } satisfies ThrottlingSource
    })
  const detect = Effect.gen(function* () {
    const maskText = yield* readText(mask)
    if (maskText !== undefined && parseThrottled(maskText) !== undefined) {
      yield* Effect.logInfo("power and thermal conditions from the firmware's mask")
      return { kind: "firmware-mask", read: parsedFrom(mask, parseThrottled) } satisfies ThrottlingSource
    }
    const sensors = yield* fs.readDirectory(hwmon).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
    for (const sensor of sensors) {
      if ((yield* readText(`${hwmon}/${sensor}/name`))?.trim() === "rpi_volt") return yield* fromSensor(sensor)
    }
    return undefined
  })

  const found = yield* detect
  if (found !== undefined) return found
  yield* Effect.logDebug("no Raspberry Pi power or thermal flags here; looking again at every sample")
  let late: ThrottlingSource | undefined
  return {
    kind: "none",
    read: Effect.suspend(() =>
      late !== undefined
        ? late.read
        : Effect.flatMap(detect, (source) => {
            late = source
            return source === undefined ? Effect.sync((): Throttling | undefined => undefined) : source.read
          })
    )
  }
})

/**
 * The real machine. The event-loop histogram runs until the scope closes.
 * Files that do not exist here (not Linux, not a Pi) read as `undefined`.
 */
export const liveHostSources: Effect.Effect<HostSources, never, FileSystem.FileSystem | Scope.Scope> = Effect.gen(
  function* () {
    const fs = yield* FileSystem.FileSystem
    // 20 ms resolution: finer costs a timer per few ms on a small CPU, and a lag under 20 ms is not a problem.
    const histogram = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const h = monitorEventLoopDelay({ resolution: 20 })
        h.enable()
        return h
      }),
      (h) => Effect.sync(() => h.disable())
    )
    const readText = (path: string) =>
      fs.readFileString(path).pipe(Effect.orElseSucceed((): string | undefined => undefined))
    const throttling = yield* throttlingSource(fs)
    return {
      memory: Effect.sync(() => {
        const usage = process.memoryUsage()
        return { rss: usage.rss, heap: usage.heapUsed }
      }),
      cpuSeconds: Effect.sync(() => {
        const usage = process.cpuUsage()
        return (usage.user + usage.system) / 1e6
      }),
      eventLoopLag: Effect.sync(() => {
        if (histogram.count === 0) return undefined
        // The histogram counts in ns, and its floor is the resolution: subtract it to get the lag alone.
        const lag = {
          p99Ms: Math.max(0, histogram.percentile(99) / 1e6 - 20),
          maxMs: Math.max(0, histogram.max / 1e6 - 20)
        }
        histogram.reset()
        return lag
      }),
      clockOffsetMs: Effect.gen(function* () {
        return (yield* Clock.currentTimeMillis) - (yield* monotonicMillis)
      }),
      openFds: fs.readDirectory("/proc/self/fd").pipe(
        Effect.map((entries) => entries.length),
        Effect.orElseSucceed((): number | undefined => undefined)
      ),
      diskWrittenBytes: Effect.map(readText("/proc/self/io"), (text) =>
        text === undefined ? undefined : parseWriteBytes(text)
      ),
      temperatureC: Effect.map(readText(THERMAL_ZONE), (text) =>
        text === undefined ? undefined : parseMillidegrees(text)
      ),
      throttling: throttling.read,
      diskFreeBytes: (path) =>
        Effect.tryPromise(() => statfs(dirname(resolve(path)))).pipe(
          Effect.map((stats) => stats.bavail * stats.bsize),
          Effect.orElseSucceed((): number | undefined => undefined)
        )
    } satisfies HostSources
  }
)

/** One sample, as the status page shows it. */
export interface HostSnapshot {
  readonly memoryBytes: number
  readonly heapBytes: number
  /** Share of one CPU core the gateway used since the previous sample, in percent. */
  readonly cpuPercent: number
  /** The worst event-loop delay of the last minute. */
  readonly eventLoopLagMs: { readonly p99: number; readonly max: number }
  readonly clockSteps: number
  readonly openFds?: number
  readonly temperatureC?: number
  readonly throttled?: Throttling
  readonly diskFreeBytes?: number
}

/** The health message's view of a sample. */
export const hostHealth = (snapshot: HostSnapshot): HostHealth => ({
  memoryBytes: snapshot.memoryBytes,
  eventLoopLagMs: Math.round(snapshot.eventLoopLagMs.max),
  clockSteps: snapshot.clockSteps,
  ...(snapshot.temperatureC === undefined ? {} : { temperatureC: snapshot.temperatureC }),
  ...(snapshot.throttled === undefined
    ? {}
    : { throttled: snapshot.throttled.now, throttledWatched: snapshot.throttled.watched }),
  ...(snapshot.diskFreeBytes === undefined ? {} : { diskFreeBytes: snapshot.diskFreeBytes })
})

export interface HostMonitorOptions {
  /** The outbox's file: its filesystem's free space is reported. */
  readonly bufferPath?: string
  /** The gateway's version, for `ot_gateway_process_start_time_seconds`. */
  readonly version: string
  readonly intervalMs?: number
}

export interface HostMonitor {
  /** The last sample, once there is one. */
  readonly latest: () => HostSnapshot | undefined
  /** Sample now and then every interval, until interrupted. */
  readonly run: Effect.Effect<never>
}

const gauge = (metric: typeof processMemory, attributes: Record<string, string>, value: number) =>
  Metric.update(Metric.withAttributes(metric, attributes), value)

export const makeHostMonitor = Effect.fnUntraced(function* (sources: HostSources, options: HostMonitorOptions) {
  const startedAt = yield* Clock.currentTimeMillis
  let latest: HostSnapshot | undefined
  const lagWindows: Array<{ readonly p99Ms: number; readonly maxMs: number }> = []
  let previous: {
    readonly at: number
    readonly cpu: number
    readonly written: number | undefined
    readonly offset: number
  } = {
    at: yield* monotonicMillis,
    cpu: yield* sources.cpuSeconds,
    offset: yield* sources.clockOffsetMs,
    written: yield* sources.diskWrittenBytes
  }
  let steps = 0
  let stalled = false
  let hot = false
  let lowDisk = false
  let conditions: ReadonlyArray<ThrottleCondition> = []
  const throttleWindows: Array<ReadonlyArray<ThrottleCondition>> = []
  let reportedSinceBoot = false

  const sample = Effect.gen(function* () {
    const at = yield* monotonicMillis
    const memory = yield* sources.memory
    const cpu = yield* sources.cpuSeconds
    const offset = yield* sources.clockOffsetMs
    const written = yield* sources.diskWrittenBytes
    const lag = yield* sources.eventLoopLag
    const openFds = yield* sources.openFds
    const temperatureC = yield* sources.temperatureC
    const throttled = yield* sources.throttling
    const diskFreeBytes =
      options.bufferPath === undefined ? undefined : yield* sources.diskFreeBytes(options.bufferPath)

    yield* gauge(processMemory, { kind: "rss" }, memory.rss)
    yield* gauge(processMemory, { kind: "heap" }, memory.heap)
    if (cpu > previous.cpu) yield* Metric.update(processCpu, cpu - previous.cpu)
    if (written !== undefined && previous.written !== undefined && written > previous.written)
      yield* Metric.update(processDiskWritten, written - previous.written)
    if (openFds !== undefined) yield* Metric.update(processOpenFds, openFds)

    // Event loop: the gauges show the worst of the last minute, so a stall between two exports is not missed.
    if (lag !== undefined) {
      lagWindows.push(lag)
      if (lagWindows.length > LAG_WINDOWS) lagWindows.shift()
      if (!stalled && lag.maxMs >= STALL_MS) {
        stalled = true
        yield* Effect.logWarning("event loop stalled: every device and deadline waits for it").pipe(
          Effect.annotateLogs({ lagMs: Math.round(lag.maxMs) })
        )
      } else if (stalled && lag.maxMs < STALL_MS) {
        stalled = false
        yield* Effect.logInfo("event loop responsive again").pipe(Effect.annotateLogs({ lagMs: Math.round(lag.maxMs) }))
      }
    }
    const worstLag = {
      p99: Math.max(0, ...lagWindows.map((window) => window.p99Ms)),
      max: Math.max(0, ...lagWindows.map((window) => window.maxMs))
    }
    yield* gauge(eventLoopLag, { quantile: "p99" }, worstLag.p99 / 1000)
    yield* gauge(eventLoopLag, { quantile: "max" }, worstLag.max / 1000)

    const step = clockStep(previous.offset, offset)
    if (step !== undefined) {
      steps++
      const direction = step > 0 ? "forward" : "backward"
      yield* Metric.update(Metric.withAttributes(clockSteps, { direction }), 1)
      yield* Effect.logWarning("wall clock stepped; timestamps jump with it, deadlines do not").pipe(
        Effect.annotateLogs({ direction, stepMs: Math.round(step) })
      )
    }

    if (temperatureC !== undefined) {
      yield* Metric.update(hostTemperature, temperatureC)
      if (!hot && temperatureC >= HOT_C) {
        hot = true
        yield* Effect.logWarning("host is hot").pipe(Effect.annotateLogs({ temperatureC }))
      } else if (hot && temperatureC < COOL_C) {
        hot = false
        yield* Effect.logInfo("host has cooled down").pipe(Effect.annotateLogs({ temperatureC }))
      }
    }

    // Power and thermal conditions: what any of the last minute's samples saw, like the event-loop gauges, so a
    // dip between two exports still shows, and a supply that keeps dipping is one warning, cleared after a clean minute.
    let recentlyThrottled: Throttling | undefined
    // A sample the source could not read leaves the window as it was, so it cannot clear a condition early.
    if (throttled !== undefined) {
      throttleWindows.push(throttled.now)
      if (throttleWindows.length > LAG_WINDOWS) throttleWindows.shift()
      const recent = throttled.watched.filter((condition) => throttleWindows.some((now) => now.includes(condition)))
      recentlyThrottled = { ...throttled, now: recent }
      // Only what the source can see: a 0 for a condition it cannot see would read as "fine".
      for (const condition of throttled.watched)
        yield* gauge(hostThrottled, { condition }, recent.includes(condition) ? 1 : 0)
      const started = recent.filter((condition) => !conditions.includes(condition))
      if (started.length > 0) {
        yield* Effect.logWarning("host reports a power or thermal condition").pipe(
          Effect.annotateLogs({ conditions: recent.join(",") })
        )
      } else if (conditions.length > 0 && recent.length === 0) {
        yield* Effect.logInfo("host conditions cleared").pipe(Effect.annotateLogs({ was: conditions.join(",") }))
      }
      // Something before the gateway started, or between two samples: the firmware remembers it until reboot.
      const sinceBoot = throttled.sinceBoot ?? []
      if (!reportedSinceBoot && started.length === 0 && sinceBoot.length > 0) {
        reportedSinceBoot = true
        yield* Effect.logWarning("host has reported power or thermal conditions since boot").pipe(
          Effect.annotateLogs({ conditions: sinceBoot.join(",") })
        )
      }
      if (started.length > 0) reportedSinceBoot = true
      conditions = recent
    }

    if (diskFreeBytes !== undefined) {
      yield* Metric.update(bufferDiskFree, diskFreeBytes)
      if (!lowDisk && diskFreeBytes < LOW_DISK_BYTES) {
        lowDisk = true
        yield* Effect.logWarning("the outbox's disk is nearly full").pipe(
          Effect.annotateLogs({ freeBytes: diskFreeBytes })
        )
      } else if (lowDisk && diskFreeBytes >= ROOMY_BYTES) {
        lowDisk = false
        yield* Effect.logInfo("the outbox's disk has room again").pipe(
          Effect.annotateLogs({ freeBytes: diskFreeBytes })
        )
      }
    }

    const elapsedSeconds = (at - previous.at) / 1000
    latest = {
      memoryBytes: memory.rss,
      heapBytes: memory.heap,
      cpuPercent: elapsedSeconds > 0 ? Math.max(0, Math.round(((cpu - previous.cpu) / elapsedSeconds) * 1000) / 10) : 0,
      eventLoopLagMs: { p99: Math.round(worstLag.p99), max: Math.round(worstLag.max) },
      clockSteps: steps,
      ...(openFds === undefined ? {} : { openFds }),
      ...(temperatureC === undefined ? {} : { temperatureC }),
      ...(recentlyThrottled === undefined ? {} : { throttled: recentlyThrottled }),
      ...(diskFreeBytes === undefined ? {} : { diskFreeBytes })
    }
    previous = { at, cpu, offset, written }
  })

  const run = Effect.gen(function* () {
    yield* Metric.update(
      Metric.withAttributes(processStart, { version: options.version, node: process.versions.node }),
      startedAt / 1000
    )
    return yield* sample.pipe(
      Effect.repeat(Schedule.spaced(options.intervalMs ?? SAMPLE_INTERVAL_MS)),
      Effect.andThen(Effect.never)
    )
  })

  return { latest: () => latest, run } satisfies HostMonitor
})
