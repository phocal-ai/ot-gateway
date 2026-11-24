/**
 * Local times in `--json`: each Unix ms time gets `<key>Local`, an ISO 8601 string in this machine's zone with its
 * UTC offset, and the answer names the zone. The zone is fixed per test through `process.env.TZ`, which Node reads
 * again when it changes. The last tests guard the set of time keys: a report or an API schema that gains a time
 * (or any number) the set does not classify fails here.
 */
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { EventLog, GatewayStatus, HistorySeries, Messages, type MessageStatus, type PointInfo } from "@ot-gateway/api"
import { Effect, type SchemaAST } from "effect"
import { TestConsole } from "effect/testing"
import { historyJson } from "../src/HistoryReport.ts"
import { printJsonWithLocalTimes, TIME_KEYS, withLocalTimes } from "../src/JsonTimes.ts"
import { messagesJson } from "../src/MessagesReport.ts"
import { localIsoTime, localTime, localTimeZone } from "../src/Output.ts"
import { eventJson, eventsJson, eventsWithin, recentIncidents, statusJson } from "../src/StatusReport.ts"

const originalZone = process.env.TZ

const useZone = (zone: string) => {
  process.env.TZ = zone
}

beforeEach(() => useZone("Europe/Vienna"))
afterEach(() => {
  if (originalZone === undefined) delete process.env.TZ
  else process.env.TZ = originalZone
})

/** 2026-11-24 13:21:03.109 UTC: 14:21:03.109 in Vienna. */
const T = Date.UTC(2026, 10, 24, 13, 21, 3, 109)
const minutes = (count: number) => count * 60_000

describe("a local ISO time", () => {
  it("gives the moment in this machine's zone with its offset, and parses back to the same ms", () => {
    expect(localIsoTime(T)).toBe("2026-11-24T14:21:03.109+01:00")
    expect(Date.parse(localIsoTime(T))).toBe(T)
    expect(localIsoTime(new Date(T))).toBe("2026-11-24T14:21:03.109+01:00")
    expect(localTimeZone()).toBe("Europe/Vienna")
  })

  it("follows daylight saving time, both ways", () => {
    // Spring forward: 2026-03-29 01:00 UTC, the clock jumps from 02:00 to 03:00.
    const spring = Date.UTC(2026, 2, 29, 1, 0, 0, 0)
    expect(localIsoTime(spring - 1)).toBe("2026-03-29T01:59:59.999+01:00")
    expect(localIsoTime(spring)).toBe("2026-03-29T03:00:00.000+02:00")
    // Fall back: 2026-10-25 01:00 UTC, 02:00 to 03:00 happens twice; the offset tells them apart.
    const fall = Date.UTC(2026, 9, 25, 1, 0, 0, 0)
    expect(localIsoTime(fall - minutes(30))).toBe("2026-10-25T02:30:00.000+02:00")
    expect(localIsoTime(fall + minutes(30))).toBe("2026-10-25T02:30:00.000+01:00")
    for (const moment of [spring - 1, spring, fall - minutes(30), fall + minutes(30)]) {
      expect(Date.parse(localIsoTime(moment))).toBe(moment)
    }
  })

  it("writes offsets with minutes, west of UTC and at UTC", () => {
    useZone("Asia/Kolkata")
    expect(localIsoTime(T)).toBe("2026-11-24T18:51:03.109+05:30")
    useZone("America/St_Johns")
    expect(localIsoTime(T)).toBe("2026-11-24T09:51:03.109-03:30")
    useZone("America/New_York")
    expect(localIsoTime(T)).toBe("2026-11-24T08:21:03.109-05:00")
    expect(localTimeZone()).toBe("America/New_York")
    useZone("UTC")
    expect(localIsoTime(T)).toBe("2026-11-24T13:21:03.109+00:00")
  })

  it("is the clock the text output uses", () => {
    expect(localIsoTime(T)).toContain(`T${localTime(T)}.`)
  })
})

