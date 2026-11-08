"use client"
/**
 * Reading and sending are separate: the line is every read, the marks are what the gateway sends in the chosen
 * mode. Hovering a mark names its time and value; the table under it lists the same messages.
 */
import { useState } from "react"
import { aggregates, changes, DEADBAND, READ_EVERY_SECONDS, readings, WINDOW_MINUTES } from "./readings.ts"

const width = 640
const height = 220
const margin = { top: 12, right: 24, bottom: 28, left: 44 }
const yMin = 34
const yMax = 36

const data = readings()
const minutes = data.at(-1)?.minute ?? 1
const windows = aggregates(data)
const changed = changes(data)

const x = (minute: number) => margin.left + (minute / minutes) * (width - margin.left - margin.right)
const y = (value: number) => margin.top + ((yMax - value) / (yMax - yMin)) * (height - margin.top - margin.bottom)

const formatMinute = (minute: number) => `${Math.floor(minute)}:${minute % 1 === 0 ? "00" : "30"}`

const modes = {
  sample: { label: "Every read", sent: "sent: every read", messages: data.length },
  aggregate: {
    label: `${WINDOW_MINUTES}-min aggregate`,
    sent: `sent: min, max and average per ${WINDOW_MINUTES} min`,
    messages: windows.length
  },
  change: { label: "On change", sent: `sent: moved ${DEADBAND} °C or more`, messages: changed.length }
} as const
type Mode = keyof typeof modes
const modeOrder: ReadonlyArray<Mode> = ["sample", "aggregate", "change"]

const Dot = ({ minute, value, title }: { minute: number; value: number; title: string }) => (
  <g>
    <circle
      cx={x(minute)}
      cy={y(value)}
      fill="var(--series-2)"
      r={4.5}
      stroke="var(--color-fd-background)"
      strokeWidth={2}
    />
    <circle cx={x(minute)} cy={y(value)} fill="transparent" r={10}>
      <title>{title}</title>
    </circle>
  </g>
)

export const PublishChart = () => {
  const [mode, setMode] = useState<Mode>("aggregate")
  const path = data
    .map((reading, index) => `${index === 0 ? "M" : "L"}${x(reading.minute)},${y(reading.value)}`)
    .join(" ")
  return (
    <figure className="viz">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <figcaption>
          <span className="font-medium">Heat pump flow temperature, 20 minutes</span>
          <span className="text-fd-muted-foreground ml-2 text-sm">
            {data.length} reads, {modes[mode].messages} messages
          </span>
        </figcaption>
        <div aria-label="Publish mode" className="bg-fd-muted flex rounded-md p-0.5 text-xs" role="radiogroup">
          {modeOrder.map((option) => (
            <button
              aria-checked={mode === option}
              className={`rounded px-2.5 py-1 transition-colors ${mode === option ? "bg-fd-background text-fd-foreground shadow-sm" : "text-fd-muted-foreground hover:text-fd-foreground"}`}
              key={option}
              onClick={() => setMode(option)}
              role="radio"
              type="button"
            >
              {modes[option].label}
            </button>
          ))}
        </div>
      </div>
      <div className="text-fd-muted-foreground mb-2 flex flex-wrap gap-4 text-xs" aria-hidden="true">
        <span className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-4 rounded bg-[var(--series-1)]" /> read every {READ_EVERY_SECONDS} s
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block size-2 rounded-full bg-[var(--series-2)]" /> {modes[mode].sent}
        </span>
      </div>
      <svg
        aria-label={`A temperature read ${data.length} times; ${modes[mode].messages} messages are sent.`}
        className="h-auto w-full"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        {[34, 35, 36].map((tick) => (
          <g key={tick}>
            <line
              stroke="var(--viz-grid)"
              strokeWidth={1}
              x1={margin.left}
              x2={width - margin.right}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text className="fill-fd-muted-foreground text-[11px]" textAnchor="end" x={margin.left - 8} y={y(tick) + 4}>
              {tick} °C
            </text>
          </g>
        ))}
        {[0, 5, 10, 15, 20].map((tick) => (
          <text
            className="fill-fd-muted-foreground text-[11px]"
            key={tick}
            textAnchor="middle"
            x={x(tick)}
            y={height - 8}
          >
            {tick} min
          </text>
        ))}
        {mode === "aggregate" &&
          windows.map((window) => (
            <g key={window.from}>
              <rect
                fill="var(--series-2)"
                fillOpacity={0.16}
                height={Math.max(2, y(window.min) - y(window.max))}
                rx={4}
                width={x(window.to) - x(window.from) - 2}
                x={x(window.from) + 1}
                y={y(window.max)}
              />
              <line
                stroke="var(--series-2)"
                strokeLinecap="round"
                strokeWidth={2}
                x1={x(window.from) + 4}
                x2={x(window.to) - 4}
                y1={y(window.avg)}
                y2={y(window.avg)}
              />
            </g>
          ))}
        <path
          d={path}
          fill="none"
          stroke="var(--series-1)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
        {mode === "sample" &&
          data.map((reading) => (
            <Dot
              key={reading.minute}
              minute={reading.minute}
              title={`${formatMinute(reading.minute)} min: ${reading.value.toFixed(2)} °C`}
              value={reading.value}
            />
          ))}
        {mode === "change" &&
          changed.map((reading) => (
            <Dot
              key={reading.minute}
              minute={reading.minute}
              title={`${formatMinute(reading.minute)} min: ${reading.value.toFixed(2)} °C, moved ${DEADBAND} °C or more`}
              value={reading.value}
            />
          ))}
        {mode === "aggregate" &&
          windows.map((window) => (
            <Dot
              key={window.from}
              minute={window.to}
              title={`${window.from}–${window.to} min: average ${window.avg.toFixed(2)} °C, ${window.min.toFixed(2)} to ${window.max.toFixed(2)}`}
              value={window.avg}
            />
          ))}
      </svg>
      <details className="text-fd-muted-foreground mt-2 text-xs">
        <summary className="cursor-pointer">The messages as a table</summary>
        <table className="mt-2">
          <thead>
            <tr>
              <th className="pr-4 text-left font-medium">Time</th>
              <th className="pr-4 text-left font-medium">{mode === "aggregate" ? "Average" : "Value"}</th>
              {mode === "aggregate" && <th className="text-left font-medium">Min – max</th>}
            </tr>
          </thead>
          <tbody>
            {mode === "aggregate"
              ? windows.map((window) => (
                  <tr key={window.from}>
                    <td className="pr-4">
                      {window.from}–{window.to} min
                    </td>
                    <td className="pr-4">{window.avg.toFixed(2)} °C</td>
                    <td>
                      {window.min.toFixed(2)} – {window.max.toFixed(2)} °C
                    </td>
                  </tr>
                ))
              : (mode === "sample" ? data : changed).map((reading) => (
                  <tr key={reading.minute}>
                    <td className="pr-4">{formatMinute(reading.minute)}</td>
                    <td className="pr-4">{reading.value.toFixed(2)} °C</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}
