/**
 * The machine under the gateway, only when it needs someone on site: too little power, too hot, a full disk, or a
 * gateway that cannot keep up. Each problem is a sentence that says what it means and what to do. While all is fine
 * the page says nothing about the machine; the raw sample (event-loop lag, heap, open files, clock steps) is in
 * `/api/status`, the health message and telemetry, for people and agents who debug.
 */
import type { HostStatus } from "@ot-gateway/api"
import { formatBytes } from "./status"

/** The gateway's one thread was blocked this long in the last minute: everything waited (docs/troubleshooting.md). */
export const STALL_MS = 1000
/** Busier than this share of one core leaves little room for a burst of reads. */
export const BUSY_CPU_PERCENT = 90
/** A Raspberry Pi starts slowing itself down at 80 °C. */
export const HOT_C = 80
/** Below this, the outbox cannot keep values while the broker is away for long. */
export const LOW_DISK_BYTES = 64 * 1024 * 1024
/** Starting up (opening files, the first reads, connecting) keeps the gateway busy for a moment; that is not a problem. */
export const WARM_UP_MS = 60_000

const seconds = (ms: number) => `${Number((ms / 1000).toFixed(1))} s`

/**
 * What is wrong with the machine, most urgent first; empty while all is fine or the machine cannot tell. `upMs` is
 * how long the gateway has run: in its first minute, a busy or stalled gateway is only starting up.
 */
export const machineProblems = (host: HostStatus, upMs: number): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const conditions = host.throttled?.now ?? []
  if (conditions.includes("under_voltage"))
    problems.push("The power supply is too weak: the Raspberry Pi gets too little voltage. Use a stronger supply.")
  else if (conditions.length > 0)
    problems.push("The Raspberry Pi slows itself down to protect itself from heat or weak power.")
  if (host.temperatureC !== undefined && host.temperatureC >= HOT_C)
    problems.push(`The machine is too hot (${Math.round(host.temperatureC)} °C): give it air or a heat sink.`)
  if (host.diskFreeBytes !== undefined && host.diskFreeBytes < LOW_DISK_BYTES)
    problems.push(
      `The disk is almost full (${formatBytes(host.diskFreeBytes)} left): values cannot be kept while the broker is away.`
    )
  if (upMs < WARM_UP_MS) return problems
  if (host.eventLoopLagMs.max >= STALL_MS)
    problems.push(
      `The gateway stalled for up to ${seconds(host.eventLoopLagMs.max)} in the last minute: reads and messages waited.`
    )
  else if (host.cpuPercent >= BUSY_CPU_PERCENT)
    problems.push(`The gateway is busy (${Math.round(host.cpuPercent)} % of a processor core): little room is left.`)
  return problems
}

/**
 * The machine in one calm line, for its card while all is fine: "CPU 4 % · 85 MB memory · 52 °C", the temperature
 * only where the machine has one.
 */
export const machineNote = (host: HostStatus) =>
  [
    `CPU ${Math.round(host.cpuPercent)} %`,
    `${formatBytes(host.memoryBytes)} memory`,
    ...(host.temperatureC === undefined ? [] : [`${Math.round(host.temperatureC)} °C`])
  ].join(" · ")

/** What the CPU share means: of one core, so a busy start on a machine with several cores reads over 100 %. */
export const CPU_HINT = "CPU is the gateway's share of one processor core: over 100 % means it used more than one core."

/**
 * The Machine card: its title, its line and whether it needs a look. Calm while all is fine; the first problem in
 * its own words otherwise. In its first minute (`WARM_UP_MS`) the gateway is "starting" and its line leaves the CPU
 * out: opening files and the first reads keep it busy, and "CPU 115 %" then only looks broken.
 */
export const machineCard = (host: HostStatus | undefined, upMs: number) => {
  if (host === undefined) return { title: "–", note: "no sample yet", bad: false }
  const problems = machineProblems(host, upMs)
  const [first] = problems
  if (first !== undefined)
    return { title: problems.length === 1 ? "1 problem" : `${problems.length} problems`, note: first, bad: true }
  if (upMs < WARM_UP_MS)
    return {
      title: "starting",
      note: [
        `${formatBytes(host.memoryBytes)} memory`,
        ...(host.temperatureC === undefined ? [] : [`${Math.round(host.temperatureC)} °C`])
      ].join(" · "),
      bad: false
    }
  return { title: "ok", note: machineNote(host), hint: CPU_HINT, bad: false }
}

/** The power supply as a Raspberry Pi reports it, in words; `undefined` off a Pi. */
export const powerLabel = (host: HostStatus) => {
  const conditions = host.throttled?.now
  if (conditions === undefined) return undefined
  if (conditions.includes("under_voltage")) return "too weak"
  if (conditions.length > 0) return `slowed down (${conditions.join(", ").replaceAll("_", " ")})`
  return "ok"
}