describe("withLocalTimes", () => {
  it("adds <key>Local after each time, at any depth, and leaves the rest as it is", () => {
    const result = withLocalTimes({
      now: T,
      since: "10m",
      count: 3,
      nested: { events: [{ id: 1, at: T, downMs: 5000 }] }
    })
    expect(result).toEqual({
      now: T,
      nowLocal: "2026-11-24T14:21:03.109+01:00",
      since: "10m",
      count: 3,
      nested: { events: [{ id: 1, at: T, atLocal: "2026-11-24T14:21:03.109+01:00", downMs: 5000 }] }
    })
    // Right after its time, so a person reading the JSON sees both together.
    expect(Object.keys(result)).toEqual(["now", "nowLocal", "since", "count", "nested"])
  })

  it("leaves a counter's readings (from, to) alone, and a history bucket's first and last read", () => {
    expect(withLocalTimes({ type: "counter-jumped", at: T, from: 100, to: 9000 })).toEqual({
      type: "counter-jumped",
      at: T,
      atLocal: "2026-11-24T14:21:03.109+01:00",
      from: 100,
      to: 9000
    })
    expect(withLocalTimes({ buckets: [{ t: T, first: T, last: T }] })).toEqual({
      buckets: [{ t: T, tLocal: "2026-11-24T14:21:03.109+01:00", first: T, last: T }]
    })
  })

  it.effect("names the time zone after ok", () =>
    Effect.gen(function* () {
      yield* printJsonWithLocalTimes({ ok: true, now: T })
      const printed = String((yield* TestConsole.logLines).at(-1))
      expect(Object.keys(JSON.parse(printed))).toEqual(["ok", "timeZone", "now", "nowLocal"])
      expect(JSON.parse(printed)).toMatchObject({ timeZone: "Europe/Vienna" })
    }).pipe(Effect.provide(TestConsole.layer))
  )
})

// ---- The reports, built from fixtures with every time field set ----

const gateway = { site: "plant-1", building: "hall-a", id: "main" }

const status: GatewayStatus = {
  ...gateway,
  since: T - minutes(120),
  now: T,
  configSince: T - minutes(60),
  broker: {
    url: "mqtt://broker:1883",
    connected: false,
    connectedAt: T - minutes(119),
    disconnectedSince: T - minutes(2),
    lastError: "connection refused",
    connects: 2,
    failedConnects: 3,
    published: 900,
    publishFailures: 1
  },
  buffer: {
    path: "buf.sqlite",
    rows: 42,
    maxRows: 1000,
    dropped: 3,
    written: 45,
    delivered: 2,
    droppedBy: { overflow: 3 },
    failures: 0,
    disabled: false
  },
  host: {
    version: "0.13.0",
    node: "24.0.0",
    memoryBytes: 80_000_000,
    heapBytes: 30_000_000,
    cpuPercent: 3,
    eventLoopLagMs: { p99: 4, max: 12 },
    clockSteps: 0,
    openFds: 40,
    temperatureC: 51,
    throttled: { now: [], watched: ["under-voltage"] },
    diskFreeBytes: 9_000_000_000
  },
  devices: [
    {
      id: "energy-meter",
      protocol: "modbus-tcp",
      status: "failing",
      pollIntervalMs: 5000,
      reason: "connection",
      failingSince: T - minutes(3),
      lastError: "connection refused",
      failures: 14,
      lastSuccess: T - minutes(4),
      host: "10.0.1.1",
      pointCount: 1,
      points: [{ id: "active-power", name: "Active power", unit: "unit:KiloW", writable: false, value: 12.5, ts: T }]
    }
  ],
  alarms: [
    {
      device: "energy-meter",
      point: "fault",
      alarmWhen: "on",
      active: true,
      since: T - minutes(5),
      raised: 4,
      flapping: true,
      pattern: { onMs: 2000, offMs: 3000, raised: 4, overMs: 900_000 }
    }
  ],
  commands: [{ at: T - minutes(1), device: "energy-meter", point: "setpoint", status: "written" }]
}

const at = (minutesAgo: number) => T - minutes(minutesAgo)

