"use client"
/**
 * One device, in a panel from the right edge over the Status tab: where it is, whether it answers and since when,
 * why not and what to check (Hints.ts in @ot-gateway/api, shared with ot-gateway status), its first points with their values, and what happened to it lately
 * (`/api/events`). ↑/↓ (or j/k) step through the listed devices without closing it; Esc or a click beside it closes
 * it. It shares the point panel's look and its slide (`point-sheet`).
 */
import type { DeviceStatus, PointInfo, PointReading } from "@ot-gateway/api"
import Link from "next/link"
import { useLayoutEffect, useRef } from "react"
import { ON_CHANGE_HINT, PointRead, PointValue } from "@/components/point-value"
import { Badge } from "@/components/ui/badge"
import { formatNumber } from "@/lib/format"
import {
  eventDetail,
  eventDetailTitle,
  eventNote,
  eventSentence,
  eventTone,
  type PageEvent,
  type SharedFailure
} from "@/lib/events"
import { alarmWhen, pointFreshness, readsOnChange } from "@/lib/glance"
import { whatToCheck } from "@ot-gateway/api"
import { filterToSearch, pointKey } from "@/lib/points"
import { clockTime, every, failingSinceText, failureLabel, freshness, protocolName, sinceClock } from "@/lib/status"

/** Points the panel lists before "All n points of this device". */
export const SHEET_POINTS = 12

const iconButton = "rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"

const toneDot = {
  bad: "bg-destructive",
  warning: "bg-warning",
  good: "bg-success",
  neutral: "bg-muted-foreground/40"
} as const

/** Capitalized, for a headline: "No data since 18:33:03 (3 min)". */
const headline = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** Whether it answers, and since when, in one headline and a line under it. */
const Health = ({ device, now }: { readonly device: DeviceStatus; readonly now: number }) => {
  const state = freshness(device, now)
  const read = `Read ${every(device.pollIntervalMs)}`
  const lastRead =
    device.lastSuccess === undefined ? "no answer yet" : `last answer ${clockTime(device.lastSuccess, now)}`
  switch (state._tag) {
    case "live":
      return (
        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            <Badge variant="success">ok</Badge> Answering
          </p>
          <p className="text-sm text-muted-foreground">
            {read}, {lastRead}.
          </p>
        </div>
      )
    case "starting":
      return (
        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            <Badge variant="secondary">starting</Badge> Not read yet
          </p>
          <p className="text-sm text-muted-foreground">{read}; the first read is on its way.</p>
        </div>
      )
    case "late":
      return (
        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            <Badge variant="warning">late</Badge>
            {state.lastSuccess === undefined
              ? "No answer yet"
              : `No answer since ${sinceClock(state.lastSuccess, now)}`}
          </p>
          <p className="text-sm text-muted-foreground">
            {read}. The gateway has not marked it failing: a read is taking longer than usual.
          </p>
        </div>
      )
    case "failing":
      return (
        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2 text-xl font-semibold text-destructive">
            <Badge variant="destructive">{failureLabel(state.reason)}</Badge>
            {headline(failingSinceText(device, now) ?? "failing")}
          </p>
          <p className="text-sm text-muted-foreground">
            {read}
            {device.lastSuccess !== undefined && device.failingSince !== undefined
              ? `, marked failing ${clockTime(device.failingSince, now)}`
              : `, ${lastRead}`}
            {device.failures === undefined
              ? "."
              : `, ${formatNumber(device.failures)} ${device.failures === 1 ? "read" : "reads"} failed in a row.`}
          </p>
        </div>
      )
  }
}

/**
 * Why it fails in the driver's words, what that means and what to check, most likely first: as `ot-gateway status`
 * orders them, power and network before its config for a device that answered earlier in this run or failed
 * together with others (on one host: that host first).
 */
const WhatToCheck = ({ device, shared }: { readonly device: DeviceStatus; readonly shared: SharedFailure }) => {
  const hint = whatToCheck(device.protocol, device.reason ?? "", device.lastError, {
    answeredBefore: device.lastSuccess !== undefined,
    ...shared.context
  })
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      {device.lastError === undefined ? null : (
        <p className="font-mono text-sm break-words text-destructive">{device.lastError}</p>
      )}
      {shared.line === undefined ? null : <p className="text-sm">{shared.line}</p>}
      <p className="text-sm">{hint.meaning}</p>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">What to check</h3>
        <ul className="ms-5 flex list-disc flex-col gap-1 text-sm text-muted-foreground">
          {hint.checks.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ul>
      </div>
    </section>
  )
}

