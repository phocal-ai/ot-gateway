/**
 * The home page's picture of what the gateway does: devices on site on the left, the gateway in the
 * middle, the software that wants the data on the right, with messages moving along the pipes between them.
 */
import { Bell, BrainCircuit, ChartLine, FileChartColumn, Gauge, Heater, SunMedium } from "lucide-react"
import type * as React from "react"

interface Item {
  readonly icon: React.ComponentType<{ readonly className?: string }>
  readonly title: string
  readonly detail: string
}

const devices: ReadonlyArray<Item> = [
  { icon: Gauge, title: "Energy meter", detail: "Modbus TCP" },
  { icon: SunMedium, title: "PV inverter", detail: "Modbus TCP" },
  { icon: Heater, title: "Heat pump", detail: "BACnet/IP" }
]

const software: ReadonlyArray<Item> = [
  { icon: ChartLine, title: "Dashboards", detail: "live values" },
  { icon: FileChartColumn, title: "Energy reports", detail: "kWh a month" },
  { icon: Bell, title: "Alerts", detail: "a compressor stopped" },
  { icon: BrainCircuit, title: "Analytics", detail: "AI, digital twins" }
]

const Column = ({
  title,
  note,
  items
}: {
  readonly title: string
  /** A line under the title, saying what the items are. */
  readonly note?: string
  readonly items: ReadonlyArray<Item>
}) => (
  <div className="bg-fd-card rounded-xl border p-4">
    <p className="text-fd-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</p>
    {note === undefined ? (
      <div className="mb-3" />
    ) : (
      <p className="text-fd-muted-foreground mt-1 mb-3 text-xs">{note}</p>
    )}
    <ul className="space-y-3">
      {items.map(({ icon: Icon, title: itemTitle, detail }) => (
        <li className="flex items-center gap-3" key={itemTitle}>
          <Icon className="text-fd-muted-foreground size-5 shrink-0" />
          <span className="text-sm md:whitespace-nowrap">
            {itemTitle} <span className="text-fd-muted-foreground">· {detail}</span>
          </span>
        </li>
      ))}
    </ul>
  </div>
)

/** A pipe with messages moving along it, what travels on it and, under it, an optional note in code. */
const Pipe = ({ label, note }: { readonly label: string; readonly note?: string }) => (
  <div className="flex flex-col items-center justify-center gap-2 py-2 md:px-2 md:py-0">
    <span className="text-fd-muted-foreground text-xs">{label}</span>
    <div className="bg-fd-border relative h-12 w-px md:h-px md:w-20">
      {[0, 0.8, 1.6].map((delay) => (
        <span
          className="flow-dot absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--series-1)] max-md:left-1/2 md:top-1/2"
          key={delay}
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </div>
    {/* Without a note, an invisible one keeps both pipes level with the boxes. */}
    <code
      aria-hidden={note === undefined ? "true" : undefined}
      className={`text-fd-muted-foreground text-center text-[0.65rem] leading-tight whitespace-pre ${note === undefined ? "invisible max-md:hidden" : ""}`}
    >
      {note ?? " \n "}
    </code>
  </div>
)

export const Flow = () => (
  <div className="viz grid items-center md:grid-cols-[1fr_auto_1fr_auto_1fr]">
    <Column items={devices} title="On site" />
    <Pipe label="polls" />
    <div className="rounded-xl border-2 border-[var(--series-1)] p-4">
      <p className="mb-3 text-sm font-semibold whitespace-nowrap">OT Gateway</p>
      <ul className="text-fd-muted-foreground space-y-2 text-sm md:whitespace-nowrap">
        <li>collects data from devices</li>
        <li>aggregates or sends changes</li>
        <li>buffers while offline</li>
        <li>shows status, history and telemetry</li>
      </ul>
    </div>
    <Pipe label="publishes" note={"site/building/\ndevice/point"} />
    <Column items={software} note="for whatever subscribes:" title="Your MQTT broker" />
  </div>
)
