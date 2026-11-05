/**
 * The example behind the home page's chart: a supply air temperature read every 30 s for 20 minutes, and
 * which of those reads the gateway sends with a 0.2 °C deadband (the first, then each that moved at least
 * that far from the last one sent), as `Normalize.ts` does it.
 */

export interface Reading {
  /** Minutes since the first read. */
  readonly minute: number
  readonly value: number
  readonly sent: boolean
}

export const DEADBAND = 0.2
export const READ_EVERY_SECONDS = 30

/** A slow swing with a little sensor noise; deterministic, so the page is the same on every build. */
const temperature = (minute: number) =>
  21 + 0.7 * Math.sin((2 * Math.PI * minute) / 16) + 0.06 * Math.sin(minute * 7.3) + 0.04 * Math.cos(minute * 13.1)

/** The reads and which were sent. */
export const readings = (minutes = 20, deadband = DEADBAND): ReadonlyArray<Reading> => {
  const count = (minutes * 60) / READ_EVERY_SECONDS + 1
  let lastSent: number | undefined
  return Array.from({ length: count }, (_, index) => {
    const minute = (index * READ_EVERY_SECONDS) / 60
    const value = Math.round(temperature(minute) * 100) / 100
    const sent = lastSent === undefined || Math.abs(value - lastSent) >= deadband
    if (sent) lastSent = value
    return { minute, value, sent }
  })
}
