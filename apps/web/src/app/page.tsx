"use client"

/**
 * The status page, an overview: the gateway, its broker and buffer (each card opens its details), the machine
 * when it has a problem, every
 * device with its health (a row each, opening its points on the Points
 * page); the messages it publishes, command results among them, are on the Messages tab.
 * Polls `/api/status` every two seconds; read-only.
 *
 * Freshness is shown as a state, not as numbers that count up: the header says
 * Live while answers arrive, a device says how often it is read and gets a time
 * only once it is late or failing. The page renders when data arrives and
 * at no other time.
 */
import type { DeviceStatus, GatewayStatus, HostStatus } from "@ot-gateway/api"
import Link from "next/link"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { useGateway } from "@/components/gateway-shell"
import { DetailDialog, Facts, morphFrom } from "@/components/detail-dialog"
import { statusOf } from "@/components/live"
import { machineProblems } from "@/lib/host"
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
  since
} from "@/lib/status"

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

/** Under the device's name: how often it is read, and since when it hasn't been once that matters. */
const deviceLine = (device: DeviceStatus, state: Freshness, now: number) => {
  const read = `read ${every(device.pollIntervalMs)}`
  switch (state._tag) {
    case "live":
    case "starting":
      return read
    case "late":
    case "failing":
      return state.lastSuccess === undefined
        ? `${read} · no answer yet`
        : `${read} · no answer for ${since(state.lastSuccess, now)}`
  }
}

/** Devices listed before "Show all": every one with a problem is listed anyway. */
const DEVICE_ROWS = 10

/**
 * Every device, one row each: its health, how it is read and how many points it has, the ones with a problem
 * first. A row opens the device's points on the Points page, where each point has its value and history. A
 * site with many devices lists the first few until asked for all, so this page stays a short overview.
 */
