/**
 * The landing page. Its claims come from docs/VISION.md and the README; keep
 * them in step with those rather than adding numbers the repo does not back.
 */
import {
  Activity,
  Building2,
  Code,
  DatabaseBackup,
  FlaskConical,
  LifeBuoy,
  Network,
  RadioTower,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Wrench
} from "lucide-react"
import Link from "next/link"
import type * as React from "react"
import { PublishChart } from "@/components/home/publish-chart.tsx"
import { Flow } from "@/components/home/flow.tsx"
import { AiSetup } from "@/components/home/ai-setup.tsx"
import { CopyCommand } from "@/components/home/copy-command.tsx"
import { demoCommand, HowItWorks } from "@/components/home/how-it-works.tsx"
import { PollDemo } from "@/components/home/poll-demo.tsx"
import { StatusMock } from "@/components/home/status-mock.tsx"
import { site } from "@/lib/site.ts"

type Icon = React.ComponentType<{ readonly className?: string; readonly "aria-hidden"?: "true" }>

const audiences: ReadonlyArray<readonly [Icon, string, React.ReactNode]> = [
  [
    Building2,
    "Facility and energy managers",
    "Meter readings and plant data in the dashboard or energy report you already use, without a vendor project."
  ],
  [
    Wrench,
    "System integrators",
    "One small, scripted install per building: the same config format, status page and health message every time."
  ],
  [
    Code,
    "Platform and software teams",
    "Clean MQTT with names, units and semantics on every point, so building data looks like any other data."
  ]
]

/** What an AI assistant gets to work with; each item exists in the repo (README "Set it up with AI", Cli.ts, docs). */
const aiNative: ReadonlyArray<readonly [Icon, string, React.ReactNode]> = [
  [
    Sparkles,
    "A setup skill",
    <>
      <code>/setup</code> in Claude Code, or one prompt for Cursor, Codex or any agent that runs commands: from the
      first question to values on your broker.
    </>
  ],
  [
    SquareTerminal,
    "A CLI it can drive",
    <>
      <code>discover</code>, <code>import</code>, <code>check</code>, <code>watch</code> and <code>status</code>, in
      plain text. <code>check</code> lists every mistake with its path.
    </>
  ],
  [
    LifeBuoy,
    "Help when something breaks",
    "Each device says ok or failing with a reason, and the troubleshooting guide maps log messages to causes and fixes, so your assistant can find what went wrong."
  ]
]

/** The prompt from the README's "Set it up with AI", for agents other than Claude Code; keep the two the same. */
const setupPrompt = `Set up an OT Gateway for my building. Clone https://github.com/phocal-ai/ot-gateway if this is not already a checkout of it, then read .claude/skills/setup/SKILL.md and follow it step by step: run the commands yourself, ask me only what you cannot find out, never write to a device, and keep secrets out of the JSON config. Stop when values from my devices reach the broker.`

const setupSkill = `${site.repository}/blob/main/.claude/skills/setup/SKILL.md`

const features: ReadonlyArray<readonly [Icon, string, React.ReactNode]> = [
  [
    Network,
    "Modbus TCP and BACnet/IP in",
    <>
      Polling, BACnet change-of-value, scaling and QUDT units per point. <code>ot-gateway discover</code> finds BACnet
      devices and drafts their config.
    </>
  ],
  [
    RadioTower,
    "MQTT 5 out",
    <>
      Values on <code>site/building/device/point</code>, metadata on the retained <code>$meta</code> topic, gateway
      health on its own retained topic.
    </>
  ],
  [
    ShieldCheck,
    "Safe writes",
    "Writing is opt-in per point, range-checked and logged. A command is written once or not at all, never replayed from a buffer."
  ],
  [
    DatabaseBackup,
    "Store-and-forward",
    "While the broker is unreachable, values go to a SQLite outbox on the gateway and are sent, in order, when it returns."
  ],
  [
    Activity,
    "Observable",
    "Each device is ok, starting or failing with a reason, on the status page and in the health message. Metrics, logs and traces go out over OpenTelemetry."
  ],
  [
    FlaskConical,
    "Testable without hardware",
    "Every driver has a simulator, and CI runs the gateway end to end against Mosquitto, EMQX, a BACnet server and pymodbus."
  ]
]

