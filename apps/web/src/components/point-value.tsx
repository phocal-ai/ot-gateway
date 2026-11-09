"use client"
/**
 * A point's value, lit up for a moment when it changes, so a list shows that data moves without a column of
 * counting seconds. The first value on screen does not light up; hovering says when it last changed.
 */
import { useState } from "react"
import type { LastRead } from "@/lib/points"
import { clockTime, formatValue, unitLabel } from "@/lib/status"

export const PointValue = ({
  value,
  unit,
  now,
  className = ""
}: {
  readonly value: LastRead | undefined
  readonly unit: string | undefined
  readonly now: number
  readonly className?: string
}) => {
  const [firstTs] = useState(value?.ts)
  const changed = value?.ts !== undefined && value.ts !== firstTs
  return (
    <span
      key={value?.ts}
      className={`rounded px-1 ${changed ? "motion-safe:animate-[value-changed_1.2s_ease-out]" : ""} ${className}`}
      title={value?.ts === undefined ? "nothing read yet" : `read ${clockTime(value.ts, now)}`}
    >
      {formatValue(value?.value)} <span className="text-muted-foreground">{unitLabel(unit)}</span>
    </span>
  )
}
