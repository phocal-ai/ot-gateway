/**
 * Two ways to set up a gateway, side by side: by hand with the CLI, or with an AI assistant running `/setup`
 * (`.claude/skills/setup/SKILL.md`). What goes in, what you do, and what comes out, which is the same either way.
 * Every step listed is one the CLI or the skill really does.
 */
import { Sparkles, Terminal } from "lucide-react"
import type * as React from "react"

interface Way {
  readonly icon: React.ComponentType<{ readonly className?: string }>
  readonly title: string
  readonly input: string
  readonly steps: ReadonlyArray<string>
  readonly highlight: boolean
}

const ways: ReadonlyArray<Way> = [
  {
    icon: Terminal,
    title: "By hand",
    input: "Device addresses, BACnet objects or Modbus registers, scaling and units for every datapoint",
    steps: [
      "ot-gateway discover finds BACnet devices",
      "type Modbus registers from the datasheet",
      "ot-gateway check until the config is valid",
      "run it and watch the broker"
    ],
    highlight: false
  },
  {
    icon: Sparkles,
    title: "With your AI assistant",
    input: "What you need, in your own words, and the datasheet",
    steps: [
      "it discovers the devices",
      "it reads the registers from the datasheet",
      "it writes and checks the config",
      "it runs the gateway until values arrive"
    ],
    highlight: true
  }
]

const Row = ({ label, children }: { readonly label: string; readonly children: React.ReactNode }) => (
  <div>
    <p className="text-fd-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">{label}</p>
    {children}
  </div>
)

export const SetupCompare = () => (
  <div className="viz space-y-4">
    <div className="grid gap-4 md:grid-cols-2">
      {ways.map(({ icon: Icon, title, input, steps, highlight }) => (
        <div
          className={`bg-fd-card space-y-4 rounded-xl p-5 text-sm ${highlight ? "border-2 border-[var(--series-1)]" : "border"}`}
          key={title}
        >
          <p className="flex items-center gap-2 font-semibold">
            <Icon
              aria-hidden="true"
              className={`size-4 ${highlight ? "text-[var(--series-1)]" : "text-fd-muted-foreground"}`}
            />
            {title}
          </p>
          <Row label="You bring">
            <p>{input}</p>
          </Row>
          <Row label="Then">
            <ol className="text-fd-muted-foreground list-inside list-decimal space-y-1">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </Row>
        </div>
      ))}
    </div>
    <div className="bg-fd-card rounded-xl border p-5 text-sm">
      <p className="text-fd-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">You get, either way</p>
      <p>
        One config file you can keep in git, checked before it runs, and every datapoint arriving on your broker.
        Devices are only read; nothing is writable unless you ask for it.
      </p>
    </div>
  </div>
)
