/**
 * The landing page. Its claims come from docs/VISION.md and the README; keep
 * them in step with those rather than adding numbers the repo does not back.
 */
import Link from "next/link"
import type * as React from "react"
import { PublishChart } from "@/components/home/publish-chart.tsx"
import { Flow } from "@/components/home/flow.tsx"
import { StatusMock } from "@/components/home/status-mock.tsx"
import { site } from "@/lib/site.ts"

const journey = [
  {
    step: "1",
    title: "See it work",
    time: "1 minute",
    text: "A small simulated building on your computer: an energy meter, an air handler, the gateway and a test broker. No devices, no accounts.",
    command: "docker run --rm -it -p 127.0.0.1:8080:8080 ghcr.io/phocal-ai/ot-gateway demo",
    href: "/docs#quick-start",
    link: "Quick start"
  },
  {
    step: "2",
    title: "Describe your building",
    time: "15 minutes",
    text: "Say which values you want, from which devices, how often and where to. A few questions write the config; BACnet devices are found for you.",
    command: "ot-gateway init",
    href: "/docs/first-building",
    link: "Your first building"
  },
  {
    step: "3",
    title: "Leave it running",
    time: "for months",
    text: "On any always-on machine with Docker, or a Raspberry Pi. It reconnects, buffers while the network is down, and tells you when a device stops answering.",
    command: "docker compose -f packaging/compose.yaml up -d",
    href: "/docs/operations",
    link: "Running a gateway"
  }
] as const

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

const message = `vienna-hq/main/ahu-1/supply-air-temp
{"value":21.5,"ts":1793631666939,"unit":"unit:DEG_C"}`

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
      <h1 className="mb-5 max-w-3xl text-4xl font-semibold tracking-tight md:text-5xl">
        Your building&apos;s data, in your software
      </h1>
      <p className="text-fd-muted-foreground mb-8 max-w-2xl text-lg">
        Meters and controllers speak old building protocols. Dashboards and platforms speak MQTT. OT Gateway is the
        small program in between: it reads the values you choose, names them, and sends them on, unattended and for
        months.
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

    <Section title="You know what you want. It does the rest.">
      <p className="text-fd-muted-foreground mb-8 max-w-2xl">
        A points list is usually where it starts: the energy meter&apos;s active power every 5 seconds, each air
        handler&apos;s supply temperature every 30, all of it to the company broker. That list becomes one config file,
        and every value arrives under a name that says where it came from:
      </p>
      <Code>{message}</Code>
      <p className="text-fd-muted-foreground mt-3 text-sm">
        site / building / device / point, with the value, the time it was read and its unit.
      </p>
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

    <Section title="From first look to a running building">
      <ol className="grid gap-6 md:grid-cols-3">
        {journey.map((item) => (
          <li className="bg-fd-card flex flex-col rounded-xl border p-5" key={item.step}>
            <p className="text-fd-muted-foreground mb-2 text-xs font-medium">
              Step {item.step} · {item.time}
            </p>
            <h3 className="mb-2 font-semibold">{item.title}</h3>
            <p className="text-fd-muted-foreground mb-4 flex-1 text-sm">{item.text}</p>
            <pre className="bg-fd-background mb-4 rounded-md border p-2 text-xs break-all whitespace-pre-wrap">
              <code>{item.command}</code>
            </pre>
            <Link className="text-sm font-medium underline" href={item.href}>
              {item.link}
            </Link>
          </li>
        ))}
      </ol>
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
