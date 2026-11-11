"use client"

/**
 * The status page, an overview: alarms that are on, the broker, devices, buffer and machine (each card opens its
 * details), every device with its health and its first few values (a row each, opening the device in a side panel:
 * where it is, since when it fails, why and what to check, its points and its events), and the gateway's recent
 * events; the messages it publishes, command results among them, are on the Messages tab. A gateway without
 * devices says how to add them. The open device lives in the URL (`?device=`), so it can be linked.
 * Polls `/api/status` every two seconds (and the new events with it), and the values shown like the Points tab
 * does; read-only.
 *
 * Freshness is shown as a state, not as numbers that count up: the header says
 * Live while answers arrive, a device says how often it is read and gets a time
 * only once it is late or failing. The page renders when data arrives and
 * at no other time.
 */
import type { DeviceStatus, GatewayStatus, HostStatus, PointInfo, PointReading } from "@ot-gateway/api"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { useCatalog } from "@/components/catalog"
import { useGateway, useGatewayEvents } from "@/components/gateway-shell"
import { DetailDialog, Facts, morphFrom } from "@/components/detail-dialog"
import { DeviceSheet, SHEET_POINTS } from "@/components/device-sheet"
import { useRunningConfig } from "@/components/running-config"
import { NoDevicesYet } from "@/components/no-devices"
import { FirstRun } from "@/components/first-run"
import { guideStarted, showsGuide } from "@/lib/first-run"
import { ON_CHANGE_HINT, PointValue } from "@/components/point-value"
import { formatNumber } from "@/lib/format"
import { statusOf, useValues } from "@/components/live"
import {
  activeAlarms,
  alarmCount,
  glanceKeys,
  glancePoints,
  alarmWhen,
  pointFreshness,
  pointsByDevice
} from "@/lib/glance"
import { machineNote, machineProblems, powerLabel } from "@/lib/host"
import { deviceAddress } from "@/lib/device"
import {
  deviceEvents,
  eventSentence,
  eventTone,
  isIncident,
  type KnownEvents,
  latestEvents,
  nothingYet
} from "@/lib/events"
import { filterToSearch, pointKey } from "@/lib/points"
import {
  addSample,
  type BufferSample,
  type BufferView,
  bufferRate,
  bufferView,
  deviceCounts,
  dropReasons,
  protocolCounts,
  reconnects
} from "@/lib/overview"
import { Badge } from "@/components/ui/badge"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  byAttention,
  clockTime,
  every,
  fillPercent,
  failureLabel,
  formatBytes,
  freshness,
  type Freshness,
  protocolName,
  since,
  sinceClock
} from "@/lib/status"
import { canMorph, withTransition } from "@/lib/transition"

const deviceBadge = (state: Freshness) => {
  switch (state._tag) {
    case "live":
      return <Badge variant="success">ok</Badge>
    case "starting":
      return <Badge variant="secondary">starting</Badge>
    case "late":
      return <Badge variant="warning">late</Badge>
    case "failing":
      return <Badge variant="destructive">{failureLabel(state.reason)}</Badge>
  }
}

/**
 * Under the device's name: how often it is read, and since when it hasn't been once that matters: a failing device
 * since the clock time it started failing ("failing since 12:18:20 (3 min)").
 */
const deviceLine = (device: DeviceStatus, state: Freshness, now: number) => {
  const read = `read ${every(device.pollIntervalMs)}`
  switch (state._tag) {
    case "live":
    case "starting":
      return read
    case "failing":
      if (device.failingSince !== undefined) return `${read} · failing since ${sinceClock(device.failingSince, now)}`
      return state.lastSuccess === undefined
        ? `${read} · no answer yet`
        : `${read} · no answer for ${since(state.lastSuccess, now)}`
    case "late":
      return state.lastSuccess === undefined
        ? `${read} · no answer yet`
        : `${read} · no answer for ${since(state.lastSuccess, now)}`
  }
}

/** Devices listed before "Show all": every one with a problem is listed anyway. */
const DEVICE_ROWS = 10

/** The devices the Status tab lists, problems first: the first `DEVICE_ROWS` and every one with a problem, or all. */
const listedDevices = (status: GatewayStatus, all: boolean) => {
  const ordered = byAttention(status.devices, status.now)
  const problems = ordered.filter((device) => freshness(device, status.now)._tag !== "live").length
  return { ordered, listed: all ? ordered : ordered.slice(0, Math.max(DEVICE_ROWS, problems)) }
}