export const DeviceSheet = ({
  device,
  address,
  points,
  readings,
  events,
  shared,
  now,
  position,
  morph,
  unreachable,
  onStep,
  onClose
}: {
  readonly device: DeviceStatus
  /** Where it is, from the running config; undefined until the config came. */
  readonly address: string | undefined
  /** Its points from the catalog, in config order; undefined until the catalog came. */
  readonly points: ReadonlyArray<PointInfo> | undefined
  readonly readings: ReadonlyMap<string, PointReading>
  /** What happened to it, its alarm points and its energy counters, oldest first. */
  readonly events: ReadonlyArray<PageEvent>
  /** Whether its failure is one of several at once (`sharedFailure`), for what to check. */
  readonly shared: SharedFailure
  readonly now: number
  /** Where the device is in the listed devices (1-based), when it is listed. */
  readonly position: { readonly index: number; readonly total: number } | undefined
  /** Opened by a view transition, which animates it; otherwise it slides in by itself. */
  readonly morph: boolean
  /** The gateway stopped answering: what is shown is the last it said. */
  readonly unreachable: boolean
  readonly onStep: (delta: 1 | -1) => void
  readonly onClose: () => void
}) => {
  const dialog = useRef<HTMLDialogElement>(null)
  const state = freshness(device, now)
  const shown = (points ?? []).slice(0, SHEET_POINTS)
  const allPoints = `/points/${filterToSearch({ query: "", device: device.id }, undefined)}`

  // A layout effect, so the dialog is open in the frame the view transition takes as its new state.
  useLayoutEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (!element.open) element.showModal()
    element.focus()
    return () => element.close()
  }, [])

  return (
    <dialog
      aria-label={device.id}
      className={`point-sheet ${morph ? "morphing" : ""} ms-auto me-0 my-0 h-dvh max-h-dvh w-[min(36rem,100vw)] max-w-full overflow-x-hidden overflow-y-auto border-l bg-card p-0 text-card-foreground shadow-2xl outline-none`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => {
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
            <p className="text-sm text-muted-foreground">{protocolName[device.protocol]}</p>
            <h2 className="font-mono text-lg font-semibold break-all">{device.id}</h2>
            {address === undefined ? null : (
              <p className="font-mono text-sm break-words text-muted-foreground">{address}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {position === undefined ? null : (
              <>
                <span className="mr-1 text-xs text-muted-foreground tabular-nums">
                  {position.index} of {position.total}
                </span>
                <button
                  aria-label="Previous device (↑ or k)"
                  className={iconButton}
                  disabled={position.index <= 1}
                  onClick={() => onStep(-1)}
                  title="Previous device (↑ or k)"
                  type="button"
                >
                  ↑
                </button>
                <button
                  aria-label="Next device (↓ or j)"
                  className={iconButton}
                  disabled={position.index >= position.total}
                  onClick={() => onStep(1)}
                  title="Next device (↓ or j)"
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

        <div className="flex flex-col gap-3">
          {unreachable ? (
            <Badge className="w-fit" variant="destructive">
              gateway unreachable: last known state
            </Badge>
          ) : null}
          <Health device={device} now={now} />
          {state._tag === "failing" ? <WhatToCheck device={device} shared={shared} /> : null}
          {device.protocol === "modbus-tcp" || device.protocol === "bacnet-ip" ? (
            <Link
              className="w-fit text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              href={`/settings/?edit=${encodeURIComponent(device.id)}`}
            >
              Edit and test its settings →
            </Link>
          ) : null}
        </div>

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">
              Points <span className="font-normal text-muted-foreground">({formatNumber(device.pointCount)})</span>
            </h3>
            <Link
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              href={allPoints}
            >
              All points of this device →
            </Link>
          </div>
          {points === undefined ? (
            <div className="h-24 animate-pulse rounded-md bg-muted" />
          ) : shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">The config gives it no points.</p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {shown.map((point) => {
                const key = pointKey(point)
                const value = readings.get(key)
                const read = pointFreshness(point, { value, device }, now, unreachable)
                return (
                  <li key={key}>
                    <Link
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 px-3 py-2 hover:bg-muted/50"
                      href={`/points/${filterToSearch({ query: "", device: device.id }, key)}`}
                      title={`${point.id}: ${point.name}`}
                    >
                      <span className="min-w-0 truncate">{point.name}</span>
                      <span className="font-mono whitespace-nowrap tabular-nums">
                        <PointValue
                          alarm={alarmWhen(point)}
                          now={now}
                          stale={read._tag === "stale"}
                          onChange={readsOnChange(point)}
                          unit={point.unit}
                          value={value}
                        />
                      </span>
                      <span className="col-span-full truncate text-xs text-muted-foreground">
                        {point.id} ·{" "}
                        {read._tag === "unchanged" ? (
                          <span title={ON_CHANGE_HINT}>
                            <PointRead now={now} state={read} />
                          </span>
                        ) : read._tag === "none" ? (
                          "nothing read yet"
                        ) : (
                          <>
                            {read._tag === "stale" ? (readsOnChange(point) ? "last change" : "last read") : "read"}{" "}
                            <PointRead now={now} state={read} />
                          </>
                        )}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
          {points !== undefined && points.length > shown.length ? (
            <Link
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              href={allPoints}
            >
              +{formatNumber(points.length - shown.length)} more on the Points tab
            </Link>
          ) : null}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Recent events</h3>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">It has not failed since the gateway started.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {events.toReversed().map((event) => {
                const detail = eventDetail(event, now)
                const note = eventNote(event)
                return (
                  <li className="flex min-w-0 items-baseline gap-2" key={event.id}>
                    <span
                      aria-hidden="true"
                      className={`size-2 shrink-0 translate-y-[-1px] rounded-full ${toneDot[eventTone(event)]}`}
                    />
                    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                      {clockTime(event.at, now)}
                    </span>
                    <span className="min-w-0 break-words">
                      {eventSentence(event, (_, pointId) => points?.find((point) => point.id === pointId)?.name, now)}
                      {detail === undefined ? null : (
                        <span className="text-xs text-muted-foreground" title={eventDetailTitle(event)}>
                          {" "}
                          · {detail}
                        </span>
                      )}
                      {note === undefined ? null : <span className="block text-xs text-muted-foreground">{note}</span>}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </dialog>
  )
}
