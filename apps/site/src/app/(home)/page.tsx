/**
 * The landing page. Its claims come from docs/VISION.md and the README; keep
 * them in step with those rather than adding numbers the repo does not back.
 */
import { Activity, MonitorCheck, RadioTower } from "lucide-react"
import Link from "next/link"
import type * as React from "react"
import { PublishChart } from "@/components/home/publish-chart.tsx"
import { Flow } from "@/components/home/flow.tsx"
import { AiSetup } from "@/components/home/ai-setup.tsx"
import { Audiences } from "@/components/home/audiences.tsx"
import { CopyCommand, CopyPrompt } from "@/components/home/copy-command.tsx"
import { demoCommand, HowItWorks } from "@/components/home/how-it-works.tsx"
import { PollDemo } from "@/components/home/poll-demo.tsx"
import { StatusMock } from "@/components/home/status-mock.tsx"
import { site } from "@/lib/site.ts"

type Icon = React.ComponentType<{ readonly className?: string; readonly "aria-hidden"?: "true" }>

/** Where to look when something is wrong (docs/operations.md, observability/README.md). */
const debugging: ReadonlyArray<readonly [Icon, string, React.ReactNode]> = [
  [
    MonitorCheck,
    "Status page",
    "On the gateway, port 8080: devices, values, messages and history, for whoever is on site."
  ],
  [
    RadioTower,
    "Health on MQTT",
    <>
      <code>…/$gateway/main/health</code>, retained: online or offline and which devices fail, for your alerts.
    </>
  ],
  [
    Activity,
    "OpenTelemetry",
    "Metrics, logs and traces to Grafana or any OpenTelemetry backend, set with the standard OTEL_* variables."
  ]
]

/** The prompt from the README's "Set it up with AI", for agents other than Claude Code; keep the two the same. */
const setupPrompt = `Set up an OT Gateway for my site. Read https://raw.githubusercontent.com/phocal-ai/ot-gateway/main/.claude/skills/setup/SKILL.md and follow it step by step, with npx ot-gateway and no clone: run the commands yourself, ask me only what you cannot find out, never write to a device, and keep secrets out of the JSON config. Stop when values from my devices reach the broker.`

const setupSkill = `${site.repository}/blob/main/.claude/skills/setup/SKILL.md`

/** Kinds of tool, not products: public copy names no brands (CLAUDE.md). */
const positioning = [
  [
    "Visual flow tools",
    "Fast prototyping, big ecosystems",
    "A typed config in version control, testable without hardware"
  ],
  ["Protocol gateways", "Many industrial protocols", "Open, small, with debugging and telemetry built in"],
  ["IoT platform connectors", "Tight fit with their platform", "Standard MQTT to any broker, tied to no platform"],
  ["Metrics agents", "Excellent at collecting metrics", "Two-way, with guarded writes and point metadata"],
  [
    "Industrial controllers (PLCs)",
    "Proven hardware, programmed per site",
    "A fraction of the cost; set up from a file, with an AI agent"
  ],
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
  id,
  title,
  lead,
  flush = false,
  children
}: {
  /** An anchor to link to the section. */
  readonly id?: string
  readonly title: string
  readonly lead?: React.ReactNode
  /** Content that brings its own cells, edge to edge, instead of padding. */
  readonly flush?: boolean
  readonly children: React.ReactNode
}) => (
  <section className="scroll-mt-14" id={id}>
    <Rule />
    <header className="px-6 py-14 text-center md:px-12 md:py-20">
      <h2 className="mx-auto max-w-3xl text-3xl font-semibold tracking-tight md:text-4xl">{title}</h2>
      {lead === undefined ? null : <p className="text-fd-muted-foreground mx-auto mt-4 max-w-2xl">{lead}</p>}
    </header>
    <Rule />
    <div className={flush ? "" : "px-6 py-10 md:px-12 md:py-14"}>{children}</div>
  </section>
)

const primaryButton = "bg-fd-primary text-fd-primary-foreground rounded-md px-4 py-2 text-sm font-medium"
const secondaryButton = "hover:bg-fd-accent rounded-md border px-4 py-2 text-sm font-medium"

