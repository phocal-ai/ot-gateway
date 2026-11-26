/**
 * The diagrams of "What the gateway needs from you" (docs/inputs.md), in the home page's design. Each one says the
 * same as the Mermaid block it stands for; keep the two in step.
 */
import { ArrowDown, ArrowRight, Radio, Rows3, Send } from "lucide-react"
import type * as React from "react"
import { Eyebrow, Figure } from "./figure.tsx"

/** A name the user chose that becomes a part of the topic; highlighted the same way wherever it shows. */
const Name = ({ children }: { readonly children: string }) => (
  <span className="font-mono text-[var(--series-1)]">{children}</span>
)

/** An arrow from one card to the next: across on wide screens, down on narrow ones. */
const Arrow = ({ label }: { readonly label?: string }) => (
  <div
    aria-hidden="true"
    className="text-fd-muted-foreground flex items-center justify-center gap-1 py-2 text-xs lg:px-2 lg:py-0"
  >
    {label === undefined ? null : <span>{label}</span>}
    <ArrowRight className="size-4 max-lg:hidden" />
    <ArrowDown className="size-4 lg:hidden" />
  </div>
)

/* The three inputs */

const inputs: ReadonlyArray<{
  readonly icon: React.ComponentType<{ readonly className?: string }>
  readonly title: string
  readonly example: React.ReactNode
  readonly note: string
}> = [
  {
    icon: Radio,
    title: "Where the values go",
    example: (
      <>
        <Name>site-1</Name>, <Name>building-a</Name>, <span className="font-mono">mqtts://broker…</span>
      </>
    ),
    note: "a site, a building and your broker, given once"
  },
  {
    icon: Rows3,
    title: "What to read",
    example: <span className="font-mono">points.json</span>,
    note: "the points list: one row per value"
  },
  {
    icon: Send,
    title: "How to send it",
    example: <span className="font-mono">every 5 s, every read</span>,
    note: "optional: change it per value"
  }
]

export const InputsOverview = () => (
  <Figure label="The three things you give the gateway, and what comes out">
    <div className="grid items-center lg:grid-cols-[1.4fr_auto_auto_auto_1fr]">
      <ol className="space-y-3">
        {inputs.map(({ icon: Icon, title, example, note }, index) => (
          <li
            className="bg-fd-card grid grid-cols-[1.5rem_1fr_auto] items-start gap-x-3 rounded-xl border p-4"
            key={title}
          >
            <span className="flex size-6 items-center justify-center rounded-full border-2 border-[var(--series-1)] text-xs font-semibold">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{title}</p>
              <p className="mt-1 text-xs break-words">{example}</p>
              <p className="text-fd-muted-foreground mt-0.5 text-xs">{note}</p>
            </div>
            <Icon className="text-fd-muted-foreground size-5" />
          </li>
        ))}
      </ol>
      <Arrow />
      <div className="rounded-xl border-2 border-[var(--series-1)] p-4 text-center">
        <p className="text-sm font-semibold whitespace-nowrap">OT Gateway</p>
        <p className="text-fd-muted-foreground mt-1 text-xs">reads, sends</p>
      </div>
      <Arrow />
      <div className="bg-fd-card rounded-xl border p-4">
        <Eyebrow>Your MQTT broker</Eyebrow>
        <p className="mt-3 text-sm">One topic and one message per value</p>
        <p className="mt-2 font-mono text-xs break-all">
          <Name>site-1</Name>/<Name>building-a</Name>/…
        </p>
      </div>
    </div>
  </Figure>
)

/* One row becomes one topic and its messages */

const rowLines: ReadonlyArray<readonly [string, React.ReactNode, string]> = [
  ["device", <Name key="device">Main meter</Name>, "the name you choose"],
  ["point", <Name key="point">Active power</Name>, "the name you choose"],
  ["unit", "kW", "what the number means"],
  ["host", "192.168.1.50", "where the device is"],
  ["register", "100", "which value inside it"],
  ["type", "float32", "how the number is stored"]
]

export const InputsRow = () => (
  <Figure label="One row of the points list becomes one topic, a value message and a metadata message">
    <div className="grid items-stretch lg:grid-cols-[1fr_auto_1.3fr]">
      <div className="bg-fd-card rounded-xl border p-4">
        <Eyebrow>One row of the points list</Eyebrow>
        <dl className="mt-3 grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          {rowLines.map(([key, value, note]) => (
            <div className="contents" key={key}>
              <dt className="text-fd-muted-foreground font-mono">{key}</dt>
              <dd className="font-mono">{value}</dd>
              <dd className="text-fd-muted-foreground max-sm:hidden">{note}</dd>
            </div>
          ))}
        </dl>
      </div>
      <Arrow label="becomes" />
      <div className="bg-fd-card rounded-xl border">
        <div className="p-4">
          <Eyebrow>The topic</Eyebrow>
          <p className="mt-2 font-mono text-xs break-all">
            <span className="text-fd-muted-foreground">site-1/building-a/</span>
            <Name>main-meter</Name>/<Name>active-power</Name>
          </p>
          <p className="text-fd-muted-foreground mt-1 text-xs">site / building / device / point</p>
        </div>
        <div className="border-t p-4">
          <Eyebrow>On it, every read</Eyebrow>
          <p className="mt-2 font-mono text-xs [overflow-wrap:anywhere]">
            {'{ "value": 12.4, "ts": 1764075600000, "unit": "unit:KiloW" }'}
          </p>
        </div>
        <div className="border-t p-4">
          <Eyebrow>
            On <span className="font-mono normal-case">…/$meta</span>, once, kept by the broker
          </Eyebrow>
          <p className="mt-2 font-mono text-xs [overflow-wrap:anywhere]">
            {'{ "name": "Active power", "unit": "unit:KiloW", "writable": false }'}
          </p>
        </div>
      </div>
    </div>
  </Figure>
)
