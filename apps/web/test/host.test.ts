import { describe, expect, it } from "@effect/vitest"
import type { HostStatus } from "@ot-gateway/api"
import { CPU_HINT, machineCard, machineNote, machineProblems, powerLabel } from "../src/lib/host.ts"

/** Long past starting up. */
const up = 3_600_000

const healthy: HostStatus = {
  version: "0.9.0",
  node: "22.18.0",
  memoryBytes: 85_000_000,
  heapBytes: 40_000_000,
  cpuPercent: 4,
  eventLoopLagMs: { p99: 3, max: 12 },
  clockSteps: 1,
  openFds: 30,
  temperatureC: 52.4,
  throttled: { now: [], watched: ["under_voltage"] },
  diskFreeBytes: 12_000_000_000
}

describe("machineProblems", () => {
  it("says nothing about a healthy machine, clock steps included", () => {
    expect(machineProblems(healthy, up)).toEqual([])
  })

  it("says nothing off a Pi, where there is no power or temperature to tell", () => {
    const { throttled: _throttled, temperatureC: _temperature, diskFreeBytes: _disk, ...plain } = healthy
    expect(machineProblems(plain, up)).toEqual([])
  })

  it("names each problem with what to do, power first", () => {
    expect(
      machineProblems(
        {
          ...healthy,
          throttled: { now: ["under_voltage"], watched: ["under_voltage"] },
          temperatureC: 83,
          diskFreeBytes: 10_000_000,
          eventLoopLagMs: { p99: 40, max: 2300 }
        },
        up
      )
    ).toEqual([
      "The power supply is too weak: the Raspberry Pi gets too little voltage. Use a stronger supply.",
      "The machine is too hot (83 °C): give it air or a heat sink.",
      "The disk is almost full (10.0 MB left): values cannot be kept while the broker is away.",
      "The gateway stalled for up to 2.3 s in the last minute: reads and messages waited."
    ])
  })

  it("tells throttling apart from under-voltage", () => {
    expect(machineProblems({ ...healthy, throttled: { now: ["soft_temperature_limit"], watched: [] } }, up)).toEqual([
      "The Raspberry Pi slows itself down to protect itself from heat or weak power."
    ])
  })

  it("calls a busy processor a problem only without a stall", () => {
    expect(machineProblems({ ...healthy, cpuPercent: 95 }, up)).toEqual([
      "The gateway is busy (95 % of a processor core): little room is left."
    ])
    expect(machineProblems({ ...healthy, cpuPercent: 95, eventLoopLagMs: { p99: 40, max: 1500 } }, up)).toHaveLength(1)
  })

  it("does not call starting up busy, but names power, heat and disk at once", () => {
    const starting = { ...healthy, cpuPercent: 116, eventLoopLagMs: { p99: 40, max: 1500 } }
    expect(machineProblems(starting, 10_000)).toEqual([])
    expect(machineProblems({ ...starting, temperatureC: 85 }, 10_000)).toEqual([
      "The machine is too hot (85 °C): give it air or a heat sink."
    ])
    expect(machineProblems(starting, 60_000)).toHaveLength(1)
  })
})

describe("machineNote", () => {
  it("sums a healthy machine up in one line, the temperature where there is one", () => {
    expect(machineNote(healthy)).toBe("CPU 4 % · 85.0 MB memory · 52 °C")
    const { temperatureC: _temperature, ...cool } = healthy
    expect(machineNote(cool)).toBe("CPU 4 % · 85.0 MB memory")
  })
})

describe("machineCard", () => {
  it("says starting and leaves the CPU out in the first minute", () => {
    const card = machineCard({ ...healthy, cpuPercent: 115 }, 10_000)
    expect(card).toMatchObject({ title: "starting", bad: false })
    expect(card.note).not.toContain("CPU")
    expect(card.note).toMatch(/memory · 52 °C$/)
  })

  it("is ok with the CPU, explained as a share of one core, once warmed up", () => {
    const card = machineCard(healthy, up)
    expect(card.title).toBe("ok")
    expect(card.note).toContain("CPU 4 %")
    expect(card.hint).toBe(CPU_HINT)
    expect(CPU_HINT).toContain("one processor core")
  })

  it("leads with a problem, also while starting, and says when there is no sample", () => {
    const hot = machineCard({ ...healthy, temperatureC: 85 }, 10_000)
    expect(hot).toMatchObject({ title: "1 problem", bad: true })
    expect(machineCard(undefined, up)).toEqual({ title: "–", note: "no sample yet", bad: false })
  })
})

describe("powerLabel", () => {
  it("says how the power is on a Pi, and nothing elsewhere", () => {
    expect(powerLabel(healthy)).toBe("ok")
    expect(powerLabel({ ...healthy, throttled: { now: ["under_voltage"], watched: ["under_voltage"] } })).toBe(
      "too weak"
    )
    expect(powerLabel({ ...healthy, throttled: { now: ["soft_temperature_limit"], watched: [] } })).toBe(
      "slowed down (soft temperature limit)"
    )
    const { throttled: _throttled, ...plain } = healthy
    expect(powerLabel(plain)).toBeUndefined()
  })
})
