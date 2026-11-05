/**
 * The landing page. Its claims come from docs/VISION.md and the README; keep
 * them in step with those rather than adding numbers the repo does not back.
 */
import Link from "next/link"
import type * as React from "react"
import { site } from "@/lib/site.ts"

const problems = [
  [
    "Flow tools hide failure.",
    "Node-RED-style gateways are fast to start but hard to test and version. When a device goes quiet, it is often unclear why."
  ],
  [
    "Vendor gateways are closed.",
    "They are expensive, hard to extend, and keep the point mapping inside a proprietary UI."
  ],
  ["Scripts don't survive.", "A one-off script works until the first network drop, socket leak or full SD card."],
  [
    "Field reality is messy.",
    "Timeouts, CRC errors, rebooting devices, offline brokers and inconsistent register maps are normal, not exceptions."
  ]
] as const

const features: ReadonlyArray<readonly [string, React.ReactNode]> = [
  [
    "Modbus TCP and BACnet/IP in",
    <>
      Polling, BACnet change-of-value, scaling, deadband and QUDT units per point. <code>--discover</code> finds BACnet
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
    "While the broker is unreachable, values go to a SQLite outbox on the device and are sent when it returns."
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

const messages = `[retained] demo-site/b1/ahu-1/supply-air-temp/$meta {"name":"AHU 1 supply air temperature","unit":"unit:DEG_C",...}
demo-site/b1/ahu-1/supply-air-temp {"value":20.99,"ts":1793631666939,"unit":"unit:DEG_C"}
demo-site/b1/main-meter/active-power {"value":32.67,"ts":1793631666941,"unit":"unit:KiloW"}
demo-site/b1/main-meter/breaker-tripped {"value":true,"ts":1793631666942}`

const quickStart = `git clone ${site.repository}
cd ot-gateway
pnpm install
pnpm bench      # terminal 1: a test broker and simulated Modbus and BACnet devices
pnpm gateway    # terminal 2: the gateway, with examples/gateway.json`

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
    <section className="py-20">
      <p className="text-fd-muted-foreground mb-3 text-sm font-medium">Open source · MIT · early</p>
      <h1 className="mb-5 text-4xl font-semibold tracking-tight md:text-5xl">An edge gateway for buildings</h1>
      <p className="text-fd-muted-foreground mb-8 max-w-2xl text-lg">
        OT Gateway reads Modbus TCP and BACnet/IP, publishes clean, normalized data to MQTT 5 and carries commands back
        safely. It runs unattended on a Raspberry Pi, configured with one JSON file. When something goes wrong, it says
        what, where and since when.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link
          className="bg-fd-primary text-fd-primary-foreground rounded-md px-4 py-2 text-sm font-medium"
          href="/docs"
        >
          Get started
        </Link>
        <a className="hover:bg-fd-accent rounded-md border px-4 py-2 text-sm font-medium" href={site.repository}>
          GitHub
        </a>
      </div>
    </section>

    <Section title="Getting data out of a building is harder than it should be">
      <p className="text-fd-muted-foreground mb-6 max-w-2xl">
        Field devices speak Modbus and BACnet; modern platforms expect MQTT and structured data. The glue in between is
        usually fragile.
      </p>
      <dl className="grid gap-6 md:grid-cols-2">
        {problems.map(([title, text]) => (
          <div key={title}>
            <dt className="font-medium">{title}</dt>
            <dd className="text-fd-muted-foreground mt-1 text-sm">{text}</dd>
          </div>
        ))}
      </dl>
    </Section>

    <Section title="What it does">
      <dl className="grid gap-x-8 gap-y-6 md:grid-cols-3">
        {features.map(([title, text]) => (
          <div key={title}>
            <dt className="font-medium">{title}</dt>
            <dd className="text-fd-muted-foreground mt-1 text-sm">{text}</dd>
          </div>
        ))}
      </dl>
      <p className="text-fd-muted-foreground mt-10 mb-3 text-sm">What the gateway publishes from the simulated demo:</p>
      <Code>{messages}</Code>
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

    <Section title="Try it on a laptop">
      <p className="text-fd-muted-foreground mb-4 max-w-2xl">
        Node.js 22.18 or newer and pnpm 10. The bench prints every message the gateway publishes, and the status page is
        at <code>http://127.0.0.1:8080</code>.
      </p>
      <Code>{quickStart}</Code>
      <p className="text-fd-muted-foreground mt-6 text-sm">
        Then{" "}
        <Link className="text-fd-foreground underline" href="/docs">
          set it up for your building
        </Link>
        , or{" "}
        <Link className="text-fd-foreground underline" href="/docs/raspberry-pi-install">
          install it on a Raspberry Pi
        </Link>{" "}
        from a blank SD card.
      </p>
    </Section>

    <footer className="text-fd-muted-foreground flex flex-wrap gap-6 border-t py-10 text-sm">
      <span>OT Gateway, MIT licensed</span>
      <Link href="/docs">Docs</Link>
      <Link href="/docs/vision">Vision</Link>
      <a href={site.repository}>GitHub</a>
    </footer>
  </main>
)

export default HomePage
