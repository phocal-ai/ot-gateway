/**
 * What the gateway does and how it is used: install it, describe the building in one config file, use the data.
 * Each step has a small picture of what you see at that point; the names and values
 * match the rest of the home page (site-1, ahu-1, the 15-minute aggregate).
 */
import Link from "next/link"
import { InstallTabs } from "./install-tabs.tsx"
import type * as React from "react"

/** A name in the config that becomes a segment of the topic; highlighted the same way in both places. */
const Name = ({ children }: { readonly children: string }) => (
  <span className="font-mono text-[var(--series-1)]">{children}</span>
)

/** One device of the config: each name becomes a segment of the topic, the rest says what and where it is. */
const configLines: ReadonlyArray<readonly [string, React.ReactNode]> = [
  [
    "site",
    <>
      <Name>site-1</Name> <span className="text-fd-muted-foreground">Site 1</span>
    </>
  ],
  [
    "building",
    <>
      <Name>building-a</Name> <span className="text-fd-muted-foreground">building A</span>
    </>
  ],
  [
    "device",
    <>
      <Name>ahu-1</Name> <span className="text-fd-muted-foreground">air handler at 10.0.4.21, BACnet/IP</span>
    </>
  ],
  [
    "datapoint",
    <>
      <Name>supply-air-temp</Name> <span className="text-fd-muted-foreground">analog input 1, in °C</span>
    </>
  ],
  ["schedule", <span className="text-fd-muted-foreground">read every 30 s, send a 15-minute average</span>]
]

/** Step 3: a subscription to the site, and what arrives for the datapoint of step 2 (payloads shortened). */
const subscribeCommand = "mosquitto_sub -h broker.example.com -t 'site-1/#' -v"
const arrivals = [
  ["site-1/building-a/ahu-1/supply-air-temp/$meta", '{"name":"Supply air temperature","unit":"unit:DEG_C",…}'],
  ["site-1/building-a/ahu-1/supply-air-temp", '{"value":21.38,"min":20.9,"max":21.8,"avg":21.38,…}']
] as const

/** The demo from the README's quick start: a simulated building, the gateway and a test broker (hero and closing call). */
export const demoCommand = "docker run --rm -it -p 127.0.0.1:8080:8080 ghcr.io/phocal-ai/ot-gateway demo"

const steps: ReadonlyArray<{
  readonly title: string
  /** One or more paragraphs. */
  readonly text: ReadonlyArray<string>
  readonly picture: React.ReactNode
}> = [
  {
    title: "Install it",
    text: [
      "Install it on any Linux machine on the building network, from a server to a Raspberry Pi: as a container with Docker, or as a service without. It comes with a built-in web interface."
    ],
    picture: <InstallTabs />
  },
  {
    title: "Describe your building",
    text: [
      "One config file describes your building: the devices, the datapoints to read, how often, and where the data goes. Write it by hand, or let your AI assistant write it with you.",
      "Every site, building, device and datapoint gets a short name. Together the names make the MQTT topic, so you always know where a value comes from."
    ],
    picture: (
      <div className="w-full text-xs">
        <p className="text-fd-muted-foreground mb-2 font-mono">ot-gateway.json</p>
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5">
          {configLines.map(([key, value]) => (
            <div className="contents" key={key}>
              <dt className="text-fd-muted-foreground">{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 border-t pt-3">
          <p className="text-fd-muted-foreground mb-1">topic, built from the names</p>
          <p className="font-mono break-all">
            <Name>site-1</Name>/<Name>building-a</Name>/<Name>ahu-1</Name>/<Name>supply-air-temp</Name>
          </p>
        </div>
      </div>
    )
  },
  {
    title: "Subscribe to your data",
    text: [
      "Start it, and the values arrive on your broker under the topics from step 2. Subscribe from any MQTT client, or connect your dashboards, energy reports and alerts."
    ],
    picture: (
      <pre className="w-full font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        <code>
          <span className="block">
            <span className="text-fd-muted-foreground select-none">$ </span>
            {subscribeCommand}
          </span>
          {arrivals.map(([topic, payload]) => (
            <span className="mt-1.5 block" key={topic}>
              <span className="text-[var(--series-1)]">{topic}</span>{" "}
              <span className="text-fd-muted-foreground">{payload}</span>
            </span>
          ))}
        </code>
      </pre>
    )
  }
]

export const HowItWorks = () => (
  <div className="viz">
    <ol>
      {steps.map((step, index) => (
        <li className="grid grid-cols-[2rem_1fr] gap-x-4 md:grid-cols-[2rem_1fr_1fr] md:gap-x-10" key={step.title}>
          <div className="flex flex-col items-center">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-[var(--series-1)] text-sm font-semibold">
              {index + 1}
            </span>
            {index < steps.length - 1 ? <span aria-hidden="true" className="bg-fd-border w-px flex-1" /> : null}
          </div>
          <div className="min-w-0 pt-1 pb-8">
            <h3 className="mb-1 font-semibold">{step.title}</h3>
            {step.text.map((paragraph) => (
              <p className="text-fd-muted-foreground mt-2 text-sm first-of-type:mt-0" key={paragraph}>
                {paragraph}
              </p>
            ))}
          </div>
          <div className="col-start-2 min-w-0 pb-8 md:col-start-3">
            <div className="bg-fd-card flex min-h-24 items-center rounded-xl border p-4">{step.picture}</div>
          </div>
        </li>
      ))}
    </ol>
    <div className="grid grid-cols-[2rem_1fr] gap-x-4 md:gap-x-10">
      <p className="text-fd-muted-foreground col-start-2 text-sm">
        Every step in detail:{" "}
        <Link className="text-fd-foreground font-medium underline" href="/docs#quick-start">
          the quick start
        </Link>
        .
      </p>
    </div>
  </div>
)
