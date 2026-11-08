/**
 * "Who it is for": the people around one site, from whoever owns many of them to IT, in a grid of wide and narrow
 * tiles. Each tile has a small picture of what that reader sees, a statement (the lead in the foreground colour, the
 * rest muted) and a link to where they start. High level on purpose: the details are in the sections around it.
 */
import { ArrowRight } from "lucide-react"
import Link from "next/link"
import type * as React from "react"

/** Three devices as the status page shows them: two ok, one failing with its reason. */
const DeviceList = () => (
  <ul className="bg-fd-card w-full max-w-md divide-y rounded-lg border text-xs">
    {(
      [
        ["main-meter", "Modbus TCP", undefined],
        ["ahu-1", "BACnet/IP", undefined],
        ["ahu-2", "BACnet/IP", "timeout"]
      ] as const
    ).map(([id, protocol, failing]) => (
      <li className="flex items-center gap-3 px-3 py-2" key={id}>
        <span className="font-mono">{id}</span>
        <span className="text-fd-muted-foreground">{protocol}</span>
        <span
          className={`ml-auto rounded-md px-1.5 py-0.5 text-[0.65rem] leading-none font-medium text-white ${
            failing === undefined ? "bg-[var(--status-good)]" : "bg-[var(--status-critical)]"
          }`}
        >
          {failing ?? "ok"}
        </span>
      </li>
    ))}
  </ul>
)

/** A day of 15-minute energy, as a strip of bars: a shape, not data, so it carries no axis. */
const loadShape = [3, 3, 3, 3, 3, 4, 6, 9, 12, 13, 13, 12, 11, 12, 13, 13, 12, 11, 9, 7, 5, 4, 3, 3] as const

const EnergyBars = () => (
  <div aria-hidden="true" className="flex h-20 w-full max-w-xs items-end gap-[2px]">
    {loadShape.map((height, index) => (
      <span
        className="bg-fd-muted-foreground/40 flex-1 rounded-t-[2px]"
        key={index}
        style={{ height: `${(height / 13) * 100}%` }}
      />
    ))}
  </div>
)

/** One message as it reaches the broker (docs/how-it-works.md). */
const Message = () => (
  <pre className="bg-fd-card w-full overflow-x-auto rounded-lg border p-3 text-[0.7rem] leading-relaxed">
    <span className="text-fd-muted-foreground">site-1/building-a/ahu-1/supply-air-temp</span>
    {"\n"}
    {`{"value":21.5,"unit":"unit:DEG_C",`}
    {"\n"}
    {` "ts":1793631666939}`}
  </pre>
)

/** Starting it, as the install docs have it. */
const Terminal = () => (
  <pre className="bg-fd-card w-full max-w-md overflow-x-auto rounded-lg border p-3 text-[0.7rem] leading-relaxed">
    <span className="text-fd-muted-foreground">$</span> docker compose up -d
    {"\n"}
    <span className="text-[var(--status-good)]">✔</span> Container ot-gateway{"  "}
    <span className="text-fd-muted-foreground">Started</span>
  </pre>
)

type Tile = {
  readonly who: string
  readonly lead: string
  readonly rest: string
  readonly picture: React.ReactNode
  readonly link: readonly [string, string]
  readonly wide: boolean
}

const tiles: ReadonlyArray<Tile> = [
  {
    who: "Operators of many sites",
    lead: "Every site's data, in one shape.",
    rest: "Buildings, plant rooms or process lines: one small gateway per site reads the controllers already there and sends standard MQTT, for a fraction of what an industrial controller costs.",
    picture: <Message />,
    link: ["Get started", "/docs"],
    wide: true
  },
  {
    who: "Integrators and technicians",
    lead: "Set up and debugged with your AI assistant.",
    rest: "It finds the devices, writes the config and checks it. When one fails, the status page says which and why.",
    picture: <DeviceList />,
    link: ["Your first site", "/docs/first-building"],
    wide: false
  },
  {
    who: "Data and platform teams",
    lead: "Data you can build on.",
    rest: "Names, units and a description on every point, live or as aggregates, with no gaps when the line drops.",
    picture: <EnergyBars />,
    link: ["The message format", "/docs/how-it-works"],
    wide: false
  },
  {
    who: "IT and security",
    lead: "Fits a segmented network.",
    rest: "One container in its own VLAN, wherever Docker runs, for example on a Raspberry Pi. MQTT over TLS, read-only unless you allow writes, and open code you can audit.",
    picture: <Terminal />,
    link: ["Run it", "/docs/operations"],
    wide: true
  }
]

const TileLink = ({ label, href }: { readonly label: string; readonly href: string }) => {
  const className = "group mt-5 inline-flex items-center gap-1.5 text-sm font-medium"
  const content = (
    <>
      {label}
      <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
    </>
  )
  return href.startsWith("/") ? (
    <Link className={className} href={href}>
      {content}
    </Link>
  ) : (
    <a className={className} href={href}>
      {content}
    </a>
  )
}

export const Audiences = () => (
  <div className="viz bg-fd-border grid gap-px md:grid-cols-3">
    {tiles.map(({ who, lead, rest, picture, link: [label, href], wide }) => (
      <div className={`bg-fd-background flex flex-col p-6 md:p-8 ${wide ? "md:col-span-2" : ""}`} key={who}>
        <div className="flex min-h-36 items-center">{picture}</div>
        <h3 className="text-fd-muted-foreground mt-8 text-xs font-medium tracking-wide uppercase">{who}</h3>
        <p className="text-fd-muted-foreground mt-2 text-lg leading-snug">
          <span className="text-fd-foreground font-medium">{lead}</span> {rest}
        </p>
        <TileLink href={href} label={label} />
      </div>
    ))}
  </div>
)
