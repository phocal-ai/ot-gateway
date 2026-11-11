"use client"
/**
 * A point's value, lit up for a moment when it changes, so a list shows that data moves without a column of
 * counting seconds. The first value on screen does not light up; hovering says when it last changed. On and off are
 * plain words, as a running compressor is neither good nor bad; an alarm point that is on (lib/glance.ts) is red.
 */
import { useState } from "react"
import { alarmOn, type PointFreshness } from "@/lib/glance"
import type { LastRead } from "@/lib/points"
import { clockTime, formatValue, unitLabel } from "@/lib/status"

export const PointValue = ({
  value,
  unit,
  now,
  alarm = false,
  className = ""
}: {
  readonly value: LastRead | undefined
  readonly unit: string | undefined
  readonly now: number
  /** The point is an alarm: a value that is on shows as one. */
  readonly alarm?: boolean
  readonly className?: string
}) => {
  const [firstTs] = useState(value?.ts)
  const changed = value?.ts !== undefined && value.ts !== firstTs
  const active = alarm && alarmOn(value?.value)
  return (
    <span
      key={value?.ts}
      className={`rounded px-1 ${changed ? "motion-safe:animate-[value-changed_1.2s_ease-out]" : ""} ${active ? "font-semibold text-destructive" : ""} ${className}`}
      title={value?.ts === undefined ? "nothing read yet" : `read ${clockTime(value.ts, now)}`}
    >
      {formatValue(value?.value)} <span className={active ? "" : "text-muted-foreground"}>{unitLabel(unit)}</span>
      {active ? <span className="sr-only"> (alarm)</span> : null}
    </span>
  )
}

/** Said when hovering a COV point's time: why an old time is not a problem. */
export const ON_CHANGE_HINT =
  "Sent by the device when it changes (change of value), so it can stay the same for a long time while the device answers."

/**
 * When a point was read: a clock time, or for a COV point that has not changed for a while, "unchanged since" that
 * time, so it does not look stale next to the polled ones.
 */
export const PointRead = ({
  state,
  now,
  short = false
}: {
  readonly state: PointFreshness
  readonly now: number
  /** For a narrow column: "COV" and the time, the words on hover. */
  readonly short?: boolean
}) => {
  if (state._tag === "none") return <>–</>
  if (state._tag !== "unchanged") return <>{clockTime(state.ts, now)}</>
  return (
    <span title={`Unchanged since ${clockTime(state.ts, now)}. ${ON_CHANGE_HINT}`}>
      {short ? (
        <>
          <span className="mr-1 rounded border px-1 text-[10px] font-medium">COV</span>
          {clockTime(state.ts, now)}
        </>
      ) : (
        `unchanged since ${clockTime(state.ts, now)}`
      )}
    </span>
  )
}
