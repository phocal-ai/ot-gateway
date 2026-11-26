/**
 * The diagrams of the "Headless setup" page (docs/headless.md), in the home page's design: cards, numbered steps
 * and pipes. Each one says the same as the Mermaid block it stands for; keep the two in step.
 */
import {
  ArrowDown,
  ArrowRight,
  Check,
  CircleCheck,
  Container,
  Cpu,
  Globe,
  type LucideIcon,
  Radio,
  RotateCcw,
  SquareTerminal
} from "lucide-react"
import type * as React from "react"

/** The frame every diagram of the docs sits in; `not-prose` keeps the page's text styles out. */
const Figure = ({ label, children }: { readonly label: string; readonly children: React.ReactNode }) => (
  <figure aria-label={label} className="viz not-prose my-6">
    {children}
  </figure>
)

const Eyebrow = ({ children }: { readonly children: React.ReactNode }) => (
  <p className="text-fd-muted-foreground text-xs font-medium tracking-wide uppercase">{children}</p>
)

const Mono = ({ children }: { readonly children: React.ReactNode }) => (
  <code className="font-mono text-[0.8rem] font-medium">{children}</code>
)

/* The path */

interface Step {
  readonly number: number
  readonly command: string
  readonly does: string
  /** What the step says when it fails, and so what to fix before running it again. */
  readonly retry?: string
}

interface Phase {
  readonly title: string
  readonly note: string
  readonly steps: ReadonlyArray<Step>
}

const phases: ReadonlyArray<Phase> = [
  {
    title: "The list",
    note: "connects to nothing",
    steps: [
      { number: 1, command: "points schema", does: "learn the columns" },
      { number: 2, command: "points.csv", does: "write the list, or points.json" },
      { number: 3, command: "import --dry-run", does: "check every row", retry: "issues: line, column, value" }
    ]
  },
  {
    title: "The folder",
    note: "talks to the broker only",
    steps: [
      { number: 4, command: "init", does: "write the folder", retry: "missing: the flags to add" },
      { number: 5, command: "check", does: "validate the config", retry: "issues: path, message" },
      { number: 6, command: "broker", does: "a message there and back", retry: "code and hint" }
    ]
  },
  {
    title: "Running",
    note: "the gateway reads the devices",
    steps: [
      { number: 7, command: "docker compose up -d", does: "start it" },
      {
        number: 8,
        command: "watch --until-values",
        does: "wait for every point",
        retry: "missing: then status, events, logs"
      }
    ]
  }
]

