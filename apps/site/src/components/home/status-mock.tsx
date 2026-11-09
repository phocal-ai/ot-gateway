"use client"
/**
 * The gateway's status page (apps/web) in a browser window, as HTML: the same header, overview cards and device
 * cards, on the site's own theme. One device is unreachable, so the picture shows what the page is for; the other
 * values move every few seconds and light up when they change, as on the real page.
 */
import type * as React from "react"
import { useEffect, useState } from "react"

type Point = { readonly id: string; readonly value: number; readonly decimals: number; readonly unit: string }

type Device = {
  readonly id: string
  readonly protocol: string
  readonly line: string
  readonly failing?: string
  readonly points: ReadonlyArray<Point>
}

const devices: ReadonlyArray<Device> = [
  {
    id: "pv-inverter",
    protocol: "Modbus TCP",
    line: "read every 5 s",
    points: [
      { id: "ac-power", value: 5.8, decimals: 1, unit: "kW" },
      { id: "energy-today", value: 23.4, decimals: 1, unit: "kWh" }
    ]
  },
  {
    id: "energy-meter",
    protocol: "Modbus TCP",
    line: "read every 5 s",
    points: [
      { id: "active-power", value: 32.7, decimals: 1, unit: "kW" },
      { id: "energy", value: 22343, decimals: 0, unit: "kWh" }
    ]
  },
  {
    id: "heat-pump",
    protocol: "BACnet/IP",
    line: "read every 30 s · no answer for 4 min",
    failing: "timeout",
    points: [
      { id: "flow-temp", value: 35.2, decimals: 1, unit: "°C" },
      { id: "return-temp", value: 30.1, decimals: 1, unit: "°C" }
    ]
  }
]

/** How far each live value may wander from its start, so the numbers stay believable. */
const wander: Readonly<Record<string, number>> = {
  "ac-power": 0.4,
  "energy-today": 0,
  "flow-temp": 0.4,
  "return-temp": 0.3,
  "active-power": 2.5,
  energy: 0
}

const TICK_MS = 3000

/** Every tick, one live point gets a new value; `tick` keys the flash so it replays. */
const useLiveValues = () => {
  const [tick, setTick] = useState(0)
  const [values, setValues] = useState<Readonly<Record<string, number>>>({})
  const [changed, setChanged] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const live = devices.filter((device) => device.failing === undefined)
    const timer = setInterval(() => {
      setTick((previous) => {
        const next = previous + 1
        const device = live[next % live.length]
        if (device === undefined) return next
        const point = device.points[Math.floor(next / live.length) % device.points.length]
        if (point === undefined) return next
        const key = `${device.id}/${point.id}`
        const range = wander[point.id] ?? 0
        setValues((current) => ({
          ...current,
          [key]:
            point.id === "energy" ? (current[key] ?? point.value) + 1 : point.value + (Math.random() * 2 - 1) * range
        }))
        setChanged(key)
        return next
      })
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [])

  return { tick, values, changed }
}

const Card = ({ children, className = "" }: { readonly children: React.ReactNode; readonly className?: string }) => (
  <div className={`bg-fd-card rounded-lg border p-3 ${className}`}>{children}</div>
)

const Badge = ({ failing }: { readonly failing: string | undefined }) =>
  failing === undefined ? (
    <span className="rounded-md bg-[var(--status-good)] px-1.5 py-0.5 text-[0.65rem] leading-none font-medium text-white">
      ok
    </span>
  ) : (
    <span className="rounded-md bg-[var(--status-critical)] px-1.5 py-0.5 text-[0.65rem] leading-none font-medium text-white">
      {failing}
    </span>
  )

const Overview = ({
  label,
  value,
  note,
  bad = false
}: {
  readonly label: string
  readonly value: string
  readonly note: string
  readonly bad?: boolean
}) => (
  <Card>
    <p className="text-fd-muted-foreground text-[0.7rem]">{label}</p>
    <p className="mt-0.5 text-base font-semibold tabular-nums">{value}</p>
    <p
      className={`mt-0.5 truncate text-[0.7rem] ${bad ? "text-[var(--status-critical)]" : "text-fd-muted-foreground"}`}
    >
      {note}
    </p>
  </Card>
)

export const StatusMock = () => {
  const { tick, values, changed } = useLiveValues()

  return (
    <div className="viz bg-fd-background overflow-hidden rounded-xl border shadow-2xl shadow-black/20">
      <div className="bg-fd-card flex items-center gap-3 border-b px-3 py-2">
        <span aria-hidden="true" className="flex gap-1.5">
          <span className="bg-fd-border size-2.5 rounded-full" />
          <span className="bg-fd-border size-2.5 rounded-full" />
          <span className="bg-fd-border size-2.5 rounded-full" />
        </span>
        <span className="bg-fd-background text-fd-muted-foreground mx-auto rounded-md border px-3 py-0.5 font-mono text-[0.7rem]">
          127.0.0.1:8080
        </span>
        <span aria-hidden="true" className="w-[2.75rem]" />
      </div>

      <div aria-label="The gateway's status page" className="p-4 text-xs md:p-5" role="img">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">OT Gateway</p>
            <p className="text-fd-muted-foreground text-[0.7rem]">site-1 / building-a · gateway main · up 12 days</p>
          </div>
          <span className="flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[0.7rem] font-medium">
            <span className="size-1.5 animate-pulse rounded-full bg-[var(--status-good)]" /> Live
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2 md:gap-3">
          <Overview label="Broker" note="to mqtt://broker.example.com" value="connected" />
          <Overview bad label="Devices" note="answering, 1 failing" value="2/3" />
          <Overview label="Buffer" note="holds up to 1,000,000 offline" value="0 waiting" />
        </div>

        <div className="mt-2 grid gap-2 sm:grid-cols-3 md:mt-3 md:gap-3">
          {devices.map((device) => (
            <Card className={device.failing === undefined ? "" : "border-[var(--status-critical)]/40"} key={device.id}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[0.8rem] font-semibold">{device.id}</span>
                <Badge failing={device.failing} />
              </div>
              <p className="text-fd-muted-foreground mt-1 text-[0.7rem]">
                {device.protocol} · {device.line}
              </p>
              <dl className="mt-2.5 border-t">
                {device.points.map((point) => {
                  const key = `${device.id}/${point.id}`
                  const value = values[key] ?? point.value
                  return (
                    <div className="flex items-center justify-between gap-2 border-b py-1.5 last:border-b-0" key={key}>
                      <dt
                        className={`truncate text-[0.7rem] ${device.failing === undefined ? "" : "text-fd-muted-foreground"}`}
                      >
                        {point.id}
                      </dt>
                      <dd
                        className={`-mr-1 rounded px-1 font-mono text-[0.7rem] whitespace-nowrap tabular-nums ${
                          device.failing === undefined ? "" : "text-fd-muted-foreground"
                        } ${changed === key ? "value-tick" : ""}`}
                        key={changed === key ? `${key}-${tick}` : key}
                      >
                        {value.toLocaleString("en-US", {
                          maximumFractionDigits: point.decimals,
                          minimumFractionDigits: point.decimals
                        })}{" "}
                        <span className="text-fd-muted-foreground">{point.unit}</span>
                      </dd>
                    </div>
                  )
                })}
              </dl>
              {device.failing === undefined ? null : (
                <p className="text-fd-muted-foreground mt-1.5 text-[0.65rem]">last read 4 min ago</p>
              )}
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
