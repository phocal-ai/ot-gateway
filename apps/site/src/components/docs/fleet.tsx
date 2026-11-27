/**
 * The diagram of "See your whole fleet" (docs/fleet.md), in the home page's design: the gateways publish retained
 * health and $meta to the broker, and anything that reaches the broker reads the whole fleet back. It says the same
 * as the Mermaid block it stands for; keep the two in step.
 */
import { Bot, Radio, SquareTerminal, Workflow } from "lucide-react"
import { Eyebrow, Figure } from "./figure.tsx"

type Status = "online" | "failing" | "offline"

const gateways: ReadonlyArray<{ readonly name: string; readonly status: Status; readonly detail: string }> = [
  { name: "site-1/building-a/main", status: "online", detail: "3 devices ok" },
  { name: "site-1/building-b/main", status: "failing", detail: "heat-pump failing: timeout" },
  { name: "site-2/plant/main", status: "offline", detail: "last will: connection-lost" }
]

const dot: Readonly<Record<Status, string>> = {
  online: "bg-[var(--status-good)]",
  failing: "bg-[var(--series-2)]",
  offline: "bg-[var(--status-critical)]"
}

const readers = [
  { icon: SquareTerminal, title: "gateways list", detail: "your laptop, a CI job, a server" },
  { icon: Bot, title: "An AI agent", detail: "gateways_list over MCP" },
  { icon: Workflow, title: "Your own software", detail: "the same topics, by the MQTT contract" }
] as const

/** A vertical connection between two rows, with what travels on it. */
const Pipe = ({ label }: { readonly label: string }) => (
  <div className="flex items-center justify-center gap-3 py-1">
    <div className="bg-fd-border relative h-8 w-px">
      <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--series-1)]" />
    </div>
    <span className="text-fd-muted-foreground font-mono text-[0.65rem]">{label}</span>
  </div>
)

export const FleetMap = () => (
  <Figure label="Gateways publish retained health and metadata to the broker; any machine or agent that reaches it reads the whole fleet">
    <div className="bg-fd-card rounded-xl border p-4">
      <Eyebrow>Your sites</Eyebrow>
      <ul className="mt-3 grid gap-3 sm:grid-cols-3">
        {gateways.map(({ name, status, detail }) => (
          <li className="flex items-start gap-2" key={name}>
            <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-full ${dot[status]}`} />
            <span className="min-w-0 text-sm">
              <span className="font-mono text-[0.75rem]">{name}</span>
              <span className="text-fd-muted-foreground block text-xs">{detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
    <Pipe label="publish, retained" />
    <div className="rounded-xl border-2 border-[var(--series-1)] p-4">
      <Eyebrow>Your MQTT broker: the source of truth, no database or server beside it</Eyebrow>
      <div className="mt-3 flex items-start gap-3">
        <Radio aria-hidden="true" className="text-fd-muted-foreground mt-0.5 size-5 shrink-0" />
        <ul className="grid flex-1 gap-3 text-sm sm:grid-cols-2">
          <li>
            <code className="font-mono text-[0.8rem]">…/$gateway/&lt;id&gt;/health</code>
            <span className="text-fd-muted-foreground block text-xs">online or offline, each device and why</span>
          </li>
          <li>
            <code className="font-mono text-[0.8rem]">…/&lt;point&gt;/$meta</code>
            <span className="text-fd-muted-foreground block text-xs">name, unit, writable, its gateway</span>
          </li>
        </ul>
      </div>
    </div>
    <Pipe label="subscribe, read-only" />
    <div className="bg-fd-card rounded-xl border p-4">
      <Eyebrow>Anywhere that reaches the broker</Eyebrow>
      <ul className="mt-3 grid gap-3 sm:grid-cols-3">
        {readers.map(({ icon: Icon, title, detail }) => (
          <li className="flex items-start gap-2" key={title}>
            <Icon aria-hidden="true" className="text-fd-muted-foreground mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 text-sm">
              {title}
              <span className="text-fd-muted-foreground block text-xs">{detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  </Figure>
)