const Devices = ({ status }: { readonly status: GatewayStatus }) => {
  const [all, setAll] = useState(false)
  const ordered = byAttention(status.devices, status.now)
  const problems = ordered.filter((device) => freshness(device, status.now)._tag !== "live").length
  const listed = all ? ordered : ordered.slice(0, Math.max(DEVICE_ROWS, problems))
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
              <Link
                className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]"
                href={`/points/?device=${encodeURIComponent(device.id)}`}
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm font-medium">{device.id}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {protocolName[device.protocol]} · {deviceLine(device, state, status.now)}
                  </p>
                </div>
                <span className="hidden text-sm text-muted-foreground tabular-nums sm:block">
                  {device.pointCount.toLocaleString()} {device.pointCount === 1 ? "point" : "points"}
                </span>
                <span className="justify-self-end">{deviceBadge(state)}</span>
                <span aria-hidden="true" className="hidden text-muted-foreground sm:block">
                  →
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
      {listed.length < ordered.length ? (
        <div className="border-t p-3 text-center">
          <button
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={() => setAll(true)}
            type="button"
          >
            Show all {ordered.length.toLocaleString()} devices
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

type Panel = "broker" | "devices" | "buffer"

const panelTitles = { broker: "Broker", devices: "Devices", buffer: "Buffer" } as const

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
            : broker.connectedAt === undefined
              ? "Not connected yet"
              : `Disconnected, last connected at ${clockTime(broker.connectedAt, status.now)}`}
        </p>
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
          ["Values published", broker.published.toLocaleString()],
          [
            "Could not publish",
            <span className={broker.publishFailures > 0 ? "text-destructive" : ""}>
              {broker.publishFailures.toLocaleString()}
            </span>
          ],
          ["Reconnects", reconnects(broker.connects).toLocaleString()],
          ["Failed connection attempts", broker.failedConnects.toLocaleString()],
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

const DevicesDetails = ({ status }: { readonly status: GatewayStatus }) => {
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
            <span className={`text-2xl font-semibold tabular-nums ${tone}`}>{count.toLocaleString()}</span>
            <span className="text-xs text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
      <Facts
        rows={protocolCounts(status.devices).map(
          ({ name, devices, points }) =>
            [
              name,
              `${devices.toLocaleString()} ${devices === 1 ? "device" : "devices"} · ${points.toLocaleString()} ${points === 1 ? "point" : "points"}`
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
                  <Link
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-muted/50"
                    href={`/points/?device=${encodeURIComponent(device.id)}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono">{device.id}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {deviceLine(device, state, status.now)}
                      </span>
                    </span>
                    {deviceBadge(state)}
                  </Link>
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
          ["Holds up to", `${buffer.maxRows.toLocaleString()} messages`],
          ["Stored", buffer.written.toLocaleString()],
          ["Sent on later", buffer.delivered.toLocaleString()],
          [
            "Dropped",
            <span className={buffer.dropped > 0 ? "text-destructive" : ""}>{buffer.dropped.toLocaleString()}</span>
          ],
          ["Disk errors", buffer.failures.toLocaleString()],
          status.host?.diskFreeBytes !== undefined && ["Disk free", formatBytes(status.host.diskFreeBytes)],
          ["File", <span className="font-mono">{buffer.path}</span>]
        ]}
      />
      {reasons.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-sm text-destructive">
          {reasons.map(({ reason, count, words }) => (
            <li key={reason}>
              {count.toLocaleString()} dropped because {words}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Counts since the gateway started.</p>
    </>
  )
}

/**
 * The broker, the devices and the buffer at a glance; each card opens its details in a dialog that grows out of
 * it (a view transition where the browser has them).
 */
const Overview = ({ status, stale }: { readonly status: GatewayStatus; readonly stale: boolean }) => {
  const [open, setOpen] = useState<Panel | undefined>(undefined)
  const [morph, setMorph] = useState(false)
  const cards = useRef<Partial<Record<Panel, HTMLDivElement | null>>>({})
  const failing = status.devices.filter((device) => device.status === "failing").length
  const ok = status.devices.filter((device) => device.status === "ok").length
  const buffer = bufferView(status.buffer, status.broker.connected, useBufferRate(status))
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
    <div className="grid gap-4 sm:grid-cols-3">
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
        note={note(`${status.broker.connected ? "to " : ""}${status.broker.url}`)}
        title={status.broker.connected ? "connected" : "disconnected"}
      />
      <OverviewCard
        {...cardProps("devices")}
        bad={failing > 0}
        label="Devices"
        note={note(
          failing > 0
            ? `devices answering, ${failing} failing`
            : ok === status.devices.length
              ? "devices answering"
              : `devices answering, ${status.devices.length - ok} starting`
        )}
        title={`${ok}/${status.devices.length}`}
      />
      <OverviewCard
        {...cardProps("buffer")}
        bad={buffer.bad && !stale}
        extra={
          buffer.dropped === 0 ? null : (
            <CardDescription className="text-destructive">
              {buffer.dropped.toLocaleString()} dropped since start
            </CardDescription>
          )
        }
        label="Buffer"
        note={note(buffer.note)}
        title={buffer.title}
      />
      {open === undefined ? null : (
        <DetailDialog morph={morph} onClose={closePanel} title={panelTitles[open]}>
          {open === "broker" ? (
            <BrokerDetails status={status} />
          ) : open === "devices" ? (
            <DevicesDetails status={status} />
          ) : (
            <BufferDetails status={status} view={buffer} />
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

const StatusPage = () => {
  const load = useGateway()
  const status = statusOf(load)
  return (
    <>
      {status === undefined ? (
        <p className="text-muted-foreground">{load._tag === "loading" ? "Loading…" : "The gateway does not answer."}</p>
      ) : (
        <>
          {status.host === undefined ? null : <MachineNotice host={status.host} upMs={status.now - status.since} />}
          <Overview status={status} stale={load._tag !== "ok"} />
          <Devices status={status} />
        </>
      )}
    </>
  )
}

export default StatusPage