const PhaseCard = ({ phase, last }: { readonly phase: Phase; readonly last: boolean }) => (
  <div className="bg-fd-card flex flex-col rounded-xl border p-4">
    <Eyebrow>{phase.title}</Eyebrow>
    <p className="text-fd-muted-foreground mt-1 mb-4 text-xs">{phase.note}</p>
    <ol className="flex-1">
      {phase.steps.map((step, index) => (
        <li className="grid grid-cols-[1.5rem_1fr] gap-x-3" key={step.number}>
          <div className="flex flex-col items-center">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-[var(--series-1)] text-xs font-semibold">
              {step.number}
            </span>
            {index < phase.steps.length - 1 ? <span aria-hidden="true" className="bg-fd-border w-px flex-1" /> : null}
          </div>
          <div className="min-w-0 pb-4">
            <p className="leading-6">
              <Mono>{step.command}</Mono>
            </p>
            <p className="text-fd-muted-foreground text-xs">{step.does}</p>
            {step.retry === undefined ? null : (
              <p className="text-fd-muted-foreground mt-1.5 flex items-start gap-1.5 text-xs">
                <RotateCcw aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-[var(--series-2)]" />
                <span>
                  <span className="sr-only">when it fails, fix and run it again: </span>
                  {step.retry}
                </span>
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
    {last ? (
      <p className="flex items-start gap-2 border-t pt-3 text-xs font-medium">
        <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0 text-[var(--status-good)]" />
        every point has a value on your broker
      </p>
    ) : null}
  </div>
)

/** An arrow from one phase to the next: across on wide screens, down on narrow ones. */
const Next = () => (
  <div
    aria-hidden="true"
    className="text-fd-muted-foreground flex items-center justify-center gap-1 py-2 text-xs lg:px-2 lg:py-0"
  >
    <span>ok</span>
    <ArrowRight className="size-4 max-lg:hidden" />
    <ArrowDown className="size-4 lg:hidden" />
  </div>
)

export const HeadlessPath = () => (
  <Figure label="The eight steps of a headless setup, in three phases">
    <div className="grid lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
      {phases.map((phase, index) => (
        <div className="contents" key={phase.title}>
          {index === 0 ? null : <Next />}
          <PhaseCard last={index === phases.length - 1} phase={phase} />
        </div>
      ))}
    </div>
    <figcaption className="text-fd-muted-foreground mt-3 flex items-center gap-1.5 text-xs">
      <RotateCcw aria-hidden="true" className="size-3 shrink-0 text-[var(--series-2)]" />
      what a failed step returns: fix that, run the step again
    </figcaption>
  </Figure>
)

/* Where everything runs */

interface Place {
  readonly icon: LucideIcon
  readonly title: string
  readonly detail: string
}

const Places = ({ title, places }: { readonly title: string; readonly places: ReadonlyArray<Place> }) => (
  <div className="bg-fd-card rounded-xl border p-4">
    <Eyebrow>{title}</Eyebrow>
    <ul className="mt-3 space-y-3">
      {places.map(({ icon: Icon, title: placeTitle, detail }) => (
        <li className="flex items-start gap-3" key={placeTitle}>
          <Icon aria-hidden="true" className="text-fd-muted-foreground mt-0.5 size-5 shrink-0" />
          <span className="text-sm">
            {placeTitle}
            <span className="text-fd-muted-foreground block text-xs">{detail}</span>
          </span>
        </li>
      ))}
    </ul>
  </div>
)

/** A connection between two columns, with what travels on it. */
const Link = ({ labels }: { readonly labels: ReadonlyArray<string> }) => (
  <div className="flex flex-col items-center justify-center gap-2 py-2 lg:px-3 lg:py-0">
    <div className="bg-fd-border relative h-8 w-px lg:h-px lg:w-12">
      <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--series-1)]" />
    </div>
    <ul className="text-fd-muted-foreground text-center font-mono text-[0.65rem] leading-tight">
      {labels.map((label) => (
        <li key={label}>{label}</li>
      ))}
    </ul>
  </div>
)

const reach: ReadonlyArray<{ readonly commands: string; readonly reaches: string }> = [
  { commands: "check, import --dry-run", reaches: "nothing: safe anywhere, any time" },
  { commands: "broker, watch", reaches: "your broker" },
  { commands: "status, events, logs, history, messages", reaches: "the running gateway, on its status port" }
]

export const HeadlessMap = () => (
  <Figure label="Where everything runs: your laptop, the box in the plant room, the devices and the broker">
    <div className="grid items-center lg:grid-cols-[1fr_auto_1.2fr_auto_1fr]">
      <Places
        places={[
          { icon: SquareTerminal, title: "You, a script or an AI agent", detail: "run the commands over SSH" },
          { icon: Globe, title: "Browser", detail: "the status page, through ssh -L 8080:127.0.0.1:8080" }
        ]}
        title="Your laptop"
      />
      <Link labels={["ssh"]} />
      <div className="rounded-xl border-2 border-[var(--series-1)] p-4">
        <Eyebrow>The box in the plant room</Eyebrow>
        <ul className="mt-3 space-y-3">
          <li className="flex items-start gap-3">
            <SquareTerminal aria-hidden="true" className="text-fd-muted-foreground mt-0.5 size-5 shrink-0" />
            <span className="text-sm">
              <Mono>ot-gateway</Mono>
              <span className="text-fd-muted-foreground block text-xs">the CLI: sets up, checks, diagnoses</span>
            </span>
          </li>
          <li className="flex items-start gap-3">
            <Container aria-hidden="true" className="text-fd-muted-foreground mt-0.5 size-5 shrink-0" />
            <span className="text-sm">
              The gateway
              <span className="text-fd-muted-foreground block text-xs">
                in Docker Compose, status page on 127.0.0.1:8080
              </span>
            </span>
          </li>
        </ul>
      </div>
      <Link labels={["reads", "publishes"]} />
      <Places
        places={[
          { icon: Cpu, title: "Devices", detail: "Modbus TCP and BACnet/IP" },
          { icon: Radio, title: "Your MQTT broker", detail: "where the values go" }
        ]}
        title="The site's network"
      />
    </div>
    <dl className="mt-4 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[auto_1fr]">
      <dt className="text-fd-muted-foreground col-span-full font-medium tracking-wide uppercase">
        What each command reaches
      </dt>
      {reach.map(({ commands, reaches }) => (
        <div className="contents" key={commands}>
          <dt className="font-mono">{commands}</dt>
          <dd className="text-fd-muted-foreground max-sm:mb-1">{reaches}</dd>
        </div>
      ))}
    </dl>
  </Figure>
)

/* When values are missing */

interface Branch {
  readonly says: string
  readonly means: string
  readonly fix: React.ReactNode
}

const branches: ReadonlyArray<Branch> = [
  {
    says: "code: gateway-unreachable",
    means: "The gateway is not running.",
    fix: (
      <>
        <Mono>docker compose up -d</Mono>, and <Mono>docker compose logs gateway</Mono> when it does not stay up
      </>
    )
  },
  {
    says: "broker.connected: false",
    means: "The gateway cannot reach the broker.",
    fix: (
      <>
        <Mono>ot-gateway broker --json</Mono> and step 6's table
      </>
    )
  },
  {
    says: "reason: connection",
    means: "A device does not accept the connection.",
    fix: "the address, the port or a firewall; or another program holds the device's only connection"
  },
  {
    says: "reason: timeout",
    means: "A device connects but does not answer.",
    fix: "often a wrong unit id"
  },
  {
    says: "reason: protocol",
    means: "A device refused the request.",
    fix: "often a wrong register or object"
  }
]

export const HeadlessFailures = () => (
  <Figure label="From a watch that fails to the cause, by what status says">
    <div className="bg-fd-card rounded-xl border">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b p-4 text-sm">
        <Mono>watch --until-values</Mono>
        <span className="text-fd-muted-foreground">exits with 1</span>
        <ArrowRight aria-hidden="true" className="text-fd-muted-foreground size-4" />
        <span className="text-fd-muted-foreground">run</span>
        <Mono>status --json</Mono>
        <span className="text-fd-muted-foreground">and find what it says:</span>
      </div>
      <ul className="divide-y">
        {branches.map((branch) => (
          <li className="grid gap-x-4 gap-y-1 p-4 sm:grid-cols-[14rem_1fr]" key={branch.says}>
            <p>
              <span className="inline-block rounded-md border border-[var(--status-critical)]/40 px-2 py-0.5 font-mono text-xs">
                {branch.says}
              </span>
            </p>
            <div className="text-sm">
              <p>{branch.means}</p>
              <p className="text-fd-muted-foreground mt-0.5 text-xs">{branch.fix}</p>
            </div>
          </li>
        ))}
        <li className="grid gap-x-4 gap-y-1 p-4 sm:grid-cols-[14rem_1fr]">
          <p>
            <span className="inline-flex items-center gap-1 rounded-md border border-[var(--status-good)]/50 px-2 py-0.5 font-mono text-xs">
              <Check aria-hidden="true" className="size-3 text-[var(--status-good)]" />
              ok: true
            </span>
          </p>
          <div className="text-sm">
            <p>Nothing is wrong.</p>
            <p className="text-fd-muted-foreground mt-0.5 text-xs">
              the silent points publish on change and have not changed yet
            </p>
          </div>
        </li>
      </ul>
    </div>
  </Figure>
)
