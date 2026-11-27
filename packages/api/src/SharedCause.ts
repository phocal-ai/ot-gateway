/**
 * Several devices that stop answering within seconds of each other point at one cause (power, a switch, the
 * gateway's own network), not at each device. `ot-gateway status`, `ot-gateway events` and the status page's events
 * say so in the same words, from these pure functions.
 */
import { gatewaySideFailure } from "./Hints.ts"

/** Failing devices that all started failing within this much of each other point at one cause, not at each device. */
export const SHARED_CAUSE_WINDOW_MS = 10_000

/** `12 s`, `4 min`, `3 h`, `2 d`: a duration as coarse as a glance needs. */
export const roughDuration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 120) return `${seconds} s`
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`
  return `${Math.round(seconds / 86_400)} d`
}

/**
 * `45 s`, `2 min 5 s`, `4 min`, then as `roughDuration` from 10 minutes on: how long an outage lasted, exact to the
 * second while that is still worth reading.
 */
export const preciseDuration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds} s`
  if (seconds >= 600) return roughDuration(milliseconds)
  const rest = seconds % 60
  return rest === 0 ? `${seconds / 60} min` : `${Math.floor(seconds / 60)} min ${rest} s`
}

/**
 * `<who> stopped answering within 6 s of each other: likely a shared cause (…)`. With `host`, the devices all sit on
 * that one host (a Modbus gateway, a controller with several units): `…, both on 10.0.0.5: likely the host itself, its
 * power or its network link`, which `count` makes `both` or `all`.
 */
export const sharedCauseLine = (who: string, spreadMs: number, host?: string, count = 2) =>
  host === undefined
    ? `${who} stopped answering within ${roughDuration(spreadMs)} of each other: likely a shared cause (power, a switch, the gateway's own network)`
    : `${who} stopped answering within ${roughDuration(spreadMs)} of each other, ${count === 2 ? "both" : "all"} on ${host}: likely the host itself, its power or its network link`

/** `a, b, c`, or of many the first five and `and 10 more`: a line names a few devices, the JSON has every one. */
export const firstNames = (names: ReadonlyArray<string>, limit = 5) =>
  names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`

/** `host` without IPv6 brackets, in lower case: `[::1]` and `::1` are one host, as `LocalHost` and `localhost`. */
const bareHost = (host: string) =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")

/** Whether `host` is this machine's loopback: `localhost` (and `*.localhost`), 127.0.0.0/8 or `::1`. */
export const isLoopback = (host: string) => {
  const bare = bareHost(host)
  return (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare) ||
    bare === "::1" ||
    bare === "0:0:0:0:0:0:0:1"
  )
}

/** Whether two hosts are the same machine: equal names, or both loopback (`localhost`, `127.0.0.1`, `::1`). */
export const sameHost = (left: string, right: string) =>
  bareHost(left) === bareHost(right) || (isLoopback(left) && isLoopback(right))

/** The host of a broker URL (`mqtt://localhost:1883` is `localhost`); undefined when it does not parse. */
export const brokerHostOf = (url: string): string | undefined => {
  if (!URL.canParse(url)) return undefined
  const host = bareHost(new URL(url).hostname)
  return host === "" ? undefined : host
}

/**
 * The broker as `sharedCauses` weighs it: its host (from `brokerHostOf`), and when the gateway lost it (the
 * `broker-disconnected` events, id and Unix ms). A broker on the devices' host that went away with them is part of
 * the same cause.
 */
export interface BrokerOutages {
  readonly host: string | undefined
  readonly disconnects: ReadonlyArray<{ readonly id: number; readonly at: number }>
}

/**
 * The time the broker went away with devices that started failing at `first`, when it sits on their `host`: within
 * `SHARED_CAUSE_WINDOW_MS` of the first of them, either way, as a broker drops at once and a device is called failing
 * only after its timeouts. Undefined when it did not, or sits elsewhere.
 */
