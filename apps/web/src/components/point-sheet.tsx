"use client"
/**
 * One point, in a panel from the right edge over the points list: its live value, its history over a chosen
 * range (refreshed while open) and what the config says about it. ↑/↓ (or j/k) step through the listed points
 * without closing it; Esc or a click beside it closes it. The list opens and closes it inside a view transition, in
 * which the panel (`point-sheet`) slides in and out.
 */
import type { PointInfo } from "@ot-gateway/api"
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { HistoryChart } from "@/components/history-chart"
import { ON_CHANGE_HINT, PointValue } from "@/components/point-value"
import { Badge } from "@/components/ui/badge"
import { alarmWhen, pointFreshness } from "@/lib/glance"
import { fetchHistory, type GatewayClock, gatewayTime, type PointHistory, type Range, ranges } from "@/lib/history"
import type { LivePoint } from "@/lib/points"
import { clockTime, failureLabel, freshness, settle, unitLabel } from "@/lib/status"

/** How often an open panel asks for history again: often for short ranges, rarely for a week of minutes. */
const refreshMs = (range: Range) => (range.ms <= 3_600_000 ? 5_000 : 60_000)

interface HistoryState {
  /** What the series below is of: `device/point@range`. */
  readonly of?: string
  readonly series?: PointHistory
  readonly unreachable?: string
}

/**
 * The point's history over `range`, refreshed while mounted. Stepping to another point or range keeps the last
 * chart on screen (dimmed, see `stale`) until the new one arrives, so the panel does not blank out on every step.
 * It asks in the gateway's time (`now`, from the last status), moved on by the monotonic clock between status polls:
 * the browser's clock can be far off a gateway without network time. A new `now` only updates the clock it reads;
 * it does not fetch again.
 */
const useHistory = (device: string, point: string, range: Range, now: number) => {
  const of = `${device}/${point}@${range.id}`
  const [history, setHistory] = useState<HistoryState>({})
  const clock = useRef<GatewayClock>({ now, at: performance.now() })
  useEffect(() => {
    clock.current = { now, at: performance.now() }
  }, [now])
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () =>
      settle(fetchHistory(device, point, range, gatewayTime(clock.current, performance.now()))).then((result) => {
        if (cancelled) return
        setHistory((previous) =>
          result._tag === "Success"
            ? { of, series: result.success }
            : { ...previous, unreachable: result.failure.message }
        )
        timer = setTimeout(() => void load(), refreshMs(range))
      })
    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [device, point, range, of])
  return { ...history, stale: history.of !== of }
}

/** One row of the facts list. */
const Fact = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 font-mono break-words">{children}</dd>
  </>
)

