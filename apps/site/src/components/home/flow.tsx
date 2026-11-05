/**
 * The home page's picture of what the gateway does: devices in the building on the left, the gateway in the
 * middle, the software that wants the data on the right, with messages moving along the pipes between them.
 */
import { Bell, ChartLine, Fan, FileChartColumn, Gauge, Thermometer } from "lucide-react"
import type * as React from "react"

interface Item {
  readonly icon: React.ComponentType<{ readonly className?: string }>
  readonly title: string
  readonly detail: string
}

const devices: ReadonlyArray<Item> = [
  { icon: Gauge, title: "Energy meter", detail: "Modbus TCP" },
  { icon: Fan, title: "Air handlers", detail: "BACnet/IP" },
  { icon: Thermometer, title: "Room sensors", detail: "BACnet/IP" }
]

const software: ReadonlyArray<Item> = [
  { icon: ChartLine, title: "Dashboards", detail: "live values" },
  { icon: FileChartColumn, title: "Energy reports", detail: "kWh per month" },
  { icon: Bell, title: "Alerts", detail: "a fan stopped" }
]

const Column = ({ title, items }: { readonly title: string; readonly items: ReadonlyArray<Item> }) => (
  <div className="bg-fd-card rounded-xl border p-4">
    <p className="text-fd-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">{title}</p>
    <ul className="space-y-3">
      {items.map(({ icon: Icon, title: itemTitle, detail }) => (
        <li className="flex items-center gap-3" key={itemTitle}>
          <Icon className="text-fd-muted-foreground size-5 shrink-0" />
          <span className="text-sm">
            {itemTitle} <span className="text-fd-muted-foreground">· {detail}</span>
          </span>
        </li>
      ))}
    </ul>
  </div>
)

/** A pipe with messages moving along it, and what travels on it. */
const Pipe = ({ label }: { readonly label: string }) => (
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
  </div>
)

export const Flow = () => (
  <div className="viz grid items-center md:grid-cols-[1fr_auto_1fr_auto_1fr]">
    <Column items={devices} title="In the building" />
    <Pipe label="read every few seconds" />
    <div className="rounded-xl border-2 border-[var(--series-1)] p-4">
      <p className="mb-3 text-sm font-semibold">OT Gateway</p>
      <ul className="text-fd-muted-foreground space-y-2 text-sm">
        <li>asks each device on schedule</li>
        <li>adds names and units</li>
        <li>sends only real changes</li>
        <li>keeps values while offline</li>
      </ul>
    </div>
    <Pipe label="MQTT" />
    <Column items={software} title="Your software" />
  </div>
)
