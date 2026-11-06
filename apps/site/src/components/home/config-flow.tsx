/**
 * The home page's "config in, MQTT out": one datapoint's config as plain settings, the gateway reading it every
 * 30 seconds through a 15-minute window, and the one message that window becomes, as a readable card. The same
 * config and message as JSON are one click away (`exampleConfig`, `exampleMessage` on the page, which
 * `ot-gateway check` and the pipeline's aggregate format back).
 */
import { ArrowRight, Fan } from "lucide-react"
import type * as React from "react"

/** Reads in one 15-minute window at one every 30 s. */
const READS = 30

const Setting = ({ label, children }: { readonly label: string; readonly children: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 border-b py-2 last:border-b-0">
    <dt className="text-fd-muted-foreground text-xs">{label}</dt>
    <dd className="text-right text-sm font-medium">{children}</dd>
  </div>
)

const Card = ({ title, children }: { readonly title: string; readonly children: React.ReactNode }) => (
  <div className="bg-fd-card h-full rounded-xl border p-4">
    <p className="text-fd-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">{title}</p>
    {children}
  </div>
)

const Arrow = () => (
  <div className="text-fd-muted-foreground flex items-center justify-center py-2 md:px-1 md:py-0">
    <ArrowRight aria-hidden="true" className="size-5 max-md:rotate-90" />
  </div>
)

export const ConfigFlow = () => (
  <div className="viz grid items-stretch md:grid-cols-[1fr_auto_1.1fr_auto_1fr]">
    <Card title="You set">
      <dl>
        <Setting label="Device">
          <span className="inline-flex items-center gap-1.5">
            <Fan aria-hidden="true" className="text-fd-muted-foreground size-4" /> Air handler ahu-1
          </span>
        </Setting>
        <Setting label="Datapoint">Supply air temperature, °C</Setting>
        <Setting label="Poll">every 30 s</Setting>
        <Setting label="Send">15-minute average</Setting>
      </dl>
    </Card>
    <Arrow />
    <div className="flex h-full flex-col justify-center rounded-xl border-2 border-[var(--series-1)] p-4">
      <p className="mb-1 text-sm font-semibold">OT Gateway</p>
      <p className="text-fd-muted-foreground mb-4 text-xs">reads 30 times, sends once</p>
      <div aria-hidden="true" className="flex h-10 items-end gap-[3px]">
        {Array.from({ length: READS }, (_, index) => (
          <span
            className="read-tick w-full rounded-sm bg-[var(--series-1)]"
            key={index}
            style={{
              animationDelay: `${(index * 0.12).toFixed(2)}s`,
              height: `${45 + 35 * Math.sin(index / 4.5) ** 2}%`
            }}
          />
        ))}
      </div>
      <div className="text-fd-muted-foreground mt-2 flex justify-between text-[11px] tabular-nums">
        <span>10:00</span>
        <span>10:15</span>
      </div>
    </div>
    <Arrow />
    <Card title="Your broker receives">
      <p className="text-fd-muted-foreground mb-3 font-mono text-[11px] break-all">
        vienna-hq/main/ahu-1/supply-air-temp
      </p>
      <p className="text-3xl font-semibold tabular-nums">
        21.4 <span className="text-fd-muted-foreground text-base font-normal">°C</span>
      </p>
      <p className="text-fd-muted-foreground mb-3 text-xs">average, 10:00 to 10:15</p>
      <dl className="grid grid-cols-3 gap-2 text-center">
        {[
          ["min", "20.9"],
          ["max", "21.8"],
          ["reads", "30"]
        ].map(([label, value]) => (
          <div className="bg-fd-background rounded-md border py-1.5" key={label}>
            <dd className="text-sm font-medium tabular-nums">{value}</dd>
            <dt className="text-fd-muted-foreground text-[11px]">{label}</dt>
          </div>
        ))}
      </dl>
    </Card>
  </div>
)
