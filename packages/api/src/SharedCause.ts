/**
 * Several devices that stop answering within seconds of each other point at one cause (power, a switch, the
 * gateway's own network), not at each device. `ot-gateway status`, `ot-gateway events` and the status page's events
 * say so in the same words, from these pure functions.
 */

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
}

/** Failures of two or more devices that began within `SHARED_CAUSE_WINDOW_MS` of the first of them. */
export interface SharedCause {
  /** The failures' event ids, oldest first. */
  readonly ids: ReadonlyArray<number>
  /** Each device once, in the order it failed. */
  readonly devices: ReadonlyArray<string>
  /** `2 devices (boiler, meter) stopped answering within 6 s of each other: …`. */
  readonly line: string
  /** The one host every device of the group sits on, when `hostOf` knows it. */
  readonly host?: string
}

/**
 * The shared causes among `failures` (oldest first): consecutive failures within `SHARED_CAUSE_WINDOW_MS` of the
 * first of a group form it, and a group of one device (that failed twice, say) is none. With `hostOf`, a group whose
 * devices all sit on one host says so.
 */
export const sharedCauses = (
  failures: ReadonlyArray<DeviceFailure>,
  hostOf: (device: string) => string | undefined = () => undefined
): ReadonlyArray<SharedCause> => {
  const found: Array<SharedCause> = []
  let index = 0
  while (index < failures.length) {
    const first = failures[index]
    if (first === undefined) break
    let end = index + 1
    while (
      end < failures.length &&
      (failures[end]?.at ?? Number.POSITIVE_INFINITY) - first.at <= SHARED_CAUSE_WINDOW_MS
    )
      end++
    const group = failures.slice(index, end)
    const devices = [...new Set(group.map((failure) => failure.device))]
    if (devices.length >= 2) {
      const spread = (group.at(-1)?.at ?? first.at) - first.at
      const host = commonHost(devices, hostOf)
      found.push({
        ids: group.map((failure) => failure.id),
        devices,
        line: sharedCauseLine(`${devices.length} devices (${devices.join(", ")})`, spread, host, devices.length),
        ...(host === undefined ? {} : { host })
      })
    }
    index = end
  }
  return found
}
