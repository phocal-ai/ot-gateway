"use client"
/**
 * One point's history: the average as a line, the range of its reads in each bucket as a band behind it, on one
 * axis. Hovering shows a crosshair and the bucket's time, average, range and reads. A gap where the device did not
 * answer breaks the line instead of bridging it.
 */
import type { HistorySeries } from "@ot-gateway/api"
import { useEffect, useRef, useState } from "react"
import { nearest, segments, timeLabel, timeTicks, valueTicks } from "@/lib/history"
import { formatValue, unitLabel } from "@/lib/status"

const HEIGHT = 150
const margin = { top: 8, right: 12, bottom: 22, left: 48 }

/** The element's width, following resizes. */
const useWidth = () => {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

const format = (value: number, boolean: boolean) =>
  boolean ? `${Math.round(value * 100)} % on` : Number(value.toPrecision(4)).toLocaleString()

export const HistoryChart = ({
  series,
  unit,
  boolean,
  label
}: {
  readonly series: HistorySeries
  readonly unit: string | undefined
  readonly boolean: boolean
  readonly label: string
}) => {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | undefined>(undefined)
  const { buckets, stepMs, from, to } = series
  const lows = buckets.map((bucket) => bucket.min)
  const highs = buckets.map((bucket) => bucket.max)
  const ticks = boolean ? [0, 1] : valueTicks(Math.min(...lows), Math.max(...highs))
  const yMin = ticks[0] ?? 0
  const yMax = ticks.at(-1) ?? 1
  const plotWidth = Math.max(0, width - margin.left - margin.right)
  const x = (t: number) => margin.left + ((t + stepMs / 2 - from) / (to - from)) * plotWidth
  const y = (value: number) =>
    margin.top + ((yMax - value) / (yMax - yMin || 1)) * (HEIGHT - margin.top - margin.bottom)
  const time = timeTicks(from, to)
  const runs = segments(buckets, stepMs)
  const hovered = hover === undefined ? undefined : nearest(buckets, hover)
  const units = unitLabel(unit)

  return (
    <div ref={ref} className="relative">
      {buckets.length === 0 ? (
        <p className="flex h-[150px] items-center justify-center text-sm text-muted-foreground">
          No reads in this range yet.
        </p>
      ) : width === 0 ? (
        <div className="h-[150px]" />
      ) : (
        <svg
          aria-label={`${label}: ${buckets.length} buckets, ${format(yMin, boolean)} to ${format(yMax, boolean)}`}
          className="block touch-none select-none"
          height={HEIGHT}
          onPointerLeave={() => setHover(undefined)}
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            const fraction = (event.clientX - box.left - margin.left) / plotWidth
            setHover(fraction < 0 || fraction > 1 ? undefined : from + fraction * (to - from) - stepMs / 2)
          }}
          role="img"
          width={width}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line stroke="var(--border)" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />
              <text
                className="fill-muted-foreground text-[11px] tabular-nums"
                textAnchor="end"
                x={margin.left - 6}
                y={y(tick) + 4}
              >
                {boolean ? (tick === 1 ? "on" : "off") : tick.toLocaleString()}
              </text>
            </g>
          ))}
          {time.ticks.map((tick) => (
            <text
              className="fill-muted-foreground text-[11px] tabular-nums"
              key={tick}
              textAnchor="middle"
              x={margin.left + ((tick - from) / (to - from)) * plotWidth}
              y={HEIGHT - 6}
            >
              {timeLabel(tick, time.step)}
            </text>
          ))}
          {runs.map((run) => {
            const top = run.map((bucket) => `${x(bucket.t)},${y(bucket.max)}`)
            const bottom = run.toReversed().map((bucket) => `${x(bucket.t)},${y(bucket.min)}`)
            // A state holds until the next bucket, so it is drawn as steps; a measurement as a line.
            const line = run.map((bucket, index) =>
              index === 0
                ? `M${x(bucket.t)},${y(bucket.avg)}`
                : boolean
                  ? `H${x(bucket.t)}V${y(bucket.avg)}`
                  : `L${x(bucket.t)},${y(bucket.avg)}`
            )
            return (
              <g key={run[0]?.t}>
                {boolean ? null : (
                  <polygon fill="var(--series-1)" fillOpacity={0.14} points={[...top, ...bottom].join(" ")} />
                )}
                <path
                  d={line.join(" ")}
                  fill="none"
                  stroke="var(--series-1)"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                />
                {run.length === 1 ? (
                  <circle cx={x(run[0]?.t ?? 0)} cy={y(run[0]?.avg ?? 0)} fill="var(--series-1)" r={3} />
                ) : null}
              </g>
            )
          })}
          {hovered === undefined ? null : (
            <g pointerEvents="none">
              <line
                stroke="var(--muted-foreground)"
                strokeDasharray="3 3"
                x1={x(hovered.t)}
                x2={x(hovered.t)}
                y1={margin.top}
                y2={HEIGHT - margin.bottom}
              />
              <circle
                cx={x(hovered.t)}
                cy={y(hovered.avg)}
                fill="var(--series-1)"
                r={4}
                stroke="var(--card)"
                strokeWidth={2}
              />
            </g>
          )}
        </svg>
      )}
      {hovered === undefined ? null : (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border bg-card text-card-foreground px-2.5 py-1.5 text-xs shadow-md"
          style={{
            left: Math.min(Math.max(x(hovered.t) + 10, 0), Math.max(0, width - 170)),
            minWidth: 150
          }}
        >
          <div className="text-muted-foreground tabular-nums">
            {new Date(hovered.t).toLocaleString([], {
              weekday: "short",
              hour: "2-digit",
              minute: "2-digit",
              second: stepMs < 60_000 ? "2-digit" : undefined
            })}
          </div>
          <div className="font-mono tabular-nums">
            {format(hovered.avg, boolean)} {boolean ? "" : units}
          </div>
          {boolean || hovered.count === 1 ? null : (
            <div className="text-muted-foreground tabular-nums">
              {formatValue(Number(hovered.min.toPrecision(4)))} – {formatValue(Number(hovered.max.toPrecision(4)))}{" "}
              {units}
            </div>
          )}
          <div className="text-muted-foreground tabular-nums">
            {hovered.count.toLocaleString()} {hovered.count === 1 ? "read" : "reads"}
          </div>
        </div>
      )}
    </div>
  )
}