/** The values the Status tab shows (lib/glance.ts): a few per listed device, and every alarm point. */
interface Glance {
  readonly byDevice: ReadonlyMap<string, ReadonlyArray<PointInfo>>
  readonly readings: ReadonlyMap<string, PointReading>
  readonly unreachable: boolean
}

/**
 * A device's latest values in one wrapping line: its alarms that are on first, then its first points, each with its
 * name (the id on hover), and how many more the Points tab has. A stale value is dimmed as on the Points tab.
 */
const DeviceValues = ({
  device,
  glance,
  now
}: {
  readonly device: DeviceStatus
  readonly glance: Glance
  readonly now: number
}) => {
  const points = glance.byDevice.get(device.id) ?? []
  if (points.length === 0) return null
  const { shown, more } = glancePoints(points, glance.readings)
  return (
    <ul className="col-span-full flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-sm">
      {shown.map((point) => {
        const value = glance.readings.get(pointKey(point))
        const read = pointFreshness(point, { value, device }, now, glance.unreachable)
        return (
          <li
            className={`flex max-w-full min-w-0 items-baseline gap-1 ${read._tag === "stale" ? "opacity-50" : ""}`}
            key={point.id}
            title={`${point.id}: ${point.name}`}
          >
            <span className="max-w-48 truncate text-muted-foreground">{point.name}</span>
            <PointValue
              alarm={alarmWhen(point)}
              className="shrink-0 font-mono whitespace-nowrap tabular-nums"
              now={now}
              unit={point.unit}
              value={value}
            />
            {read._tag === "unchanged" ? (
              <span className="shrink-0 text-xs text-muted-foreground" title={ON_CHANGE_HINT}>
                COV
              </span>
            ) : null}
          </li>
        )
      })}
      {more > 0 ? <li className="text-muted-foreground">+{formatNumber(more)} more</li> : null}
    </ul>
  )
}

/**
 * Every device, one row each: its health, how it is read, how many points it has and its first few values, the
 * ones with a problem first. A row opens the device in a side panel (since when it fails, why, what to check, its
 * points and events). A site with many devices lists the first few until asked for all, so this page stays a short
 * overview.
 */
const Devices = ({
  status,
  all,
  onShowAll,
  onOpen,
  opened,
  glance
}: {
  readonly status: GatewayStatus
  readonly all: boolean
  readonly onShowAll: () => void
  readonly onOpen: (device: string) => void
  /** The device open in the panel, marked in the list. */
  readonly opened: string | undefined
  readonly glance: Glance | undefined
}) => {
  const { ordered, listed } = listedDevices(status, all)
  if (ordered.length === 0)
    return (
      <Card className="px-5 py-5">
        <NoDevicesYet />
      </Card>
    )
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-2 border-b px-5 py-4">
        <h2 className="leading-none font-semibold">Devices</h2>
        <Link
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          href="/points/"
        >
          All points →
        </Link>
      </div>
      <ul className="divide-y">
        {listed.map((device) => {
          const state = freshness(device, status.now)
          return (
            <li key={device.id}>
              <button
                aria-haspopup="dialog"
                aria-pressed={device.id === opened}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-3 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none aria-pressed:bg-muted sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]"
                data-device={device.id}
                onClick={() => onOpen(device.id)}
                type="button"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm font-medium">{device.id}</p>
                  {/* Wraps rather than cutting off "failing since …" on a phone. */}
                  <p className="text-xs break-words text-muted-foreground">
                    {protocolName[device.protocol]} · {deviceLine(device, state, status.now)}
                  </p>
                </div>
                <span className="hidden text-sm text-muted-foreground tabular-nums sm:block">
                  {formatNumber(device.pointCount)} {device.pointCount === 1 ? "point" : "points"}
                </span>
                <span className="justify-self-end">{deviceBadge(state)}</span>
                <span aria-hidden="true" className="hidden text-muted-foreground sm:block">
                  →
                </span>
                {glance === undefined ? null : <DeviceValues device={device} glance={glance} now={status.now} />}
              </button>
            </li>
          )
        })}
      </ul>
      {listed.length < ordered.length ? (
        <div className="border-t p-3 text-center">
          <button
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={onShowAll}
            type="button"
          >
            Show all {formatNumber(ordered.length)} devices
          </button>
        </div>
      ) : null}
    </Card>
  )
}

