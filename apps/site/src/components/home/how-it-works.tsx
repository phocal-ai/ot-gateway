/**
 * What the gateway does and how it is used: create its folder, describe the site in one config file, start it and
 * use the data.
 * Each step has a small picture of what you see at that point; the names and values
 * match the rest of the home page (site-1, heat-pump, the 15-minute aggregate).
 */
import Link from "next/link"
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
      <Name>site-1</Name> <span className="text-fd-muted-foreground">a campus, a plant, a property</span>
    </>
  ],
  [
    "building",
    <>
      <Name>building-a</Name> <span className="text-fd-muted-foreground">a building or hall on it</span>
    </>
  ],
  [
    "device",
    <>
      <Name>heat-pump</Name> <span className="text-fd-muted-foreground">heat pump at 10.0.4.21, BACnet/IP</span>
    </>
  ],
  [
    "datapoint",
    <>
      <Name>flow-temp</Name> <span className="text-fd-muted-foreground">flow temperature, analog input 1, in °C</span>
    </>
  ],
  ["schedule", <span className="text-fd-muted-foreground">read every 30 s, send a 15-minute average</span>]
]

/** Step 3: a subscription to the site, and what arrives for the datapoint of step 2 (payloads shortened). */
const subscribeCommand = "mosquitto_sub -h broker.example.com -t 'site-1/#' -v"
const arrivals = [
  ["site-1/building-a/heat-pump/flow-temp/$meta", '{"name":"Heat pump flow temperature","unit":"unit:DEG_C",…}'],
  ["site-1/building-a/heat-pump/flow-temp", '{"value":35.38,"min":34.9,"max":35.8,"avg":35.38,…}']
] as const

/** `init` makes the folder; the files are what it writes (apps/gateway/src/Init.ts). */
const initCommand = "npx ot-gateway init site-1"

/** Commands (with their `$ ` prompt) and what they print, muted. */
const Terminal = ({ lines }: { readonly lines: ReadonlyArray<readonly [string, string]> }) => (
  <pre className="w-full font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
    <code>
      {lines.map(([prompt, text]) => (
        <span className={`block ${prompt === "" ? "text-fd-muted-foreground" : ""}`} key={text}>
          {prompt === "" ? null : <span className="text-fd-muted-foreground select-none">{prompt}</span>}
          {text}
        </span>
      ))}
    </code>
  </pre>
)

const steps: ReadonlyArray<{
  readonly title: string
  /** One or more paragraphs. */
  readonly text: ReadonlyArray<string>
  readonly picture: React.ReactNode
}> = [
  {
    title: "Create it",
    text: [
      "On any Linux machine on the site's network, from a server to a Raspberry Pi, init asks a few questions and writes the gateway's folder: the config and a Docker Compose file."
    ],
    picture: (
      <Terminal
        lines={[
          ["$ ", initCommand],
          ["", "wrote site-1/ot-gateway.json"],
          ["", "wrote site-1/compose.yaml"],
          ["", "wrote site-1/ot-gateway.env"]
        ]}
      />
    )
  },
  {
    title: "Describe your site",
    text: [
      "One config file describes your site: the devices, the datapoints to read, how often, and where the data goes. Write it by hand, or let an AI agent write it from your points list or datasheets.",
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
            <Name>site-1</Name>/<Name>building-a</Name>/<Name>heat-pump</Name>/<Name>flow-temp</Name>
          </p>
        </div>
      </div>
    )
  },
  {
    title: "Start it and subscribe",
    text: [
      "Start it, and the values arrive on your broker under the topics from step 2. Subscribe from any MQTT client, or connect your dashboards, energy reports and alerts.",
      "The status page on port 8080 shows every device and its latest values, and why one is failing."
    ],
    picture: (
      <pre className="w-full font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        <code>
          <span className="block">
            <span className="text-fd-muted-foreground select-none">$ </span>
            docker compose up -d
          </span>
          <span className="mt-1.5 block">
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