const positioning = [
  [
    "Node-RED",
    "Fast visual prototyping, big ecosystem",
    "Typed, version-controlled config and code; testable without hardware"
  ],
  ["EMQX Neuron", "Many industrial protocols", "Open, small, library-first; focused on building automation"],
  ["ThingsBoard IoT Gateway", "Broad connector set", "Not tied to one platform; generic MQTT output"],
  ["Telegraf", "Excellent metrics collection", "Two-way, with safe command write-back and point semantics"],
  ["Vendor gateways", "Supported, certified", "Open source, extensible, no lock-in"]
] as const

/** A horizontal line of the page's frame, with a small square where it meets each side rail. */
const Rule = () => (
  <div aria-hidden="true" className="relative border-t">
    <span className="bg-fd-background absolute -top-[5px] -left-[5px] size-[9px] border" />
    <span className="bg-fd-background absolute -top-[5px] -right-[5px] size-[9px] border" />
  </div>
)

/** A row of the page: a centered heading cell with its lead, a rule, then the content. */
const Section = ({
  title,
  lead,
  flush = false,
  children
}: {
  readonly title: string
  readonly lead?: React.ReactNode
  /** Content that brings its own cells, edge to edge, instead of padding. */
  readonly flush?: boolean
  readonly children: React.ReactNode
}) => (
  <section>
    <Rule />
    <header className="px-6 py-14 text-center md:px-12 md:py-20">
      <h2 className="mx-auto max-w-3xl text-3xl font-semibold tracking-tight md:text-4xl">{title}</h2>
      {lead === undefined ? null : <p className="text-fd-muted-foreground mx-auto mt-4 max-w-2xl">{lead}</p>}
    </header>
    <Rule />
    <div className={flush ? "" : "px-6 py-10 md:px-12 md:py-14"}>{children}</div>
  </section>
)

/** Cells divided by hairlines, edge to edge with the frame, each with an icon, a title and a sentence. */
const Cells = ({ items }: { readonly items: ReadonlyArray<readonly [Icon, string, React.ReactNode]> }) => (
  <dl className="bg-fd-border grid gap-px md:grid-cols-3">
    {items.map(([Icon, title, text]) => (
      <div className="bg-fd-background p-6 md:p-8" key={title}>
        <Icon aria-hidden="true" className="text-fd-muted-foreground mb-5 size-6" />
        <dt className="font-medium">{title}</dt>
        <dd className="text-fd-muted-foreground mt-1 text-sm">{text}</dd>
      </div>
    ))}
  </dl>
)

const primaryButton = "bg-fd-primary text-fd-primary-foreground rounded-md px-4 py-2 text-sm font-medium"
const secondaryButton = "hover:bg-fd-accent rounded-md border px-4 py-2 text-sm font-medium"