/** A topic with a button that copies it, for pasting into an MQTT client or a dashboard. */
const Topic = ({ topic }: { readonly topic: string }) => {
  const [copied, setCopied] = useState(false)
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="break-all">{topic}</span>
      <button
        className="rounded border px-1.5 py-0.5 font-sans text-xs text-muted-foreground hover:text-foreground"
        onClick={() => {
          void navigator.clipboard?.writeText(topic).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        type="button"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  )
}

const scalingLabel = (scaling: NonNullable<PointInfo["scaling"]>) =>
  `raw × ${scaling.factor}${scaling.offset === 0 ? "" : ` ${scaling.offset < 0 ? "−" : "+"} ${Math.abs(scaling.offset)}`}`

const iconButton = "rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"

export const PointSheet = ({
  point,
  live,
  now,
  position,
  morph,
  unreachable,
  onStep,
  onClose
}: {
  readonly point: PointInfo
  readonly live: LivePoint | undefined
  readonly now: number
  /** Where the point is in the listed points (1-based), when it is listed. */
  readonly position: { readonly index: number; readonly total: number } | undefined
  /** Opened by a view transition, which animates it; otherwise it slides in by itself. */
  readonly morph: boolean
  /** The gateway stopped answering: the value shown is the last one it gave. */
  readonly unreachable: boolean
  readonly onStep: (delta: 1 | -1) => void
  readonly onClose: () => void
}) => {
  const dialog = useRef<HTMLDialogElement>(null)
  const [range, setRange] = useState<Range>(ranges[1])
  const history = useHistory(point.device, point.id, range, now)
  const value = live?.value
  const device = live?.device
  const state = device === undefined ? undefined : freshness(device, now)
  const read = pointFreshness(point, { value, device }, now, unreachable)

  // A layout effect, so the dialog is open in the frame the view transition takes as its new state.
  useLayoutEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (!element.open) element.showModal()
    // The panel itself, not its first button: no focus ring on ↓ when it opens; ↑/↓ and Esc work from here.
    element.focus()
    return () => element.close()
  }, [])

  return (
    <dialog
      aria-label={`${point.device}/${point.id}`}
      className={`point-sheet ${morph ? "morphing" : ""} ms-auto me-0 my-0 h-dvh max-h-dvh w-[min(36rem,100vw)] max-w-full overflow-y-auto border-l bg-card p-0 outline-none text-card-foreground shadow-2xl`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement) return
        const delta =
          event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0
        if (delta === 0) return
        event.preventDefault()
        onStep(delta)
      }}
      ref={dialog}
      style={{ viewTransitionName: "point-sheet" }}
      tabIndex={-1}
    >
      <div className="flex flex-col gap-6 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-sm text-muted-foreground">{point.device}</p>
            <h2 className="w-fit font-mono text-lg font-semibold break-all">{point.id}</h2>
            <p className="text-sm text-muted-foreground">{point.name}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {position === undefined ? null : (
              <>
                <span className="mr-1 text-xs text-muted-foreground tabular-nums">
                  {position.index} of {position.total}
                </span>
                <button
                  aria-label="Previous point (↑ or k)"
                  className={iconButton}
                  disabled={position.index <= 1}
                  onClick={() => onStep(-1)}
                  title="Previous point (↑ or k)"
                  type="button"
                >
                  ↑
                </button>
                <button
                  aria-label="Next point (↓ or j)"
                  className={iconButton}
                  disabled={position.index >= position.total}
                  onClick={() => onStep(1)}
                  title="Next point (↓ or j)"
                  type="button"
                >
                  ↓
                </button>
              </>
            )}
            <button aria-label="Close (Esc)" className={iconButton} onClick={onClose} title="Close (Esc)" type="button">
              ✕
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <p className={`font-mono text-3xl font-semibold tabular-nums ${read._tag === "stale" ? "opacity-50" : ""}`}>
            <PointValue
              alarm={alarmWhen(point)}
              className="-mx-1"
              key={`${point.device}/${point.id}`}
              now={now}
              unit={point.unit}
              value={value}
            />
          </p>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {unreachable ? <Badge variant="destructive">gateway unreachable: last known value</Badge> : null}
            {state?._tag === "failing" ? (
              <Badge variant="destructive">device failing: {failureLabel(state.reason)}</Badge>
            ) : null}
            {state?._tag === "late" ? <Badge variant="warning">device late</Badge> : null}
            {point.writable ? <Badge variant="outline">writable</Badge> : null}
            {read._tag === "unchanged" ? (
              <span title={ON_CHANGE_HINT}>unchanged since {clockTime(read.ts, now)} (sent on change of value)</span>
            ) : (
              <span>{value?.ts === undefined ? "nothing read yet" : `read ${clockTime(value.ts, now)}`}</span>
            )}
          </div>
        </div>

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">History</h3>
            <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Range">
              {ranges.map((candidate) => (
                <button
                  aria-pressed={candidate.id === range.id}
                  className={`rounded px-2.5 py-1 text-xs ${
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
          </div>
          <div className={`transition-opacity duration-200 ${history.stale ? "opacity-40" : ""}`}>
            {history.series === undefined ? (
              <div className="h-[150px] animate-pulse rounded-md bg-muted" />
            ) : history.series._tag === "off" ? (
              <p className="flex h-[150px] items-center justify-center text-sm text-muted-foreground">
                {history.series.message}
              </p>
            ) : (
              <HistoryChart
                boolean={typeof value?.value === "boolean"}
                label={point.id}
                series={history.series.series}
                unit={point.unit}
              />
            )}
          </div>
          {history.unreachable === undefined ? null : (
            <p className="text-xs text-destructive" title={history.unreachable}>
              History is not updating: the gateway does not answer.
            </p>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Configuration</h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <Fact label="Topic">
              <Topic topic={point.topic} />
            </Fact>
            <Fact label="Source">{point.source}</Fact>
            <Fact label="Read">{point.read}</Fact>
            <Fact label="Publishes">{point.publish}</Fact>
            {point.unit === undefined ? null : (
              <Fact label="Unit">
                {unitLabel(point.unit)} <span className="text-muted-foreground">({point.unit})</span>
              </Fact>
            )}
            {point.scaling === undefined ? null : <Fact label="Scaling">{scalingLabel(point.scaling)}</Fact>}
            {point.limits === undefined ? null : (
              <Fact label="Write limits">
                {point.limits.min} to {point.limits.max}
              </Fact>
            )}
            {point.brick === undefined ? null : <Fact label="Brick">{point.brick}</Fact>}
            {point.haystack === undefined || point.haystack.length === 0 ? null : (
              <Fact label="Haystack">
                <span className="flex flex-wrap gap-1">
                  {point.haystack.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                </span>
              </Fact>
            )}
          </dl>
        </section>
      </div>
    </dialog>
  )
}
