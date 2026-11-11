"use client"

/**
 * The points page: every configured point in one list, to find one by what it is called, where it is read or what
 * it means (Brick, Haystack), with its live value and its device's health. A click opens the point in a panel with
 * its history and configuration.
 * Read-only. The catalog (`/api/points`) is asked for once; values follow the shared status poll. The filter and
 * the open point live in the URL, so a view can be linked.
 */
import type { DeviceStatus, PointInfo } from "@ot-gateway/api"
import { useSearchParams } from "next/navigation"
import { type KeyboardEvent, type MouseEvent, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { useCatalog } from "@/components/catalog"
import { useGateway, useListCount } from "@/components/gateway-shell"
import { statusOf, useValues } from "@/components/live"
import { NoDevicesYet } from "@/components/no-devices"
import { PointSheet } from "@/components/point-sheet"
import { PointRead, PointValue } from "@/components/point-value"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatNumber } from "@/lib/format"
import {
  devicesById,
  devicesOf,
  filterFromSearch,
  filterToSearch,
  type LivePoint,
  matches,
  type PointFilter,
  pointKey,
  pointTitle
} from "@/lib/points"
import { alarmWhen, pointFreshness, readsOnChange } from "@/lib/glance"
import { failureLabel, type Freshness, freshness, protocolName } from "@/lib/status"
import { canMorph, withTransition } from "@/lib/transition"
import { useWindowRows } from "@/lib/virtual"

/** A row's height before the first one is measured (`h-14` and its border): spacers are sized from it. */
const ROW_HEIGHT = 57

/** The filter and the open point: from the URL (a link, or the status page's device rows), written back on change. */
const useUrlState = () => {
  const params = useSearchParams()
  const search = params.toString()
  const [state, setState] = useState(() => filterFromSearch(search))
  // A link to this page while it is open (the Points tab, a device row) changes the URL under it: follow it.
  useEffect(() => {
    setState((current) =>
      filterToSearch(current.filter, current.open).slice(1) === search ? current : filterFromSearch(search)
    )
  }, [search])
  const update = (next: { readonly filter: PointFilter; readonly open?: string }) => {
    setState(next)
    window.history.replaceState(null, "", `${window.location.pathname}${filterToSearch(next.filter, next.open)}`)
  }
  return [state, update] as const
}

const healthDot = {
  live: "bg-success",
  starting: "bg-muted-foreground/40",
  late: "bg-warning",
  failing: "bg-destructive"
} as const

const healthLabel = (state: Freshness) =>
  state._tag === "live"
    ? "device answering"
    : state._tag === "starting"
      ? "device starting"
      : state._tag === "late"
        ? "device late: no answer for a few intervals"
        : `device failing: ${failureLabel(state.reason)}`

/** A device's health, as a dot with its reason on hover; grey until the first status. */
const HealthDot = ({ device, now }: { readonly device: DeviceStatus | undefined; readonly now: number }) => {
  if (device === undefined) return <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-muted" />
  const state = freshness(device, now)
  return (
    <span
      aria-label={healthLabel(state)}
      className={`size-2 shrink-0 rounded-full ${healthDot[state._tag]}`}
      role="img"
      title={healthLabel(state)}
    />
  )
}

const pointCount = (count: number) => `${formatNumber(count)} ${count === 1 ? "point" : "points"}`