const HomePage = () => (
  <div className="home-dots">
    <main className="bg-fd-background mx-auto w-full max-w-6xl border-x border-dashed">
      <section className="px-6 py-16 md:px-12 md:py-24">
        <p className="text-fd-muted-foreground mb-3 text-sm font-medium">Open source · MIT · early</p>
        <h1 className="mb-5 max-w-3xl tracking-tight">
          <span className="block text-4xl font-semibold md:text-5xl">OT Gateway</span>
          <span className="text-fd-muted-foreground mt-2 block text-2xl font-medium md:text-3xl">
            Building protocols in. MQTT out.
          </span>
        </h1>
        <p className="text-fd-muted-foreground mb-8 max-w-2xl text-lg">
          It polls devices on a schedule and publishes their data to MQTT. Built AI-native: your AI assistant sets it up
          with you, from finding the devices to the first values.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link className={primaryButton} href="/docs">
            Get started
          </Link>
          <Link className={secondaryButton} href="/docs/how-it-works">
            How it works
          </Link>
          <a className={secondaryButton} href={site.repository}>
            GitHub
          </a>
        </div>
        <div className="mt-8 max-w-2xl">
          <p className="text-fd-muted-foreground mb-2 text-sm">See it work in less than a minute, without devices:</p>
          <CopyCommand command={demoCommand} />
        </div>
      </section>

      <Rule />
      <section className="px-6 py-12 md:px-12 md:py-16">
        <Flow />
      </section>

      <Section lead="Three steps from the devices in your building to data on your broker." title="How it works">
        <HowItWorks />
      </Section>

      <Section
        lead="Every gateway comes with a status page: each device green or red with the reason, and the values as they arrive."
        title="Know when a device goes quiet"
      >
        <StatusMock />
      </Section>

      <Section
        lead="How often a device is read and what goes to the broker are set separately, per device or per point."
        title="Read often, send what you need"
      >
        <div className="grid gap-8 md:grid-cols-[2fr_1fr] md:items-center">
          <PublishChart />
          <p className="text-fd-muted-foreground text-sm">
            <span className="text-fd-foreground font-medium">Every read</span> for live dashboards.{" "}
            <span className="text-fd-foreground font-medium">Aggregates</span> for energy reports and analytics:
            minimum, maximum and time-weighted average per window, aligned to the clock like the meter&apos;s 15
            minutes. <span className="text-fd-foreground font-medium">On change</span> for states, alarms and setpoints
            that sit still for hours.
          </p>
        </div>
      </Section>

      <Section
        lead="Click through one read of a supply air temperature, from the BACnet bytes on the wire to the message on your broker."
        title="One poll, step by step"
      >
        <PollDemo />
      </Section>

      <Section
        flush
        lead="Developed with AI from the start, it comes with what your AI assistant needs to set it up with you and to help when something breaks."
        title="Built AI-native"
      >
        <div className="grid gap-10 px-6 py-10 md:grid-cols-[1fr_1.5fr] md:items-center md:px-12 md:py-14">
          <div className="text-sm">
            <p className="text-fd-muted-foreground text-xs font-medium tracking-wide uppercase">You bring</p>
            <ul className="mt-2 list-disc space-y-1.5 pl-4">
              <li>A machine on the building network</li>
              <li>Your datapoint list, or the device datasheets</li>
              <li>What to read, how often, and where it goes</li>
            </ul>
            <p className="text-fd-muted-foreground mt-6 mb-2 text-xs font-medium tracking-wide uppercase">
              Paste this into your AI assistant
            </p>
            <CopyCommand command={setupPrompt} multiline />
            <p className="text-fd-muted-foreground mt-3">
              It follows{" "}
              <a className="text-fd-foreground font-medium underline" href={setupSkill}>
                the setup skill
              </a>
              . In Claude Code, just type <code>/setup</code>. Rather do it yourself?{" "}
              <Link className="text-fd-foreground font-medium underline" href="/docs/first-building">
                Your first building
              </Link>{" "}
              walks you through it by hand.
            </p>
          </div>
          <AiSetup />
        </div>
        <Rule />
        <Cells items={aiNative} />
      </Section>

      <Section flush title="Who it is for">
        <Cells items={audiences} />
      </Section>

      <Section
        flush
        lead="Built on Effect for TypeScript, with its own Modbus, BACnet/IP and MQTT 5 stacks."
        title="Under the hood"
      >
        <Cells items={features} />
      </Section>

      <Section
        lead="Between visual flow tools and closed vendor gateways: code-first, typed and testable, yet usable from a config file."
        title="Where it fits"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-4 font-medium">Tool</th>
                <th className="py-2 pr-4 font-medium">Strength</th>
                <th className="py-2 font-medium">Where OT Gateway differs</th>
              </tr>
            </thead>
            <tbody className="text-fd-muted-foreground">
              {positioning.map(([tool, strength, difference]) => (
                <tr className="border-b last:border-b-0" key={tool}>
                  <td className="text-fd-foreground py-2 pr-4">{tool}</td>
                  <td className="py-2 pr-4">{strength}</td>
                  <td className="py-2">{difference}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Rule />
      <section className="px-6 py-20 text-center md:px-12 md:py-28">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Connect your first building</h2>
        <p className="text-fd-muted-foreground mx-auto mt-4 max-w-xl">
          By hand or with your AI assistant. Or start with the simulated one.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link className={primaryButton} href="/docs">
            Get started
          </Link>
          <Link className={secondaryButton} href="/docs#set-it-up-with-ai">
            Set it up with AI
          </Link>
        </div>
        <div className="mx-auto mt-6 max-w-2xl text-left">
          <CopyCommand command={demoCommand} />
        </div>
      </section>

      <Rule />
      <footer className="text-fd-muted-foreground flex flex-wrap gap-6 px-6 py-10 text-sm md:px-12">
        <span>OT Gateway, MIT licensed</span>
        <Link href="/docs">Docs</Link>
        <Link href="/docs/how-it-works">How it works</Link>
        <Link href="/docs/vision">Vision</Link>
        <a href={site.repository}>GitHub</a>
      </footer>
    </main>
  </div>
)

export default HomePage
