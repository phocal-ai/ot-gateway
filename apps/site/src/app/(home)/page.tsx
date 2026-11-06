/**
 * The landing page. Its claims come from docs/VISION.md and the README; keep
 * them in step with those rather than adding numbers the repo does not back.
 */
import Link from "next/link"
import type * as React from "react"
import { PublishChart } from "@/components/home/publish-chart.tsx"
import { ConfigFlow } from "@/components/home/config-flow.tsx"
import { Flow } from "@/components/home/flow.tsx"
import { HowItWorks, SeeItWork } from "@/components/home/how-it-works.tsx"
import { PollDemo } from "@/components/home/poll-demo.tsx"
import { SetupCompare } from "@/components/home/setup-compare.tsx"
import { StatusMock } from "@/components/home/status-mock.tsx"
import { site } from "@/lib/site.ts"

const audiences = [
  [
    "Facility and energy managers",
    "Meter readings and plant data in the dashboard or energy report you already use, without a vendor project."
  ],
  [
    "System integrators",
    "One small, scripted install per building: the same config format, status page and health message every time."
  ],
  [
    "Platform and software teams",
    "Clean MQTT with names, units and semantics on every point, so building data looks like any other data."
  ]
] as const

const features: ReadonlyArray<readonly [string, React.ReactNode]> = [
  [
    "Modbus TCP and BACnet/IP in",
    <>
      Polling, BACnet change-of-value, scaling and QUDT units per point. <code>ot-gateway discover</code> finds BACnet
      devices and drafts their config.
    </>
  ],
  [
    "MQTT 5 out",
    <>
      Values on <code>site/building/device/point</code>, metadata on the retained <code>$meta</code> topic, gateway
      health on its own retained topic.
    </>
  ],
  [
    "Safe writes",
    "Writing is opt-in per point, range-checked and logged. A command is written once or not at all, never replayed from a buffer."
  ],
  [
    "Store-and-forward",
    "While the broker is unreachable, values go to a SQLite outbox on the gateway and are sent, in order, when it returns."
  ],
  [
    "Observable",
    "Each device is ok, starting or failing with a reason, on the status page and in the health message. Metrics, logs and traces go out over OpenTelemetry."
  ],
  [
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

/** A config that `ot-gateway check` accepts (the docs' configuration reference), trimmed to one point. */
const exampleConfig = `{
  "site": "vienna-hq",
  "building": "main",
  "mqtt": { "url": "mqtt://broker.example.com:1883" },
  "devices": [{
    "protocol": "bacnet-ip",
    "id": "ahu-1",
    "address": "10.0.4.21",
    "deviceInstance": 1001,
    "pollIntervalMs": 30000,
    "publish": {
      "mode": "aggregate",
      "intervalMs": 900000
    },
    "points": [{
      "id": "supply-air-temp",
      "name": "Supply air temperature",
      "objectType": "analog-input",
      "instance": 1,
      "unit": "unit:DEG_C"
    }]
  }]
}`

/** What that config publishes every 15 minutes: an aggregate message, as closeWindow in packages/core builds it. */
const exampleTopic = "vienna-hq/main/ahu-1/supply-air-temp"
const exampleMessage = `{
  "value": 21.38,
  "min": 20.9,
  "max": 21.8,
  "avg": 21.38,
  "last": 21.6,
  "count": 30,
  "from": 1793872800000,
  "to": 1793873700000,
  "ts": 1793873700000,
  "unit": "unit:DEG_C"
}`

const Section = ({ title, children }: { readonly title: string; readonly children: React.ReactNode }) => (
  <section className="border-t py-14">
    <h2 className="mb-6 text-2xl font-semibold tracking-tight">{title}</h2>
    {children}
  </section>
)

const Code = ({ children }: { readonly children: string }) => (
  <pre className="bg-fd-card overflow-x-auto rounded-lg border p-4 text-sm leading-relaxed">
    <code>{children}</code>
  </pre>
)

const HomePage = () => (
  <main className="mx-auto w-full max-w-5xl px-6">
    <section className="py-16 md:py-20">
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
        <Link
          className="bg-fd-primary text-fd-primary-foreground rounded-md px-4 py-2 text-sm font-medium"
          href="/docs"
        >
          Try it in one minute
        </Link>
        <Link className="hover:bg-fd-accent rounded-md border px-4 py-2 text-sm font-medium" href="/docs/how-it-works">
          How it works
        </Link>
        <a className="hover:bg-fd-accent rounded-md border px-4 py-2 text-sm font-medium" href={site.repository}>
          GitHub
        </a>
      </div>
    </section>

    <section className="pb-16">
      <Flow />
    </section>

    <Section title="How it works">
      <HowItWorks />
    </Section>

    <Section title="See it work in less than a minute">
      <SeeItWork />
    </Section>

    <Section title="You always know whether it works">
      <div className="grid gap-8 md:grid-cols-[3fr_2fr] md:items-center">
        <StatusMock />
        <p className="text-fd-muted-foreground text-sm">
          Every gateway has a status page: each device green or red, with the reason and when it last answered, and the
          messages that went out. The same goes to the broker as a health message, so your platform can raise an alert
          when a device goes quiet instead of showing an old value.
        </p>
      </div>
    </Section>

    <Section title="Read often, send what you need">
      <div className="grid gap-8 md:grid-cols-[2fr_1fr] md:items-center">
        <PublishChart />
        <div className="text-fd-muted-foreground space-y-3 text-sm">
          <p>How often a device is read and what goes to the broker are set separately, per device or per point.</p>
          <p>
            <span className="text-fd-foreground font-medium">Every read</span> for live dashboards.{" "}
            <span className="text-fd-foreground font-medium">Aggregates</span> for energy reports and analytics:
            minimum, maximum and time-weighted average per window, aligned to the clock like the meter&apos;s 15
            minutes. <span className="text-fd-foreground font-medium">On change</span> for states, alarms and setpoints
            that sit still for hours.
          </p>
        </div>
      </div>
    </Section>

    <Section title="One poll, step by step">
      <PollDemo />
    </Section>

    <Section title="Config in, MQTT out">
      <ConfigFlow />
      <p className="text-fd-muted-foreground mt-4 max-w-2xl text-sm">
        That is the whole mapping: which device, which datapoint, how often to poll and what to send. No code, no flows.
      </p>
      <details className="mt-4 text-sm">
        <summary className="text-fd-muted-foreground hover:text-fd-foreground cursor-pointer">
          Show the config and the message as JSON
        </summary>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <Code>{exampleConfig}</Code>
          <Code>{`${exampleTopic}\n${exampleMessage}`}</Code>
        </div>
      </details>
    </Section>

    <Section title="Set it up by hand, or let your AI assistant do it">
      <SetupCompare />
      <p className="text-fd-muted-foreground mt-4 text-sm">
        <Link className="text-fd-foreground font-medium underline" href="/docs#set-it-up-with-ai">
          Set it up with AI
        </Link>{" "}
        works with Claude Code, Cursor, Codex or any agent that can run commands.
      </p>
    </Section>

    <Section title="Who it is for">
      <dl className="grid gap-6 md:grid-cols-3">
        {audiences.map(([title, text]) => (
          <div key={title}>
            <dt className="font-medium">{title}</dt>
            <dd className="text-fd-muted-foreground mt-1 text-sm">{text}</dd>
          </div>
        ))}
      </dl>
    </Section>

    <Section title="Under the hood">
      <dl className="grid gap-x-8 gap-y-6 md:grid-cols-3">
        {features.map(([title, text]) => (
          <div key={title}>
            <dt className="font-medium">{title}</dt>
            <dd className="text-fd-muted-foreground mt-1 text-sm">{text}</dd>
          </div>
        ))}
      </dl>
    </Section>

    <Section title="Where it fits">
      <p className="text-fd-muted-foreground mb-6 max-w-2xl">
        Between visual flow tools and closed vendor gateways: code-first, typed and testable, yet usable from a config
        file. It is built on Effect for TypeScript, with its own Modbus, BACnet/IP and MQTT 5 stacks.
      </p>
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
              <tr className="border-b" key={tool}>
                <td className="text-fd-foreground py-2 pr-4">{tool}</td>
                <td className="py-2 pr-4">{strength}</td>
                <td className="py-2">{difference}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>

    <footer className="text-fd-muted-foreground flex flex-wrap gap-6 border-t py-10 text-sm">
      <span>OT Gateway, MIT licensed</span>
      <Link href="/docs">Docs</Link>
      <Link href="/docs/how-it-works">How it works</Link>
      <Link href="/docs/vision">Vision</Link>
      <a href={site.repository}>GitHub</a>
    </footer>
  </main>
)

export default HomePage
