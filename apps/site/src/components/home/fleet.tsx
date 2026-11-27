/**
 * "Your whole fleet, from the broker": `ot-gateway gateways list` in a terminal and the same question asked of an
 * AI agent through MCP (docs/fleet.md). The output follows the command's text format (apps/gateway/src/Fleet.ts),
 * kept short and generic.
 */
import { ArrowRight } from "lucide-react"
import Link from "next/link"
import type * as React from "react"

const Window = ({ title, children }: { readonly title: string; readonly children: React.ReactNode }) => (
  <div className="viz bg-fd-card overflow-hidden rounded-xl border font-mono text-xs shadow-2xl shadow-black/20">
    <div className="flex items-center gap-3 border-b px-3 py-2">
      <span aria-hidden="true" className="flex gap-1.5">
        <span className="bg-fd-border size-2.5 rounded-full" />
        <span className="bg-fd-border size-2.5 rounded-full" />
        <span className="bg-fd-border size-2.5 rounded-full" />
      </span>
      <span className="text-fd-muted-foreground">{title}</span>
    </div>
    <div className="overflow-x-auto p-4 leading-relaxed md:p-5">{children}</div>
  </div>
)

const lines: ReadonlyArray<readonly [string, "good" | "warn" | "bad", string]> = [
  ["site-1/building-a/main", "good", "online      3 devices: 3 ok"],
  ["site-1/building-b/main", "warn", "online      2 devices: 1 ok, 1 failing"],
  ["site-2/plant/main", "bad", "offline     connection-lost"]
]

const width = Math.max(...lines.map(([name]) => name.length))

const tone = {
  good: "text-[var(--status-good)]",
  warn: "text-[var(--series-2)]",
  bad: "text-[var(--status-critical)]"
} as const

export const Fleet = () => (
  <div className="grid gap-6 md:grid-cols-2">
    <Window title="your laptop">
      <p>
        <span className="text-[var(--series-1)]">$</span> ot-gateway gateways list --broker mqtts://broker.example:8883
      </p>
      <p className="text-fd-muted-foreground mt-2">3 gateways on mqtts://broker.example:8883</p>
      <pre className="whitespace-pre">
        {lines.map(([name, state, rest]) => (
          <span className="block" key={name}>
            {"  "}
            {name.padEnd(width)}
            {"  "}
            <span className={tone[state]}>{rest}</span>
          </span>
        ))}
      </pre>
    </Window>
    <Window title="your AI agent · ot-gateway mcp">
      <p>
        <span className="text-[var(--series-1)]">&gt;</span> Which of our gateways need attention?
      </p>
      <p className="text-fd-muted-foreground mt-2">gateways_list · gateways_status site-1/building-b/main</p>
      <p className="mt-2 font-sans text-sm">
        Two of three. On building-b, the heat pump has timed out since 10:41: it connects and does not answer. The plant
        gateway went offline with connection-lost, so its machine or network went away.
      </p>
    </Window>
    <p className="text-fd-muted-foreground text-sm md:col-span-2">
      Every gateway keeps its health and its points' metadata retained on the broker. Read them from any machine with a
      read-only login, or add <code>ot-gateway mcp</code> to your agent.{" "}
      <Link className="text-fd-foreground group inline-flex items-center gap-1 font-medium" href="/docs/fleet">
        See your whole fleet
        <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </p>
  </div>
)
