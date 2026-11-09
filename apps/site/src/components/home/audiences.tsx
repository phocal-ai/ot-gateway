/**
 * "Who it is for": the people around one site, from whoever owns many of them to IT, in a grid of wide and narrow
 * tiles. Each tile has a label, a lead and muted body text in the same sizes as the "How it works" steps, and a link
 * to where that reader starts. High level on purpose: the details are in the sections
 * around it.
 */
import { ArrowRight } from "lucide-react"
import Link from "next/link"

type Tile = {
  readonly who: string
  readonly lead: string
  readonly rest: string
  readonly link: readonly [string, string]
  readonly wide: boolean
}

const tiles: ReadonlyArray<Tile> = [
  {
    who: "Operators of many sites",
    lead: "Every site's data, in one shape.",
    rest: "Buildings, plant rooms or process lines: one small gateway per site reads the controllers already there and sends standard MQTT, for a fraction of what an industrial controller costs.",
    link: ["Get started", "/docs"],
    wide: true
  },
  {
    who: "Integrators and technicians",
    lead: "Set up and debugged with your AI agent.",
    rest: "It finds the devices, writes the config and checks it. When one fails, the status page says which and why.",
    link: ["Your first site", "/docs/first-building"],
    wide: false
  },
  {
    who: "Data and platform teams",
    lead: "Data you can build on.",
    rest: "Names, units and a description on every point, live or as aggregates, with no gaps when the line drops.",
    link: ["The message format", "/docs/how-it-works"],
    wide: false
  },
  {
    who: "IT and security",
    lead: "Fits a segmented network.",
    rest: "One container in its own VLAN, wherever Docker runs, for example on a Raspberry Pi. MQTT over TLS, read-only unless you allow writes, and open code you can audit.",
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
    {tiles.map(({ who, lead, rest, link: [label, href], wide }) => (
      <div className={`bg-fd-background flex flex-col p-6 md:p-8 ${wide ? "md:col-span-2" : ""}`} key={who}>
        <h3 className="text-fd-muted-foreground text-xs font-medium tracking-wide uppercase">{who}</h3>
        <p className="mt-2 font-semibold">{lead}</p>
        <p className="text-fd-muted-foreground mt-1 text-sm">{rest}</p>
        <TileLink href={href} label={label} />
      </div>
    ))}
  </div>
)