export const brokerWith = <A extends { readonly at: number }>(
  first: number,
  host: string | undefined,
  brokerHost: string | undefined,
  disconnects: ReadonlyArray<A>
): A | undefined =>
  host === undefined || brokerHost === undefined || !sameHost(host, brokerHost)
    ? undefined
    : disconnects.find((disconnect) => Math.abs(disconnect.at - first) <= SHARED_CAUSE_WINDOW_MS)

/** The one host all of `devices` sit on, by `hostOf`; undefined when one has none or they differ. */
export const commonHost = (
  devices: ReadonlyArray<string>,
  hostOf: (device: string) => string | undefined
): string | undefined => {
  const hosts = new Set(devices.map(hostOf))
  const [host] = hosts
  return hosts.size === 1 ? host : undefined
}

/** A device that stopped answering: the `device-failing` event's id, device and time (Unix ms). */
export interface DeviceFailure {
  readonly id: number
  readonly device: string
  readonly at: number
  /** The driver's words: a failure on the gateway's own side (`gatewaySideFailure`) shares no cause with others. */
  readonly error?: string | undefined
}

/** Failures of two or more devices that began within `SHARED_CAUSE_WINDOW_MS` of the first of them. */
export interface SharedCause {
  /** The failures' event ids, oldest first. */
  readonly ids: ReadonlyArray<number>
  /** Each device once, in the order it failed. */
  readonly devices: ReadonlyArray<string>
  /**
   * `2 devices (boiler, meter) stopped answering within 6 s of each other: …`, or `2 devices (…) and the broker …,
   * all on 127.0.0.1: …` when the broker sits on their host and went away with them.
   */
  readonly line: string
  /** The one host every device of the group sits on, when `hostOf` knows it. */
  readonly host?: string
  /** The `broker-disconnected` event's id, when the broker sits on the devices' host and went away with them. */
  readonly broker?: number
}

/**
 * The shared causes among `failures` (oldest first): consecutive failures within `SHARED_CAUSE_WINDOW_MS` of the
 * first of a group form it, and a group of one device (that failed twice, say) is none. With `hostOf`, a group whose
 * devices all sit on one host says so; with `broker`, a broker on that same host (loopback in every spelling is one
 * host) that went away within the window joins the group's line.
 */
export const sharedCauses = (
  failures: ReadonlyArray<DeviceFailure>,
  hostOf: (device: string) => string | undefined = () => undefined,
  broker?: BrokerOutages
): ReadonlyArray<SharedCause> => {
  const found: Array<SharedCause> = []
  // A port the gateway itself cannot open is its own problem, not one the devices' host or network share.
  const devicesSide = failures.filter((failure) => !gatewaySideFailure(failure.error))
  let index = 0
  while (index < devicesSide.length) {
    const first = devicesSide[index]
    if (first === undefined) break
    let end = index + 1
    while (
      end < devicesSide.length &&
      (devicesSide[end]?.at ?? Number.POSITIVE_INFINITY) - first.at <= SHARED_CAUSE_WINDOW_MS
    )
      end++
    const group = devicesSide.slice(index, end)
    const devices = [...new Set(group.map((failure) => failure.device))]
    if (devices.length >= 2) {
      const host = commonHost(devices, hostOf)
      const lost = brokerWith(first.at, host, broker?.host, broker?.disconnects ?? [])
      const times = [...group.map((failure) => failure.at), ...(lost === undefined ? [] : [lost.at])]
      const spread = Math.max(...times) - Math.min(...times)
      const who = `${devices.length} devices (${firstNames(devices)})${lost === undefined ? "" : " and the broker"}`
      found.push({
        ids: group.map((failure) => failure.id),
        devices,
        line: sharedCauseLine(who, spread, host, devices.length + (lost === undefined ? 0 : 1)),
        ...(host === undefined ? {} : { host }),
        ...(lost === undefined ? {} : { broker: lost.id })
      })
    }
    index = end
  }
  return found
}
