/**
 * What a deadband does, for people who have never heard the word: the line is every read, the dots are the
 * reads the gateway sends. Hovering a read names its time and value, and whether it was sent.
 */
import { DEADBAND, READ_EVERY_SECONDS, readings } from "./readings.ts"

const width = 640
const height = 220
const margin = { top: 12, right: 24, bottom: 28, left: 44 }
const yMin = 20
const yMax = 22

const x = (minute: number, minutes: number) => margin.left + (minute / minutes) * (width - margin.left - margin.right)
const y = (value: number) => margin.top + ((yMax - value) / (yMax - yMin)) * (height - margin.top - margin.bottom)

const formatMinute = (minute: number) => `${Math.floor(minute)}:${minute % 1 === 0 ? "00" : "30"}`

export const DeadbandChart = () => {
  const data = readings()
  const minutes = data.at(-1)?.minute ?? 1
  const sent = data.filter((reading) => reading.sent)
  const path = data
    .map((reading, index) => `${index === 0 ? "M" : "L"}${x(reading.minute, minutes)},${y(reading.value)}`)
    .join(" ")
  return (
    <figure className="viz">
      <figcaption className="mb-3">
        <span className="font-medium">Supply air temperature, 20 minutes</span>
        <span className="text-fd-muted-foreground ml-2 text-sm">
          {data.length} reads, {sent.length} messages
        </span>
      </figcaption>
      <div className="text-fd-muted-foreground mb-2 flex flex-wrap gap-4 text-xs" aria-hidden="true">
        <span className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-4 rounded bg-[var(--series-1)]" /> read every {READ_EVERY_SECONDS} s
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block size-2 rounded-full bg-[var(--series-2)]" /> sent: moved {DEADBAND} °C or more
        </span>
      </div>
      <svg
        aria-label={`A temperature read ${data.length} times; ${sent.length} of the reads are sent.`}
        className="h-auto w-full"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        {[20, 21, 22].map((tick) => (
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
            x={x(tick, minutes)}
            y={height - 8}
          >
            {tick} min
          </text>
        ))}
        <path
          d={path}
          fill="none"
          stroke="var(--series-1)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
        {sent.map((reading) => (
          <circle
            cx={x(reading.minute, minutes)}
            cy={y(reading.value)}
            fill="var(--series-2)"
            key={reading.minute}
            r={4.5}
            stroke="var(--color-fd-background)"
            strokeWidth={2}
          />
        ))}
        {data.map((reading) => (
          <circle cx={x(reading.minute, minutes)} cy={y(reading.value)} fill="transparent" key={reading.minute} r={10}>
            <title>
              {`${formatMinute(reading.minute)} min: ${reading.value.toFixed(2)} °C, ${reading.sent ? "sent" : "not sent (less than 0.2 °C change)"}`}
            </title>
          </circle>
        ))}
      </svg>
      <details className="text-fd-muted-foreground mt-2 text-xs">
        <summary className="cursor-pointer">The reads as a table</summary>
        <table className="mt-2">
          <thead>
            <tr>
              <th className="pr-4 text-left font-medium">Time</th>
              <th className="pr-4 text-left font-medium">Value</th>
              <th className="text-left font-medium">Sent</th>
            </tr>
          </thead>
          <tbody>
            {data.map((reading) => (
              <tr key={reading.minute}>
                <td className="pr-4">{formatMinute(reading.minute)}</td>
                <td className="pr-4">{reading.value.toFixed(2)} °C</td>
                <td>{reading.sent ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}
