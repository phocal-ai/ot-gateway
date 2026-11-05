"use client"
/**
 * A device, opened from its card: every point with its current value and its history over a chosen range. The
 * current values follow the page's status poll; the history is fetched when the dialog opens and again every few
 * seconds while it stays open, so the charts grow live.
 */
import type { DeviceStatus } from "@ot-gateway/api"
import { Effect } from "effect"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { HistoryChart } from "@/components/history-chart"
import { fetchHistory, type PointHistory, type Range, ranges } from "@/lib/history"
import { formatValue, unitLabel } from "@/lib/status"

/** How often an open dialog asks for history again: often for short ranges, rarely for a week of minutes. */
const refreshMs = (range: Range) => (range.ms <= 3_600_000 ? 5_000 : 60_000)

/** The latest histories that arrived (kept while the gateway does not answer), and why the last fetch failed. */
interface Histories {
  readonly points?: ReadonlyMap<string, PointHistory>
  readonly unreachable?: string
}

/** The history of every point of a device over `range`, refreshed while mounted. */
const useHistories = (device: DeviceStatus, range: Range) => {
  const [histories, setHistories] = useState<Histories>({})
  const pointIds = device.points.map((point) => point.id).join(",")
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setHistories({})
    const ids = pointIds.split(",").filter((id) => id !== "")
    const load = () =>
      Effect.runPromise(
        Effect.result(
          Effect.forEach(
            ids,
            (id) => fetchHistory(device.id, id, range, Date.now()).pipe(Effect.map((h) => [id, h] as const)),
            {
              concurrency: 4
            }
          )
        )
      ).then((result) => {
        if (cancelled) return
        setHistories((previous) =>
          result._tag === "Success"
            ? { points: new Map(result.success) }
            : {
                ...(previous.points === undefined ? {} : { points: previous.points }),
                unreachable: result.failure.message
              }
        )
        timer = setTimeout(() => void load(), refreshMs(range))
      })
    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [device.id, pointIds, range])
  return histories
}

const PointPanel = ({
  point,
  history
}: {
  readonly point: DeviceStatus["points"][number]
  readonly history: PointHistory | undefined
}) => {
  const boolean = typeof point.value === "boolean"
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-mono text-sm">{point.id}</h3>
          <p className="truncate text-xs text-muted-foreground">{point.name}</p>
        </div>
        <p className="shrink-0 font-mono text-2xl font-semibold tabular-nums">
          {formatValue(point.value)}{" "}
          <span className="text-sm font-normal text-muted-foreground">{unitLabel(point.unit)}</span>
        </p>
      </div>
      {history === undefined ? (
        <div className="h-[150px] animate-pulse rounded-md bg-muted" />
      ) : history._tag === "off" ? (
        <p className="flex h-[150px] items-center justify-center text-sm text-muted-foreground">{history.message}</p>
      ) : (
        <>
          <HistoryChart boolean={boolean} label={point.id} series={history.series} unit={point.unit} />
          {history.series.buckets.length === 0 ? null : (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Table</summary>
              <div className="mt-2 max-h-48 overflow-y-auto">
                <table className="w-full tabular-nums">
                  <thead className="sticky top-0 bg-card text-muted-foreground">
                    <tr>
                      <th className="text-left font-normal">Time</th>
                      <th className="text-right font-normal">Avg</th>
                      <th className="text-right font-normal">Min</th>
                      <th className="text-right font-normal">Max</th>
                      <th className="text-right font-normal">Reads</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {history.series.buckets.toReversed().map((bucket) => (
                      <tr key={bucket.t}>
                        <td>{new Date(bucket.t).toLocaleString([], { dateStyle: "short", timeStyle: "medium" })}</td>
                        <td className="text-right">{Number(bucket.avg.toPrecision(4))}</td>
                        <td className="text-right">{Number(bucket.min.toPrecision(4))}</td>
                        <td className="text-right">{Number(bucket.max.toPrecision(4))}</td>
                        <td className="text-right">{bucket.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  )
}

/**
 * The dialog, modal: Esc, the close button and a click outside close it. `onClose` runs the closing transition;
 * the parent unmounts the dialog. `header` is the card's header, so the morph keeps the title in place.
 */
export const DeviceDialog = ({
  device,
  header,
  transitionName,
  morph,
  onClose
}: {
  readonly device: DeviceStatus
  readonly header: ReactNode
  readonly transitionName: string
  /** Opened by a view transition, which animates it; otherwise it fades in by itself. */
  readonly morph: boolean
  readonly onClose: () => void
}) => {
  const dialog = useRef<HTMLDialogElement>(null)
  const [range, setRange] = useState<Range>(ranges[1])
  const histories = useHistories(device, range)
  // Only buckets of more than one read have a range to show.
  const banded = [...(histories.points?.values() ?? [])].some(
    (history) => history._tag === "series" && history.series.buckets.some((bucket) => bucket.count > 1)
  )

  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (!element.open) element.showModal()
    return () => element.close()
  }, [])

  return (
    <dialog
      aria-label={`${device.id}: values and history`}
      className={`device-dialog ${morph ? "morphing" : ""} m-auto max-h-[calc(100dvh-2rem)] w-[min(64rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border bg-card p-0 text-card-foreground shadow-2xl`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      ref={dialog}
      style={{ viewTransitionName: transitionName }}
    >
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">{header}</div>
          <button
            aria-label="Close"
            className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Range">
            {ranges.map((candidate) => (
              <button
                aria-pressed={candidate.id === range.id}
                className={`rounded px-3 py-1 text-sm ${
                  candidate.id === range.id ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"
                }`}
                key={candidate.id}
                onClick={() => setRange(candidate)}
                type="button"
              >
                {candidate.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {histories.unreachable !== undefined
              ? `history not reachable: ${histories.unreachable}`
              : banded
                ? "line: average · band: lowest to highest read"
                : "every read"}
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {device.points.map((point) => (
            <PointPanel history={histories.points?.get(point.id)} key={point.id} point={point} />
          ))}
        </div>
      </div>
    </dialog>
  )
}