const log: EventLog = {
  now: T,
  capacity: 500,
  dropped: 0,
  events: [
    { id: 1, at: at(120), type: "gateway-started", version: "0.13.0", devices: 1 },
    {
      id: 2,
      at: at(10),
      type: "device-failing",
      device: "energy-meter",
      reason: "connection",
      error: "connection refused",
      answeredBefore: true,
      lastReadAt: at(11)
    },
    {
      id: 3,
      at: at(8),
      type: "device-recovered",
      device: "energy-meter",
      downMs: 120_000,
      lastReadAt: at(11),
      failingSince: at(10),
      noDataMs: 180_000
    },
    { id: 4, at: at(7), type: "broker-disconnected", error: "connection reset" },
    { id: 5, at: at(6), type: "broker-connected", downMs: 60_000, retries: 3, buffered: 12 },
    { id: 6, at: at(6), type: "buffer-drained", delivered: 12, buffered: 12, queued: 0 },
    { id: 7, at: at(5), type: "config-applied", summary: "1 device" },
    { id: 8, at: at(5), type: "config-apply-failed", error: "bad port" },
    { id: 9, at: at(5), type: "gateway-conflict", gateway: "other", devices: ["energy-meter"], sameId: false },
    {
      id: 10,
      at: at(4),
      type: "alarm-raised",
      device: "energy-meter",
      point: "fault",
      value: true,
      first: true,
      afterOutage: true,
      unknownMs: 90_000
    },
    {
      id: 11,
      at: at(4),
      type: "alarm-cleared",
      device: "energy-meter",
      point: "fault",
      value: false,
      activeMs: 30_000,
      afterOutage: true,
      unknownMs: 90_000
    },
    {
      id: 12,
      at: at(3),
      type: "alarm-flapping",
      device: "energy-meter",
      point: "fault",
      raised: 6,
      pattern: { onMs: 2000, offMs: 3000, raised: 6, overMs: 900_000 }
    },
    {
      id: 13,
      at: at(2),
      type: "alarm-settled",
      device: "energy-meter",
      point: "fault",
      active: false,
      since: at(2),
      unlisted: 3,
      pattern: { onMs: 2000, offMs: 3000, raised: 6, overMs: 900_000 }
    }
  ],
  valueEvents: [
    {
      id: 14,
      at: at(1),
      type: "counter-went-back",
      device: "energy-meter",
      point: "energy",
      unit: "unit:KiloW-HR",
      from: 1200,
      to: 3
    },
    {
      id: 15,
      at: at(1),
      type: "counter-jumped",
      device: "energy-meter",
      point: "energy",
      unit: "unit:KiloW-HR",
      from: 1200,
      to: 900_000,
      elapsedMs: 5000,
      usualPerHour: 2
    }
  ]
}

const power: PointInfo = {
  device: "energy-meter",
  id: "active-power",
  name: "Active power",
  unit: "unit:KiloW",
  writable: false,
  topic: "plant-1/hall-a/energy-meter/active-power",
  source: "holding 0 · float32 ABCD",
  read: "polled every 5 s",
  cov: false,
  publish: "every read"
}

/** Ten minute buckets from 30 min ago; the gateway started in the second, the device failed from the sixth on. */
const series: HistorySeries = {
  device: "energy-meter",
  point: "active-power",
  from: at(30),
  to: T,
  stepMs: minutes(1),
  resolution: "read",
  live: true,
  buckets: [0, 3, 4, 9].map((index) => ({
    t: at(30) + minutes(index),
    min: 1,
    max: 2,
    avg: 1.5,
    count: 12,
    first: at(30) + minutes(index) + 1000,
    last: at(30) + minutes(index) + 55_000
  })),
  changes: {
    list: [
      { t: at(30), value: 1 },
      { t: at(26), value: 2 }
    ],
    truncated: false
  }
}

const messages: ReadonlyArray<MessageStatus> = [
  {
    topic: "plant-1/hall-a/energy-meter/active-power",
    payload: `{"value":12.5,"ts":${T}}`,
    truncated: false,
    retained: false,
    at: T,
    count: 3,
    delivered: 2,
    notSent: 0,
    lost: 1
  }
]

const reports = {
  status: statusJson(status, recentIncidents(log)),
  events: eventsJson(
    gateway,
    log,
    status.since,
    minutes(180),
    eventsWithin(log, minutes(180)).map((event) => eventJson(event, new Map()))
  ),
  history: historyJson(gateway, T, "30m", [
    {
      point: power,
      series,
      context: {
        since: at(29) + 30_000,
        failures: [{ from: at(24), to: at(22), error: "connection refused", lastReadAt: at(26) + 55_000 }],
        readGapMs: 30_000
      }
    }
  ]),
  messages: messagesJson(
    gateway,
    status,
    { messages, droppedTopics: 0, window: { from: at(10), to: T } },
    new Map([[messages[0]?.topic ?? "", "every read"]])
  )
}

/**
 * Times in the fixtures are all after 2001 (> 1e12 ms), and no other number is that large: a number like that without
 * a `Local` string is a time the key set misses, and a `Local` string next to a smaller number is one it wrongly has.
 * Here, and only here, a number's size tells a time; `JsonTimes.ts` never guesses.
 */
const LOOKS_LIKE_A_TIME = 1e12

/** Times without a local string on purpose (JsonTimes.ts, UNLABELLED_UNDER): a history bucket's first and last read. */
const unlabelled = (path: string) => /\.buckets\[\d+\]\.(first|last)$/.test(path)