/**
 * How fast the buffer fills or empties, from the polls of the last minute (lib/overview.ts); unknown for its first
 * few seconds, and again after the gateway restarts.
 */
const useBufferRate = (status: GatewayStatus) => {
  const samples = useRef<ReadonlyArray<BufferSample>>([])
  const [rate, setRate] = useState<number | undefined>(undefined)
  const rows = status.buffer?.rows
  useEffect(() => {
    if (rows === undefined) return
    samples.current = addSample(samples.current, { at: status.now, since: status.since, rows })
    setRate(bufferRate(samples.current))
  }, [rows, status.now, status.since])
  return rate
}

type Panel = "broker" | "devices" | "buffer" | "machine"

const panelTitles = { broker: "Broker", devices: "Devices", buffer: "Buffer", machine: "Machine" } as const

/**
 * A card that opens its details. The button is the card's label, stretched over the whole card (valid HTML, unlike
 * a card inside a button), so a click anywhere on it opens the dialog.
 */
const OverviewCard = ({
  label,
  title,
  note,
  extra,
  bad,
  onOpen,
  cardRef
}: {
  readonly label: string
  readonly title: string
  readonly note: string
  readonly extra?: ReactNode
  readonly bad: boolean
  readonly onOpen: () => void
  readonly cardRef: (element: HTMLDivElement | null) => void
}) => (
  <Card className="group relative transition-colors has-[button:hover]:bg-muted/40" ref={cardRef}>
    <CardHeader>
      <div className="flex items-center justify-between gap-2">
        <CardDescription>
          <button
            aria-haspopup="dialog"
            className="outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
            onClick={onOpen}
            type="button"
          >
            {label}
          </button>
        </CardDescription>
        <span
          aria-hidden="true"
          className="text-sm text-muted-foreground opacity-0 transition-opacity group-has-[button:hover]:opacity-100 group-has-[button:focus-visible]:opacity-100"
        >
          Details →
        </span>
      </div>
      <CardTitle className={`text-2xl tabular-nums ${bad ? "text-destructive" : ""}`}>{title}</CardTitle>
      <CardDescription className="truncate" title={note}>
        {note}
      </CardDescription>
      {extra}
    </CardHeader>
  </Card>
)

const BrokerDetails = ({ status }: { readonly status: GatewayStatus }) => {
  const { broker, buffer } = status
  const connection = broker.connection
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className={`text-xl font-semibold ${broker.connected ? "" : "text-destructive"}`}>
          {broker.connected
            ? broker.connectedAt === undefined
              ? "Connected"
              : `Connected since ${clockTime(broker.connectedAt, status.now)}`
            : broker.disconnectedSince !== undefined
              ? `Disconnected since ${sinceClock(broker.disconnectedSince, status.now)}`
              : broker.connectedAt === undefined
                ? "Not connected yet"
                : `Disconnected, last connected at ${clockTime(broker.connectedAt, status.now)}`}
        </p>
        {broker.connected || broker.lastError === undefined ? null : (
          <p className="font-mono text-sm break-words text-destructive">{broker.lastError}</p>
        )}
        {broker.connected ? null : (
          <p className="text-sm text-muted-foreground">
            {buffer === undefined
              ? "Values are lost until it is back: there is no buffer to keep them."
              : "Values wait in the buffer and go out once it is back."}
          </p>
        )}
      </div>
      <Facts
        rows={[
          ["Broker", <span className="font-mono">{broker.url}</span>],
          !broker.connected &&
            broker.connectedAt !== undefined && ["Last connected", clockTime(broker.connectedAt, status.now)],
          ["Values published", formatNumber(broker.published)],
          [
            "Could not publish",
            <span className={broker.publishFailures > 0 ? "text-destructive" : ""}>
              {formatNumber(broker.publishFailures)}
            </span>
          ],
          ["Reconnects", formatNumber(reconnects(broker.connects))],
          ["Failed connection attempts", formatNumber(broker.failedConnects)],
          connection !== undefined && ["MQTT version", connection.protocolVersion],
          connection !== undefined && ["Keep-alive", `${connection.keepAliveSeconds} s`],
          connection !== undefined && ["Retained messages", connection.retainAvailable ? "supported" : "not supported"],
          connection !== undefined && [
            "Largest message",
            connection.maximumPacketSize === undefined ? "no limit" : formatBytes(connection.maximumPacketSize)
          ]
        ]}
      />
      <p className="text-xs text-muted-foreground">Counts since the gateway started.</p>
      <Link className="text-sm underline-offset-4 hover:underline" href="/messages/">
        What it publishes →
      </Link>
    </>
  )
}

