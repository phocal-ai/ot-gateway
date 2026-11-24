/**
 * The guided first run on the Status tab, as pure functions: which of its three steps (the broker, the devices, the
 * first values) are done, which one is next, and whether the guide shows at all. It leads while the config has no
 * devices, and stays on top of the overview after the first device is saved, until the values arrive and someone
 * closes it. Whether it was started is remembered in the browser only (a convenience, never needed to be correct).
 */
import type { GatewayStatus, PointInfo, PointReading } from "@ot-gateway/api"

/** The browser storage key that says the guide was started on this gateway's page. */
export const FIRST_RUN_KEY = "ot-gateway.first-run"

/** The values the third step shows arriving: the first few points of the config. */
export const FIRST_VALUES = 6

export interface FirstRunView {
  readonly broker: boolean
  readonly devices: boolean
  /** Points with a value, of the ones shown. */
  readonly arrived: number
  /** Every device has answered at least once. */
  readonly answered: boolean
  /** The step to do next, or `done` once values arrived from every device. */
  readonly next: 1 | 2 | 3 | "done"
}

export const firstRunView = (
  status: GatewayStatus,
  readings: ReadonlyMap<string, PointReading>,
  shown: ReadonlyArray<PointInfo>
): FirstRunView => {
  const broker = status.broker.connected
  const devices = status.devices.length > 0
  const arrived = shown.filter((point) => readings.get(`${point.device}/${point.id}`)?.value !== undefined).length
  const answered = devices && status.devices.every((device) => device.lastSuccess !== undefined)
  const next = !broker ? 1 : !devices ? 2 : answered && arrived > 0 ? "done" : 3
  return { broker, devices, arrived, answered, next }
}

/** Whether the guide shows: always without devices, and after that while it was started and not closed. */
export const showsGuide = (deviceCount: number, started: boolean) => deviceCount === 0 || started

/** The points the third step shows: the first few of the config. */
export const firstValuePoints = (points: ReadonlyArray<PointInfo>) => points.slice(0, FIRST_VALUES)

const storage = () => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** Whether the guide was started here; false when the browser keeps nothing. */
export const guideStarted = () => {
  try {
    return storage()?.getItem(FIRST_RUN_KEY) === "1"
  } catch {
    return false
  }
}

export const rememberGuide = (started: boolean) => {
  try {
    if (started) storage()?.setItem(FIRST_RUN_KEY, "1")
    else storage()?.removeItem(FIRST_RUN_KEY)
  } catch {
    // A browser that keeps nothing shows the guide only while there are no devices.
  }
}