const HomePage = () => (
  <div className="home-dots">
    <main className="bg-fd-background mx-auto w-full max-w-6xl border-x border-dashed">
      <section className="px-6 py-16 md:px-12 md:py-24">
        <p className="text-fd-muted-foreground mb-3 text-sm font-medium">Open source · MIT</p>
        <h1 className="mb-5 max-w-3xl tracking-tight">
          <span className="block text-4xl font-semibold md:text-5xl">OT Gateway</span>
          <span className="text-fd-muted-foreground mt-2 block text-2xl font-medium md:text-3xl">
            OT data in. Standard MQTT out.
          </span>
        </h1>
        <p className="text-fd-muted-foreground mb-8 max-w-2xl text-lg">
          Reads building and industrial protocols and sends the data as standard MQTT. Nothing is lost when the
          connection drops. Built for AI-native setup and debugging.
        </p>
        <div className="flex flex-wrap items-start gap-3">
          <Link className={`${primaryButton} shrink-0`} href="/docs">
            Get started
          </Link>
          <CopyPrompt prompt={setupPrompt} />
        </div>
        <p className="text-fd-muted-foreground mt-8 text-sm">
          Modbus TCP · BACnet/IP · MQTT 3.1.1 and 5 · runs in Docker, for example on a Raspberry Pi
        </p>
      </section>

      <Rule />
      <section className="px-6 py-12 md:px-12 md:py-16">
        <Flow />
      </section>

      <Section lead="Three steps from the devices on your site to data on your broker." title="How it works">
        <HowItWorks />
      </Section>

      <Section
        lead="Every gateway has a status page, a health message on MQTT and OpenTelemetry: each device ok or failing with the reason, and the values as they arrive."
        title="Debugging built in"
      >
        <StatusMock />
        <dl className="mt-8 grid gap-6 text-sm md:grid-cols-3">
          {debugging.map(([Icon, title, text]) => (
            <div className="flex gap-3" key={title}>
              <Icon aria-hidden="true" className="text-fd-muted-foreground mt-0.5 size-5 shrink-0" />
              <div>
                <dt className="font-medium">{title}</dt>
                <dd className="text-fd-muted-foreground mt-1">{text}</dd>
              </div>
            </div>
          ))}
        </dl>
      </Section>

      <Section
        lead="Read a device every few seconds and send only what your software needs: every read, an average per window, or only the changes."
        title="Read often, send what you need"
      >
        <PublishChart />
      </Section>

      <Section
        flush
        id="ai-native"
        lead="Developed with AI from the start. It comes with what an AI agent needs to set it up and to help when something breaks."
        title="Built AI-native"
      >
        <div className="grid gap-10 px-6 py-10 md:grid-cols-[1fr_1.5fr] md:items-center md:px-12 md:py-14">
          <div className="text-sm">
            <p className="text-fd-muted-foreground text-xs font-medium tracking-wide uppercase">You bring</p>
            <ul className="mt-2 list-disc space-y-1.5 pl-4">
              <li>A machine on the site's network</li>
              <li>Your datapoint list, or the device datasheets</li>
              <li>What to read, how often, and where it goes</li>
            </ul>
            <p className="text-fd-muted-foreground mt-4">
              The agent drives the CLI: <code>discover</code>, <code>import</code>, <code>check</code>,{" "}
              <code>watch</code> and <code>status</code>, in plain text, and <code>check</code> names every mistake with
              its path.
            </p>
            <p className="text-fd-muted-foreground mt-4">
              Copy the prompt from the top of the page, or type <code>/setup</code> in Claude Code. It follows{" "}
              <a className="text-fd-foreground font-medium underline" href={setupSkill}>
                the setup skill
              </a>
              . Rather do it yourself?{" "}
              <Link className="text-fd-foreground font-medium underline" href="/docs/first-building">
                Your first site
              </Link>{" "}
              walks you through it by hand.
            </p>
          </div>
          <AiSetup />
        </div>
      </Section>

      <Section flush lead="From the field bus to the dashboard." title="Who it is for">
        <Audiences />
      </Section>

      <Section
        lead="One read of the heat pump's flow temperature, from the BACnet bytes to the MQTT message."
        title="From bytes to MQTT"
      >
        <details className="group text-center">
          <summary
            className={`${secondaryButton} inline-flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden`}
          >
            <span className="group-open:hidden">Show the bytes</span>
            <span className="hidden group-open:inline">Hide the bytes</span>
          </summary>
          <div className="mt-8 text-left">
            <PollDemo />
          </div>
        </details>
      </Section>

      <Section
        lead="Between visual flow tools and closed vendor gateways: code-first, typed and testable, yet usable from a config file."
        title="Where it fits"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-4 font-medium">Kind of tool</th>
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
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Connect your first site</h2>
        <p className="text-fd-muted-foreground mx-auto mt-4 max-w-xl">Try it in a minute, without devices:</p>
        <div className="mx-auto mt-6 max-w-2xl text-left">
          <CopyCommand command={demoCommand} />
        </div>
        <div className="mt-8 flex justify-center">
          <Link className={primaryButton} href="/docs">
            Get started
          </Link>
        </div>
      </section>

      <Rule />
      <footer className="text-fd-muted-foreground flex flex-wrap gap-6 px-6 py-10 text-sm md:px-12">
        <span>OT Gateway, MIT licensed</span>
        <Link href="/docs">Docs</Link>
        <Link href="/docs/how-it-works">How it works</Link>
        <Link href="/docs/operations">Operations</Link>
        <Link href="/docs/troubleshooting">Troubleshooting</Link>
        <Link href="/docs/vision">Vision</Link>
        <a href={site.repository}>GitHub</a>
      </footer>
    </main>
  </div>
)

export default HomePage