const DevicesDetails = ({
  status,
  onOpenDevice
}: {
  readonly status: GatewayStatus
  readonly onOpenDevice: (device: string) => void
}) => {
  const counts = deviceCounts(status.devices, status.now)
  const attention = byAttention(status.devices, status.now).filter((device) => {
    const tag = freshness(device, status.now)._tag
    return tag === "failing" || tag === "late"
  })
  const states = [
    ["Answering", counts.live, ""],
    ["Starting", counts.starting, ""],
    ["Late", counts.late, counts.late > 0 ? "text-amber-600 dark:text-amber-400" : ""],
    ["Failing", counts.failing, counts.failing > 0 ? "text-destructive" : ""]
  ] as const
  return (
    <>
      <div className="grid grid-cols-4 gap-3">
        {states.map(([label, count, tone]) => (
          <div className="flex flex-col gap-0.5" key={label}>
            <span className={`text-2xl font-semibold tabular-nums ${tone}`}>{formatNumber(count)}</span>
            <span className="text-xs text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
      <Facts
        rows={protocolCounts(status.devices).map(
          ({ name, devices, points }) =>
            [
              name,
              `${formatNumber(devices)} ${devices === 1 ? "device" : "devices"} · ${formatNumber(points)} ${points === 1 ? "point" : "points"}`
            ] as const
        )}
      />
      {attention.length === 0 ? (
        <p className="text-sm text-muted-foreground">Every device answers.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Need a look</h3>
          <ul className="divide-y rounded-lg border">
            {attention.map((device) => {
              const state = freshness(device, status.now)
              return (
                <li key={device.id}>
                  <button
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50"
                    onClick={() => onOpenDevice(device.id)}
                    type="button"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono">{device.id}</span>
                      <span className="block text-xs break-words text-muted-foreground">
                        {deviceLine(device, state, status.now)}
                      </span>
                    </span>
                    {deviceBadge(state)}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <Link className="text-sm underline-offset-4 hover:underline" href="/points/">
        All points →
      </Link>
    </>
  )
}

const BufferDetails = ({ status, view }: { readonly status: GatewayStatus; readonly view: BufferView }) => {
  const { buffer } = status
  if (buffer === undefined)
    return (
      <>
        <p className="text-sm">
          There is no buffer, so values read while the broker is away are lost. A buffer keeps them on the
          gateway&apos;s disk and sends them once the broker is back.
        </p>
        <p className="text-sm text-muted-foreground">
          To add one, put a <code className="font-mono">buffer</code> block in the config and restart the gateway.
        </p>
        <Link className="text-sm underline-offset-4 hover:underline" href="/settings/">
          Settings →
        </Link>
      </>
    )
  const reasons = dropReasons(buffer.droppedBy)
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className={`text-xl font-semibold tabular-nums ${view.bad ? "text-destructive" : ""}`}>{view.title}</p>
        <p className="text-sm text-muted-foreground">
          {view.note.charAt(0).toUpperCase() + view.note.slice(1)}
          {buffer.rows === 0 || buffer.rows >= buffer.maxRows
            ? "."
            : ` (${fillPercent(buffer.rows, buffer.maxRows)} full).`}
        </p>
        {buffer.disabled ? (
          <p className="text-sm text-destructive">
            The buffer could not be used, so values go straight to the broker and are lost while it is away. The gateway
            log says why.
          </p>
        ) : null}
      </div>
      <Facts
        rows={[
          ["Holds up to", `${formatNumber(buffer.maxRows)} messages`],
          ["Stored", formatNumber(buffer.written)],
          ["Sent on later", formatNumber(buffer.delivered)],
          [
            "Dropped",
            <span className={buffer.dropped > 0 ? "text-destructive" : ""}>{formatNumber(buffer.dropped)}</span>
          ],
          ["Disk errors", formatNumber(buffer.failures)],
          status.host?.diskFreeBytes !== undefined && ["Disk free", formatBytes(status.host.diskFreeBytes)],
          ["File", <span className="font-mono">{buffer.path}</span>]
        ]}
      />
      {reasons.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-sm text-destructive">
          {reasons.map(({ reason, count, words }) => (
            <li key={reason}>
              {formatNumber(count)} dropped because {words}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Counts since the gateway started.</p>
    </>
  )
}

const ms = (value: number) => `${formatNumber(Math.round(value))} ms`

/** The machine's last sample: its problems in machineProblems' words first, then every reading calmly. */
const MachineDetails = ({ status }: { readonly status: GatewayStatus }) => {
  const { host } = status
  if (host === undefined)
    return <p className="text-sm text-muted-foreground">The gateway samples the machine every 15 s; no sample yet.</p>
  const problems = machineProblems(host, status.now - status.since)
  const power = powerLabel(host)
  return (
    <>
      {problems.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing needs a look: power, heat, disk and load are fine.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm text-amber-700 dark:text-amber-300">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <Facts
        rows={[
          ["Processor", `${Math.round(host.cpuPercent)} % of one core`],
          ["Memory", formatBytes(host.memoryBytes)],
          ["JavaScript heap", formatBytes(host.heapBytes)],
          ["Event-loop lag", `${ms(host.eventLoopLagMs.p99)} (p99), up to ${ms(host.eventLoopLagMs.max)}`],
          host.temperatureC !== undefined && ["Temperature", `${Math.round(host.temperatureC)} °C`],
          power !== undefined && ["Power supply", power],
          host.diskFreeBytes !== undefined && ["Disk free", formatBytes(host.diskFreeBytes)],
          host.openFds !== undefined && ["Open files", formatNumber(host.openFds)],
          ["Clock steps", formatNumber(host.clockSteps)],
          ["Version", <span className="font-mono">{host.version}</span>],
          ["Node.js", <span className="font-mono">{host.node}</span>]
        ]}
      />
      <p className="text-xs text-muted-foreground">
        Sampled every 15 s; lag over the last minute; clock steps since the gateway started.
      </p>
    </>
  )
}

/** The Machine card's title and line: calm while all is fine, the first problem in its own words otherwise. */
const machineCard = (host: HostStatus | undefined, upMs: number) => {
  if (host === undefined) return { title: "–", note: "no sample yet", bad: false }
  const problems = machineProblems(host, upMs)
  const [first] = problems
  if (first === undefined) return { title: "ok", note: machineNote(host), bad: false }
  return { title: problems.length === 1 ? "1 problem" : `${problems.length} problems`, note: first, bad: true }
}

/**
 * The broker, the devices, the buffer and the machine at a glance; each card opens its details in a dialog that
 * grows out of it (a view transition where the browser has them).
 */
const Overview = ({
  status,
  stale,
  onOpenDevice
}: {
  readonly status: GatewayStatus
  readonly stale: boolean
  readonly onOpenDevice: (device: string) => void
}) => {
  const [open, setOpen] = useState<Panel | undefined>(undefined)
  const [morph, setMorph] = useState(false)
  const cards = useRef<Partial<Record<Panel, HTMLDivElement | null>>>({})
  const failing = status.devices.filter((device) => device.status === "failing").length
  const ok = status.devices.filter((device) => device.status === "ok").length
  const buffer = bufferView(status.buffer, status.broker.connected, useBufferRate(status))
  const machine = machineCard(status.host, status.now - status.since)
  const note = (text: string) => (stale ? "page is not reaching the gateway" : text)

  const openPanel = (panel: Panel) => {
    const transition = morphFrom(cards.current[panel] ?? null)
    setMorph(transition.morph)
    transition.open(() => setOpen(panel))
  }
  const closePanel = () => {
    if (open === undefined) return
    morphFrom(cards.current[open] ?? null).close(() => setOpen(undefined))
  }
  const cardProps = (panel: Panel) => ({
    onOpen: () => openPanel(panel),
    cardRef: (element: HTMLDivElement | null) => {
      cards.current[panel] = element
    }
  })

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <OverviewCard
        {...cardProps("broker")}
        bad={!status.broker.connected}
        extra={
          status.broker.connected ? null : (
            <CardDescription className={status.buffer === undefined ? "text-destructive" : ""}>
              {status.buffer === undefined ? "values are lost until it is back" : "values wait in the buffer"}
            </CardDescription>
          )
        }
        label="Broker"
        note={note(
          status.broker.connected
            ? `to ${status.broker.url}`
            : status.broker.disconnectedSince === undefined
              ? status.broker.url
              : `since ${sinceClock(status.broker.disconnectedSince, status.now)}`
        )}
        title={status.broker.connected ? "connected" : "disconnected"}
      />
      <OverviewCard
        {...cardProps("devices")}
        bad={failing > 0}
        label="Devices"
        note={note(
          status.devices.length === 0
            ? "no devices in the config yet"
            : failing > 0
              ? `devices answering, ${failing} failing`
              : ok === status.devices.length
                ? "devices answering"
                : `devices answering, ${status.devices.length - ok} starting`
        )}
        title={status.devices.length === 0 ? "none" : `${ok}/${status.devices.length}`}
      />
      <OverviewCard
        {...cardProps("buffer")}
        bad={buffer.bad && !stale}
        extra={
          buffer.dropped === 0 ? null : (
            <CardDescription className="text-destructive">
              {formatNumber(buffer.dropped)} dropped since start
            </CardDescription>
          )
        }
        label="Buffer"
        note={note(buffer.note)}
        title={buffer.title}
      />
      <OverviewCard
        {...cardProps("machine")}
        bad={machine.bad && !stale}
        label="Machine"
        note={note(machine.note)}
        title={machine.title}
      />
      {open === undefined ? null : (
        <DetailDialog morph={morph} onClose={closePanel} title={panelTitles[open]}>
          {open === "broker" ? (
            <BrokerDetails status={status} />
          ) : open === "devices" ? (
            <DevicesDetails
              onOpenDevice={(device) => {
                setOpen(undefined)
                onOpenDevice(device)
              }}
              status={status}
            />
          ) : open === "buffer" ? (
            <BufferDetails status={status} view={buffer} />
          ) : (
            <MachineDetails status={status} />
          )}
        </DetailDialog>
      )}
    </div>
  )
}

/**
 * The machine, only when it needs someone on site (lib/host.ts): a notice at the top of the page, since a weak
 * power supply or a hot Pi is often why the devices below fail. Nothing while all is fine.
 */
const MachineNotice = ({ host, upMs }: { readonly host: HostStatus; readonly upMs: number }) => {
  const problems = machineProblems(host, upMs)
  if (problems.length === 0) return null
  return (
    <div
      className="flex flex-col gap-1 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
      role="status"
    >
      {problems.map((problem) => (
        <p key={problem}>{problem}</p>
      ))}
    </div>
  )
}

/**
 * The alarm points that are on (lib/glance.ts), above everything else: how many, and each by name with its device,
 * a link to the point on the Points tab.
 */
const AlarmNotice = ({ alarms }: { readonly alarms: ReadonlyArray<PointInfo> }) => {
  if (alarms.length === 0) return null
  return (
    <div
      className="flex flex-col gap-1 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      role="alert"
    >
      <p className="font-semibold">{alarmCount(alarms.length)}</p>
      <ul className="flex flex-col gap-0.5">
        {alarms.map((point) => (
          <li className="min-w-0 truncate" key={pointKey(point)}>
            <Link
              className="underline-offset-4 hover:underline"
              href={`/points/${filterToSearch({ query: "", device: point.device }, pointKey(point))}`}
              title={pointKey(point)}
            >
              {point.name}
            </Link>{" "}
            <span className="font-mono text-xs opacity-80">on {point.device}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The catalog and the values the page shows: a few per listed device and every alarm point, asked for like the
 * Points tab's rows. Nothing until the catalog came; the rows show without values meanwhile.
 */
const useGlance = (
  status: GatewayStatus | undefined,
  all: boolean,
  unreachable: boolean,
  opened: string | undefined
) => {
  const catalogLoad = useCatalog(status?.configSince)
  const catalog = catalogLoad._tag === "ok" ? catalogLoad.catalog : undefined
  const listedIds =
    status === undefined
      ? ""
      : listedDevices(status, all)
          .listed.map((device) => device.id)
          .join(",")
  const byDevice = useMemo(() => pointsByDevice(catalog?.points ?? []), [catalog])
  // The open device's first points ride on the same values poll as the rows'.
  const keys = useMemo(() => {
    if (catalog === undefined || listedIds === "") return []
    const sheet = opened === undefined ? [] : (byDevice.get(opened) ?? []).slice(0, SHEET_POINTS).map(pointKey)
    return [...new Set([...glanceKeys(catalog.points, listedIds.split(",")), ...sheet])]
  }, [catalog, listedIds, opened, byDevice])
  const readings = useValues(keys)
  if (catalog === undefined) return undefined
  return { glance: { byDevice, readings, unreachable }, alarms: activeAlarms(catalog.points, readings) }
}

/** Events the Recent events card lists before "Show all". */
const CARD_EVENTS = 10

const toneDot = { bad: "bg-destructive", good: "bg-success", neutral: "bg-muted-foreground/40" } as const

/** Events, newest first, one line each: a dot for bad or good news, the local time and what happened. */
const EventList = ({
  events,
  now,
  onOpenDevice
}: {
  readonly events: KnownEvents["events"]
  readonly now: number
  readonly onOpenDevice: (device: string) => void
}) => (
  <ul className="flex flex-col text-sm">
    {events.map((event) => {
      const line = (
        <>
          <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-full ${toneDot[eventTone(event)]}`} />
          <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground tabular-nums">
            {clockTime(event.at, now)}
          </span>
          <span className="min-w-0 break-words">{eventSentence(event)}</span>
        </>
      )
      const row = "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1 text-left"
      return (
        <li key={event.id}>
          {event.type === "device-failing" || event.type === "device-recovered" ? (
            <button
              className={`${row} hover:bg-muted/50`}
              onClick={() => onOpenDevice(event.device)}
              title={`Open ${event.device}`}
              type="button"
            >
              {line}
            </button>
          ) : (
            <div className={row}>{line}</div>
          )}
        </li>
      )
    })}
  </ul>
)

/**
 * What happened lately (`/api/events`), newest first: devices that stopped answering and came back, the broker
 * going away and coming back, the buffer emptying. A fault that cleared before anyone looked still shows here.
 * "Show all" opens every event the gateway keeps.
 */
const RecentEvents = ({
  status,
  known,
  onOpenDevice
}: {
  readonly status: GatewayStatus
  readonly known: KnownEvents | undefined
  readonly onOpenDevice: (device: string) => void
}) => {
  const [all, setAll] = useState(false)
  const [morph, setMorph] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  // Events of an older run of the gateway are not shown against this one's start.
  const events = known?.since === status.since ? known.events : []
  const happened = events.some(isIncident)
  const open = () => {
    const transition = morphFrom(card.current)
    setMorph(transition.morph)
    transition.open(() => setAll(true))
  }
  const openDevice = (device: string) => {
    setAll(false)
    onOpenDevice(device)
  }
  return (
    <Card className="gap-0 py-0" ref={card}>
      <div className="flex items-center justify-between gap-2 border-b px-5 py-4">
        <h2 className="leading-none font-semibold">Recent events</h2>
        {happened ? (
          <button
            aria-haspopup="dialog"
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={open}
            type="button"
          >
            Show all ({formatNumber(events.length)})
          </button>
        ) : null}
      </div>
      <div className="px-3 py-3">
        {happened ? (
          <EventList events={latestEvents(events, CARD_EVENTS)} now={status.now} onOpenDevice={onOpenDevice} />
        ) : (
          <p className="px-2 py-1 text-sm text-muted-foreground">{nothingYet(status.since, status.now)}</p>
        )}
      </div>
      {all ? (
        <DetailDialog morph={morph} onClose={() => morphFrom(card.current).close(() => setAll(false))} title="Events">
          <p className="text-sm text-muted-foreground">
            Since the gateway started at {clockTime(status.since, status.now)}, newest first.
            {known !== undefined && known.dropped > 0
              ? ` It keeps the latest ${formatNumber(known.capacity)}; ${formatNumber(known.dropped)} older ones were let go.`
              : ""}
          </p>
          <EventList events={events.toReversed()} now={status.now} onOpenDevice={openDevice} />
        </DetailDialog>
      ) : null}
    </Card>
  )
}

/** The open device in a URL query, if any. */
const deviceFromSearch = (query: string) => new URLSearchParams(query).get("device") ?? undefined

/**
 * The device open in the panel, from the URL (`?device=`), so a failing device can be linked; written back with
 * `replaceState` on open and close. A link to this page while it is open changes the URL under it: it follows.
 */
const useOpenDevice = () => {
  const search = useSearchParams().toString()
  const [opened, setOpened] = useState(() => deviceFromSearch(search))
  useEffect(() => setOpened(deviceFromSearch(search)), [search])
  const update = (device: string | undefined) => {
    setOpened(device)
    const query = device === undefined ? "" : `?${new URLSearchParams({ device }).toString()}`
    window.history.replaceState(null, "", `${window.location.pathname}${query}`)
  }
  return [opened, update] as const
}

const StatusView = () => {
  const load = useGateway()
  const known = useGatewayEvents()
  const status = statusOf(load)
  const [all, setAll] = useState(false)
  const [opened, setOpened] = useOpenDevice()
  const [morph, setMorph] = useState(false)
  const unreachable = load._tag === "unreachable"
  const glance = useGlance(status, all, unreachable, opened)
  const config = useRunningConfig(status?.configSince)
  const catalogLoad = useCatalog(status?.configSince)
  const byDevice = useMemo(
    () => pointsByDevice(catalogLoad._tag === "ok" ? catalogLoad.catalog.points : []),
    [catalogLoad]
  )
  // The setup guide: it leads without devices, and stays after the first save until it is closed (lib/first-run.ts).
  const [guide, setGuide] = useState(false)
  const deviceCount = status?.devices.length
  useEffect(() => {
    if (deviceCount === 0 || guideStarted()) setGuide(true)
  }, [deviceCount])

  const openDevice = (device: string) => {
    setMorph(canMorph())
    withTransition(() => setOpened(device))
  }
  /** Close the panel: it slides out, and focus goes to the row of the device it showed. */
  const closeDevice = () => {
    const shown = opened
    withTransition(() => setOpened(undefined), {
      updated: () => {
        if (shown === undefined) return
        document.querySelector<HTMLElement>(`[data-device="${CSS.escape(shown)}"]`)?.focus({ preventScroll: true })
      }
    })
  }

  if (status === undefined)
    return (
      <p className="text-muted-foreground">{load._tag === "loading" ? "Loading…" : "The gateway does not answer."}</p>
    )

  const { listed } = listedDevices(status, all)
  const device = opened === undefined ? undefined : status.devices.find((candidate) => candidate.id === opened)
  const index = device === undefined ? -1 : listed.indexOf(device)
  /** The next or previous listed device, in the open panel, without a transition: stepping should feel instant. */
  const step = (delta: 1 | -1) => {
    const next = listed[index + delta]
    if (next !== undefined) setOpened(next.id)
  }
  const configDevice = config?.devices.find((candidate) => candidate.id === opened)

  return (
    <>
      {status.host === undefined ? null : <MachineNotice host={status.host} upMs={status.now - status.since} />}
      <AlarmNotice alarms={glance?.alarms ?? []} />
      {showsGuide(status.devices.length, guide) ? <FirstRun onClose={() => setGuide(false)} status={status} /> : null}
      {status.devices.length === 0 ? null : (
        <>
          <Overview onOpenDevice={openDevice} stale={load._tag !== "ok"} status={status} />
          <Devices
            all={all}
            glance={glance?.glance}
            onOpen={openDevice}
            onShowAll={() => setAll(true)}
            opened={opened}
            status={status}
          />
        </>
      )}
      <RecentEvents known={known} onOpenDevice={openDevice} status={status} />
      {device === undefined ? null : (
        <DeviceSheet
          address={configDevice === undefined ? undefined : deviceAddress(configDevice)}
          device={device}
          events={known?.since === status.since ? deviceEvents(known.events, device.id) : []}
          morph={morph}
          now={status.now}
          onClose={closeDevice}
          onStep={step}
          points={catalogLoad._tag === "ok" ? (byDevice.get(device.id) ?? []) : undefined}
          position={index < 0 ? undefined : { index: index + 1, total: listed.length }}
          readings={glance?.glance.readings ?? new Map()}
          unreachable={unreachable}
        />
      )}
    </>
  )
}

/** `useSearchParams` needs a Suspense boundary in a static export: the prerendered page shows its fallback. */
const StatusPage = () => (
  <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
    <StatusView />
  </Suspense>
)

export default StatusPage