const PointsList = () => {
  const load = useGateway()
  const catalogLoad = useCatalog(statusOf(load)?.configSince)
  const [{ filter: asked, open }, setUrlState] = useUrlState()
  const [morph, setMorph] = useState(false)
  const status = statusOf(load)
  const unreachable = load._tag === "unreachable"
  const deviceHealth = useMemo(() => devicesById(status), [status])
  const catalog = catalogLoad._tag === "ok" ? catalogLoad.catalog : undefined
  const now = status?.now ?? Date.now()
  const devices = useMemo(() => (catalog === undefined ? [] : devicesOf(catalog)), [catalog])
  // A link to a device the config no longer has (renamed, removed) shows every device rather than nothing.
  const filter = useMemo(
    () =>
      asked.device === "" || devices.some((device) => device.id === asked.device) ? asked : { ...asked, device: "" },
    [asked, devices]
  )
  const filtered = filter.query !== "" || filter.device !== ""
  const deviceOptions = useMemo((): ReadonlyArray<ComboboxOption> => {
    const total = devices.reduce((sum, device) => sum + device.points, 0)
    return [
      { value: "", label: "All devices", detail: pointCount(total) },
      ...devices.map((device) => {
        const health = deviceHealth.get(device.id)
        return {
          value: device.id,
          label: device.id,
          detail: pointCount(device.points),
          leading: <HealthDot device={health} now={now} />,
          ...(health === undefined ? {} : { keywords: protocolName[health.protocol] })
        }
      })
    ]
  }, [devices, deviceHealth, now])
  const found = useMemo(
    () => (catalog === undefined ? [] : catalog.points.filter((point) => matches(point, filter))),
    [catalog, filter]
  )
  useListCount(catalog?.points.length, filtered ? found.length : undefined, "point")
  const opened = open === undefined ? undefined : catalog?.points.find((point) => pointKey(point) === open)
  const openedIndex = opened === undefined ? -1 : found.indexOf(opened)
  const { body, range, rowHeight, reveal } = useWindowRows(found.length, ROW_HEIGHT)
  const rows = found.slice(range.start, range.end)
  // Values only for the rows drawn and the open point: not every point's, every poll.
  const readings = useValues(
    useMemo(() => [...rows.map(pointKey), ...(open === undefined ? [] : [open])], [rows, open])
  )
  const live = (point: PointInfo): LivePoint => ({
    value: readings.get(pointKey(point)),
    device: deviceHealth.get(point.device)
  })

  // The row to focus once it is drawn: after the panel closes, or ↑/↓ moved past the drawn rows.
  const focusRow = useRef<number | undefined>(undefined)
  const focusPending = () => {
    if (focusRow.current === undefined) return
    const row = body.current?.querySelector<HTMLElement>(`[data-row="${focusRow.current}"]`)
    if (row === null || row === undefined) return
    row.focus({ preventScroll: true })
    focusRow.current = undefined
  }
  useEffect(focusPending)
  const focusIndex = (index: number) => {
    focusRow.current = index
    reveal(index)
    focusPending()
  }

  const setFilter = (next: Partial<PointFilter>) => {
    setUrlState({ filter: { ...filter, ...next }, ...(open === undefined ? {} : { open }) })
  }
  const setOpen = (key: string | undefined) => setUrlState({ filter, ...(key === undefined ? {} : { open: key }) })

  /** Open a point: the panel slides in (a view transition where the browser has them). */
  const openPoint = (key: string) => {
    setMorph(canMorph())
    withTransition(() => setOpen(key))
  }

  /**
   * Close the panel: it slides out, and focus lands on the row of the point it showed, not on the one that opened
   * it, so the keyboard carries on from the point last seen.
   */
  const closePoint = () => {
    const index = openedIndex
    withTransition(() => setOpen(undefined), {
      updated: () => {
        if (index >= 0) focusIndex(index)
      }
    })
  }

  /** The next or previous listed point, in the open panel, without a transition: stepping should feel instant. */
  const step = (delta: 1 | -1) => {
    const next = found[openedIndex + delta]
    if (next === undefined) return
    setOpen(pointKey(next))
    reveal(openedIndex + delta)
  }

  /** A row opens its point on a click, Enter or Space; ↑/↓ (Home/End) move between rows, drawn or not. */
  const onRow = (key: string, index: number) => ({
    onClick: (event: MouseEvent) => {
      if (event.metaKey || event.ctrlKey) return
      openPoint(key)
    },
    onKeyDown: (event: KeyboardEvent) => {
      const target =
        event.key === "ArrowDown"
          ? index + 1
          : event.key === "ArrowUp"
            ? index - 1
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? found.length - 1
                : undefined
      if (target !== undefined) {
        event.preventDefault()
        focusIndex(Math.min(Math.max(target, 0), found.length - 1))
        return
      }
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      openPoint(key)
    }
  })

  if (catalog === undefined)
    return (
      <p className="text-muted-foreground">
        {catalogLoad._tag === "failed" ? `The gateway does not answer: ${catalogLoad.message}` : "Loading…"}
      </p>
    )
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 basis-64">
          <input
            aria-label="Search points"
            // The browser's own clear button is hidden for the Reset beside it, in the page's colours.
            className={`h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:appearance-none ${filter.query === "" ? "" : "pr-20"}`}
            onChange={(event) => setFilter({ query: event.target.value })}
            placeholder="Search by id, name, topic, register, Brick class…"
            type="search"
            value={filter.query}
          />
          {filter.query === "" ? null : (
            <button
              className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-muted"
              onClick={() => setFilter({ query: "" })}
              type="button"
            >
              <span aria-hidden="true">✕</span>
              Reset
            </button>
          )}
        </div>
        <Combobox
          className="w-full sm:w-56"
          emptyText="No device found."
          label="Device"
          onChange={(device) => setFilter({ device })}
          options={deviceOptions}
          searchPlaceholder="Search devices…"
          value={filter.device}
        />
      </div>
      <Card className="py-0">
        <CardContent className="px-0">
          {found.length === 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 p-6 text-sm text-muted-foreground">
              {catalog.points.length === 0 ? <NoDevicesYet /> : <p>No point matches.</p>}
              {filtered ? (
                <button
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                  onClick={() => setFilter({ query: "", device: "" })}
                  type="button"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : (
            <Table
              aria-rowcount={found.length + 1}
              // Clipped, not scrolled: the header sticks to the window, and the card's corners stay round.
              containerClassName="overflow-clip rounded-xl"
            >
              {/* Sticks to the window's top, so a long list keeps its column names; its line is a shadow, as a
                  table border would scroll away under it. */}
              <TableHeader className="sticky top-0 z-10 [&_th]:bg-card [&_th]:shadow-[inset_0_-1px_0_var(--border)] [&_tr]:border-0">
                <TableRow aria-rowindex={1} className="hover:bg-transparent">
                  <TableHead className="pl-4">Point</TableHead>
                  <TableHead className="hidden md:table-cell">Device</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Read</TableHead>
                  <TableHead className="hidden md:table-cell">Source</TableHead>
                  <TableHead className="hidden pr-4 lg:table-cell">Publishes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody ref={body}>
                {range.start === 0 ? null : <tr aria-hidden="true" style={{ height: range.start * rowHeight }} />}
                {rows.map((point, offset) => {
                  const index = range.start + offset
                  const key = pointKey(point)
                  const current = live(point)
                  const read = pointFreshness(point, current, now, unreachable)
                  return (
                    <TableRow
                      aria-rowindex={index + 2}
                      aria-selected={key === open}
                      className="h-14 cursor-pointer aria-selected:bg-muted"
                      data-row={index}
                      key={key}
                      tabIndex={0}
                      {...onRow(key, index)}
                    >
                      <TableCell className="max-w-52 pl-4 sm:max-w-72">
                        <div className="flex items-center gap-2">
                          <HealthDot device={current?.device} now={now} />
                          <span className="truncate" title={pointTitle(point)}>
                            {pointTitle(point)}
                          </span>
                          {point.writable ? <Badge variant="outline">writable</Badge> : null}
                        </div>
                        <p className="truncate pl-4 text-xs text-muted-foreground" title={key}>
                          <span className="font-mono">
                            <span className="md:hidden">{point.device}/</span>
                            {point.id}
                          </span>
                          {point.brick === undefined ? "" : ` · ${point.brick}`}
                        </p>
                      </TableCell>
                      <TableCell className="hidden max-w-48 truncate font-mono text-muted-foreground md:table-cell">
                        <span title={point.device}>{point.device}</span>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        <PointValue
                          alarm={alarmWhen(point)}
                          now={now}
                          stale={read._tag === "stale"}
                          onChange={readsOnChange(point)}
                          unit={point.unit}
                          value={current.value}
                        />
                      </TableCell>
                      <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                        <PointRead now={now} short state={read} />
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                        {point.source}
                      </TableCell>
                      <TableCell className="hidden pr-4 text-xs text-muted-foreground lg:table-cell">
                        {point.publish}
                      </TableCell>
                    </TableRow>
                  )
                })}
                {range.end === found.length ? null : (
                  <tr aria-hidden="true" style={{ height: (found.length - range.end) * rowHeight }} />
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {opened === undefined ? null : (
        <PointSheet
          live={live(opened)}
          morph={morph}
          now={now}
          onClose={closePoint}
          onStep={step}
          point={opened}
          since={status?.since}
          unreachable={unreachable}
          position={openedIndex < 0 ? undefined : { index: openedIndex + 1, total: found.length }}
        />
      )}
    </>
  )
}

/** `useSearchParams` needs a Suspense boundary in a static export: the prerendered page shows its fallback. */
const PointsPage = () => (
  <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
    <PointsList />
  </Suspense>
)

export default PointsPage
