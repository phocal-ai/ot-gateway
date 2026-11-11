"use client"
/**
 * The header every page shares: the gateway's name and where it runs, the pages, and the Live badge.
 */
import Link from "next/link"
import { LiveBadge, type Load, statusOf } from "@/components/live"
import { formatNumber } from "@/lib/format"
import { since } from "@/lib/status"

const pages = [
  { href: "/", label: "Status" },
  { href: "/points/", label: "Points" },
  { href: "/messages/", label: "Messages" },
  { href: "/settings/", label: "Settings" }
] as const

export type PageId = (typeof pages)[number]["label"]

/** The tab a path belongs to: `/points/?device=x` is Points, anything unknown the Status overview. */
export const pageOf = (pathname: string): PageId =>
  pages.find((page) => page.href !== "/" && pathname.startsWith(page.href.slice(0, -1)))?.label ?? "Status"

/** A list's size for the header: "250 of 10,000 points". */
export interface ListCount {
  readonly total: number
  /** How many the page's filter leaves, when it filters. */
  readonly matching: number | undefined
  readonly noun: "point" | "topic"
}

export const PageHeader = ({
  load,
  current,
  count
}: {
  readonly load: Load
  readonly current: PageId
  /** The size of the page's list, at the right end of the tabs; pages without a list leave it out. */
  readonly count: ListCount | undefined
}) => {
  const status = statusOf(load)
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">OT Gateway</h1>
          {status === undefined ? null : (
            <p className="text-sm text-muted-foreground">
              {status.site} / {status.building} · gateway {status.id}
              {status.host === undefined ? "" : ` · version ${status.host.version}`} · up{" "}
              {since(status.since, status.now)}
            </p>
          )}
        </div>
        <LiveBadge load={load} />
      </div>
      <nav aria-label="Pages" className="flex gap-1 border-b">
        {pages.map((page) => (
          <Link
            aria-current={page.label === current ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              page.label === current
                ? "border-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            href={page.href}
            key={page.href}
          >
            {page.label}
          </Link>
        ))}
        {count === undefined ? null : (
          <span aria-live="polite" className="ml-auto self-center text-sm text-muted-foreground tabular-nums">
            {count.matching === undefined ? "" : `${formatNumber(count.matching)} of `}
            {formatNumber(count.total)} {count.total === 1 ? count.noun : `${count.noun}s`}
          </span>
        )}
      </nav>
    </header>
  )
}
