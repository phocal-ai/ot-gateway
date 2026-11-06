/**
 * The example behind the home page's chart: a supply air temperature read every 30 s for 20 minutes, and what the
 * gateway sends from those reads in each publish mode, as `packages/core/src/Publish.ts` does it: every read; one
 * clock-aligned aggregate per 5 minutes (each read holds until the next, so the average is time-weighted); or the
 * first read and then each that moved at least 0.2 °C from the last one sent.
 */

export interface Reading {
  /** Minutes since the first read. */
  readonly minute: number
  readonly value: number
}

export interface Aggregate {
  readonly from: number
  readonly to: number
  readonly min: number
  readonly max: number
  readonly avg: number
}

export const DEADBAND = 0.2
export const READ_EVERY_SECONDS = 30
export const WINDOW_MINUTES = 5

/** A slow swing with a little sensor noise; deterministic, so the page is the same on every build. */
const temperature = (minute: number) =>
  21 + 0.7 * Math.sin((2 * Math.PI * minute) / 16) + 0.06 * Math.sin(minute * 7.3) + 0.04 * Math.cos(minute * 13.1)

/** Every read, the first at minute 0 and the last at `minutes`. */
export const readings = (minutes = 20): ReadonlyArray<Reading> =>
  Array.from({ length: (minutes * 60) / READ_EVERY_SECONDS + 1 }, (_, index) => {
    const minute = (index * READ_EVERY_SECONDS) / 60
    return { minute, value: Math.round(temperature(minute) * 100) / 100 }
  })

/** The reads change mode sends: the first, then each at least `deadband` from the last one sent. */
export const changes = (data: ReadonlyArray<Reading>, deadband = DEADBAND): ReadonlyArray<Reading> => {
  let lastSent: number | undefined
  return data.filter((reading) => {
    const sent = lastSent === undefined || Math.abs(reading.value - lastSent) >= deadband
    if (sent) lastSent = reading.value
    return sent
  })
}

/** One aggregate per window: minimum and maximum of its reads, and the average weighted by how long each held. */
export const aggregates = (data: ReadonlyArray<Reading>, windowMinutes = WINDOW_MINUTES): ReadonlyArray<Aggregate> => {
  const end = data.at(-1)?.minute ?? 0
  const holdMinutes = READ_EVERY_SECONDS / 60
  const windows: Array<Aggregate> = []
  for (let from = 0; from + windowMinutes <= end; from += windowMinutes) {
    const inWindow = data.filter((reading) => reading.minute >= from && reading.minute < from + windowMinutes)
    const values = inWindow.map((reading) => reading.value)
    const weighted = inWindow.reduce((sum, reading) => sum + reading.value * holdMinutes, 0)
    windows.push({
      from,
      to: from + windowMinutes,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: Math.round((weighted / windowMinutes) * 100) / 100
    })
  }
  return windows
}