const misclassified = (value: unknown, path = "$"): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap((each, index) => misclassified(each, `${path}[${index}]`))
  if (typeof value !== "object" || value === null) return []
  const entries = Object.entries(value)
  const keys = new Set(entries.map(([key]) => key))
  return entries.flatMap(([key, each]): ReadonlyArray<string> => {
    const here = `${path}.${key}`
    if (typeof each === "number") {
      const labelled = keys.has(`${key}Local`)
      if (each >= LOOKS_LIKE_A_TIME && !labelled && !unlabelled(here)) return [`${here}: a time without ${key}Local`]
      if (each < LOOKS_LIKE_A_TIME && labelled) return [`${here}: ${key}Local next to a number that is no time`]
      return []
    }
    if (typeof each === "string" && key.endsWith("Local")) {
      const time = Reflect.get(value, key.slice(0, -"Local".length))
      return Date.parse(each) === time ? [] : [`${here}: ${each} is not ${String(time)}`]
    }
    return misclassified(each, here)
  })
}

describe("each report's --json", () => {
  for (const [name, report] of Object.entries(reports)) {
    it(`${name}: every time has its local string, and nothing else has one`, () => {
      const printed = withLocalTimes(report)
      expect(misclassified(printed)).toEqual([])
      // The fixture reaches the times it should: at least the answer's own `now`.
      expect(printed).toMatchObject({ now: T, nowLocal: "2026-11-24T14:21:03.109+01:00" })
    })
  }

  it("gives history its gaps' times and its buckets' starts, and keeps the buckets small", () => {
    const printed = JSON.stringify(withLocalTimes(reports.history))
    expect(printed).toContain('"emptyFromLocal"')
    expect(printed).toContain('"startedLocal"')
    expect(printed).toContain('"tLocal"')
    expect(printed).not.toContain('"firstLocal"')
    expect(printed).not.toContain('"lastLocal"')
  })

  it("gives status's recent incidents and events' gateway start their local times", () => {
    expect(JSON.stringify(withLocalTimes(reports.status))).toContain('"detectedAtLocal"')
    expect(JSON.stringify(withLocalTimes(reports.status))).toContain('"recoveredAtLocal"')
    expect(withLocalTimes(reports.events)).toMatchObject({ gatewayStartedLocal: expect.any(String) })
  })
})

/**
 * Every number in the API answers the reports pass on that is not a time, by key. A schema that gains a number fails
 * this test until it is named here or in `TIME_KEYS`, also an optional one no fixture above sets.
 */
const NOT_TIMES: ReadonlySet<string> = new Set([
  "activeMs",
  "avg",
  "buffered",
  "capacity",
  "clockSteps",
  "connects",
  "count",
  "cpuPercent",
  "delivered",
  "devices",
  "diskFreeBytes",
  "downMs",
  "dropped",
  "droppedTopics",
  "elapsedMs",
  "failedConnects",
  "failures",
  "heapBytes",
  "id",
  "keepAliveSeconds",
  "lost",
  "max",
  "maximumPacketSize",
  "maxRows",
  "memoryBytes",
  "min",
  "noDataMs",
  "notSent",
  "offMs",
  "onMs",
  "openFds",
  "overMs",
  "p99",
  "pointCount",
  "pollIntervalMs",
  "publishFailures",
  "published",
  "queued",
  "raised",
  "receiveMaximum",
  "retries",
  "rows",
  "stepMs",
  "temperatureC",
  "unknownMs",
  "unlisted",
  "usualPerHour",
  "value",
  "written"
])

const numberKeys = (ast: SchemaAST.AST, seen: Set<SchemaAST.AST> = new Set()): ReadonlyArray<string> => {
  if (seen.has(ast)) return []
  seen.add(ast)
  if (ast._tag === "Objects") {
    return [
      ...ast.propertySignatures.flatMap((property) => [
        ...(property.type._tag === "Number" ? [String(property.name)] : []),
        ...numberKeys(property.type, seen)
      ]),
      ...ast.indexSignatures.flatMap((index) => numberKeys(index.type, seen))
    ]
  }
  if (ast._tag === "Arrays") return [...ast.elements, ...ast.rest].flatMap((element) => numberKeys(element, seen))
  if (ast._tag === "Union") return ast.types.flatMap((member) => numberKeys(member, seen))
  if (ast._tag === "Suspend") return numberKeys(ast.thunk(), seen)
  return []
}

describe("the set of time keys", () => {
  it("classifies every number of the API answers the reports print", () => {
    const keys = new Set([GatewayStatus, EventLog, HistorySeries, Messages].flatMap((schema) => numberKeys(schema.ast)))
    expect(keys.size).toBeGreaterThan(30)
    expect([...keys].filter((key) => !TIME_KEYS.has(key) && !NOT_TIMES.has(key))).toEqual([])
    expect([...TIME_KEYS].filter((key) => NOT_TIMES.has(key))).toEqual([])
  })
})
