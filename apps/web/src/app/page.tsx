"use client"

/**
 * The status page: the gateway, its broker and buffer, every device with its
 * health and latest values, the messages it publishes and the recent commands.
 * Polls `/api/status` every two seconds, and `/api/messages` while the
 * messages are shown; read-only.
 *
 * Freshness is shown as a state, not as numbers that count up: the header says
 * Live while answers arrive, a device says how often it is read and gets a time
 * only once it is late or failing, a value lights up briefly when it changes,
 * and messages carry their clock time. The page renders when data arrives and
 * at no other time.
 */
import type { DeviceStatus, GatewayStatus, HostStatus, Messages as MessageList } from "@ot-gateway/api"
import { Effect } from "effect"
import { useEffect, useState } from "react"
import { flushSync } from "react-dom"
import { DeviceDialog } from "@/components/device-dialog"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  clockTime,
  every,
  fetchMessages,
  fetchStatus,
  formatBytes,
  fillPercent,
  formatValue,
  freshness,
  type Freshness,
  since,
  topicKind,
  unitLabel
} from "@/lib/status"

const POLL_MS = 2000

type Load =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ok"; readonly status: GatewayStatus }
  | { readonly _tag: "unreachable"; readonly last?: GatewayStatus }

const deviceBadge = (state: Freshness) => {
  switch (state._tag) {
    case "live":
      return <Badge variant="success">ok</Badge>
    case "starting":
      return <Badge variant="secondary">starting</Badge>
    case "late":
      return <Badge variant="warning">late</Badge>
    case "failing":
      return <Badge variant="destructive">{state.reason}</Badge>
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

/**
 * A point's value, lit up for a moment when it changes, so the page shows that data moves without a column of
 * counting seconds. The first value on screen does not light up; hovering says when it last changed.
 */
const PointValue = ({ point, now }: { readonly point: DeviceStatus["points"][number]; readonly now: number }) => {
  const [firstTs] = useState(point.ts)
  const changed = point.ts !== undefined && point.ts !== firstTs
  return (
    <span
      key={point.ts}
      className={`rounded px-1 ${changed ? "motion-safe:animate-[value-changed_1.2s_ease-out]" : ""}`}
      title={point.ts === undefined ? "nothing sent yet" : `changed ${clockTime(point.ts, now)}`}
    >
      {formatValue(point.value)} <span className="text-muted-foreground">{unitLabel(point.unit)}</span>
    </span>
  )
}

const protocolName = { "modbus-tcp": "Modbus TCP", "bacnet-ip": "BACnet/IP", simulator: "Simulated" } as const

const DeviceHeading = ({ device, now }: { readonly device: DeviceStatus; readonly now: number }) => {
  const state = freshness(device, now)
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <CardTitle className="font-mono">{device.id}</CardTitle>
        {deviceBadge(state)}
      </div>
      <CardDescription>
        {protocolName[device.protocol]} · {deviceLine(device, state, now)}
      </CardDescription>
    </>
  )
}

/** The name both the card and its dialog carry, so a view transition morphs one into the other. */
const transitionName = (device: DeviceStatus) => `device-${device.id}`

/** A device's card; clicking it (or Enter or Space on it) opens the device. */
const Device = ({
  device,
  now,
  open,
  onOpen
}: {
  readonly device: DeviceStatus
  readonly now: number
  readonly open: boolean
  readonly onOpen: () => void
}) => (
  <Card
    aria-haspopup="dialog"
    aria-label={`${device.id}: open history`}
    className="cursor-pointer transition-shadow hover:shadow-md hover:ring-1 hover:ring-ring/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    onClick={onOpen}
    onKeyDown={(event) => {
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      onOpen()
    }}
    role="button"
    style={{ viewTransitionName: open ? "none" : transitionName(device) }}
    tabIndex={0}
  >
    <CardHeader>
      <DeviceHeading device={device} now={now} />
    </CardHeader>
    <CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Point</TableHead>
            <TableHead className="text-right">Value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {device.points.map((point) => (
            <TableRow key={point.id}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span title={point.name}>{point.id}</span>
                  {point.writable ? <Badge variant="outline">writable</Badge> : null}
                </div>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                <PointValue key={point.id} point={point} now={now} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent>
  </Card>
)

/** Whether the browser morphs the card into the dialog: it has view transitions and the user allows motion. */
const canMorph = () =>
  typeof document.startViewTransition === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches

/** Runs a state change inside a view transition where the browser has them, and plainly elsewhere. */
const withTransition = (update: () => void) => {
  if (!canMorph()) return update()
  document.startViewTransition(() => flushSync(update))
}

/**
 * Whether values are safe while the broker is away: how full the buffer is against its limit, and whether it
 * has had to give any up. Empty is the normal state; rows mean the broker is (or was just) unreachable.
 */
const BufferCard = ({ buffer, stale }: { readonly buffer: GatewayStatus["buffer"]; readonly stale: boolean }) => {
  const note = (text: string) => (stale ? "page is not reaching the gateway" : text)
  if (buffer === undefined)
    return (
      <Card>
        <CardHeader>
          <CardDescription>Buffer</CardDescription>
          <CardTitle className="text-2xl">off</CardTitle>
          <CardDescription>{note("values are lost while the broker is down")}</CardDescription>
        </CardHeader>
      </Card>
    )
  return (
    <Card>
      <CardHeader>
        <CardDescription>Buffer</CardDescription>
        <CardTitle className="text-2xl tabular-nums">
          {buffer.rows.toLocaleString()}/{buffer.maxRows.toLocaleString()}
        </CardTitle>
        <CardDescription className={buffer.dropped > 0 && !stale ? "text-destructive" : ""}>
          {note(
            buffer.dropped > 0
              ? `${buffer.dropped.toLocaleString()} dropped since start`
              : buffer.rows === 0
                ? "messages waiting for the broker"
                : `messages waiting for the broker (${fillPercent(buffer.rows, buffer.maxRows)} full)`
          )}
        </CardDescription>
      </CardHeader>
    </Card>
  )
}

const Overview = ({ status, stale }: { readonly status: GatewayStatus; readonly stale: boolean }) => {
  const failing = status.devices.filter((device) => device.status === "failing").length
  const ok = status.devices.filter((device) => device.status === "ok").length
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card>
        <CardHeader>
          <CardDescription>Broker</CardDescription>
          <CardTitle className={`text-2xl ${status.broker.connected ? "" : "text-destructive"}`}>
            {status.broker.connected ? "connected" : "disconnected"}
          </CardTitle>
          <CardDescription className="truncate" title={status.broker.url}>
            {status.broker.connected
              ? `to ${status.broker.url}`
              : status.buffer === undefined
                ? `${status.broker.url}: values are lost until it is back`
                : `${status.broker.url}: values wait in the buffer`}
          </CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Devices</CardDescription>
          <CardTitle className="text-2xl tabular-nums">
            {ok}/{status.devices.length}
          </CardTitle>
          <CardDescription className={failing > 0 ? "text-destructive" : ""}>
            {failing > 0
              ? `devices answering, ${failing} failing`
              : ok === status.devices.length
                ? "devices answering"
                : `devices answering, ${status.devices.length - ok} starting`}
          </CardDescription>
        </CardHeader>
      </Card>
      <BufferCard buffer={status.buffer} stale={stale} />
    </div>
  )
}

/** One figure of the host card; `warn` turns it amber. */
const Figure = ({
  label,
  value,
  warn
}: {
  readonly label: string
  readonly value: string
  readonly warn?: boolean
}) => (
  <div className="flex flex-col gap-1">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span className={`font-mono text-sm tabular-nums ${warn === true ? "text-amber-600 dark:text-amber-400" : ""}`}>
      {value}
    </span>
  </div>
)

/** The machine under the gateway: what to look at first when a Pi misbehaves. */
const Host = ({ host }: { readonly host: HostStatus }) => {
  const conditions = host.throttled?.now ?? []
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Host</CardTitle>
          <div className="flex flex-wrap gap-2">
            {conditions.length > 0 ? <span className="text-xs text-muted-foreground">in the last minute</span> : null}
            {conditions.map((condition) => (
              <Badge key={condition} variant="destructive">
                {condition.replaceAll("_", " ")}
              </Badge>
            ))}
          </div>
        </div>
        <CardDescription>
          gateway {host.version} · Node {host.node}
          {host.throttled !== undefined && !host.throttled.watched.includes("throttled")
            ? " · power: under-voltage only (this kernel shows no throttling; vcgencmd get_throttled does)"
            : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label="Memory" value={formatBytes(host.memoryBytes)} />
          <Figure label="CPU" value={`${host.cpuPercent.toFixed(1)} %`} />
          <Figure
            label="Event loop lag (max, 1 min)"
            value={`${host.eventLoopLagMs.max} ms`}
            warn={host.eventLoopLagMs.max >= 1000}
          />
          <Figure
            label="Temperature"
            value={host.temperatureC === undefined ? "–" : `${host.temperatureC.toFixed(1)} °C`}
            warn={(host.temperatureC ?? 0) >= 80}
          />
          <Figure
            label="Buffer disk free"
            value={host.diskFreeBytes === undefined ? "–" : formatBytes(host.diskFreeBytes)}
            warn={host.diskFreeBytes !== undefined && host.diskFreeBytes < 64 * 1024 * 1024}
          />
          <Figure label="Open files" value={host.openFds === undefined ? "–" : String(host.openFds)} />
          <Figure label="Clock steps" value={String(host.clockSteps)} warn={host.clockSteps > 0} />
          <Figure label="Heap" value={formatBytes(host.heapBytes)} />
        </div>
      </CardContent>
    </Card>
  )
}

/** Polls `fetchMessages` every two seconds while mounted; the last answer, or undefined before the first. */
const useMessages = () => {
  const [messages, setMessages] = useState<MessageList | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = () =>
      Effect.runPromise(Effect.result(fetchMessages)).then((result) => {
        if (cancelled) return
        if (result._tag === "Success") setMessages(result.success)
        timer = setTimeout(() => void poll(), POLL_MS)
      })
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])
  return messages
}

const kindBadge = {
  value: "default",
  metadata: "secondary",
  health: "outline",
  "command result": "warning",
  other: "outline"
} as const

const MessageTable = ({ now, prefix }: { readonly now: number; readonly prefix: string }) => {
  const list = useMessages()
  if (list === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (list.messages.length === 0) return <p className="text-sm text-muted-foreground">Nothing published yet.</p>
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Topic</TableHead>
            <TableHead>Latest payload</TableHead>
            <TableHead className="text-right">Messages</TableHead>
            <TableHead className="text-right">Sent at</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.messages.map((message) => {
            const kind = topicKind(message.topic)
            return (
              <TableRow key={message.topic}>
                <TableCell className="align-top">
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-xs">
                      <span className="text-muted-foreground">{prefix}</span>
                      {message.topic.slice(prefix.length)}
                    </span>
                    <div className="flex gap-1">
                      <Badge variant={kindBadge[kind]}>{kind}</Badge>
                      {message.retained ? (
                        <Badge
                          variant="outline"
                          title="The broker keeps it and gives it to every subscriber that connects later"
                        >
                          retained
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="max-w-md align-top">
                  <code className="block truncate font-mono text-xs" title={message.payload}>
                    {message.payload}
                    {message.truncated ? "…" : ""}
                  </code>
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">{message.count.toLocaleString()}</TableCell>
                <TableCell className="text-right align-top text-muted-foreground">
                  {clockTime(message.at, now)}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {list.droppedTopics > 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {list.droppedTopics.toLocaleString()} more topics are not shown: the gateway keeps the latest message of at
          most {list.messages.length.toLocaleString()}.
        </p>
      ) : null}
    </>
  )
}

/** Small setups (the demo) show their messages right away; a building's worth of points waits for a click. */
const OPEN_UP_TO_POINTS = 50

const Messages = ({ status }: { readonly status: GatewayStatus }) => {
  const points = status.devices.reduce((sum, device) => sum + device.points.length, 0)
  const [open, setOpen] = useState(points <= OPEN_UP_TO_POINTS)
  const prefix = `${status.site}/${status.building}/`
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Messages</CardTitle>
          <button
            type="button"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => setOpen((shown) => !shown)}
          >
            {open ? "Hide" : "Show"}
          </button>
        </div>
        <CardDescription>
          What the gateway publishes to the broker, the latest message on each topic: what a client subscribed to{" "}
          <code className="font-mono">{prefix}#</code> receives. A value goes to{" "}
          <code className="font-mono">site/building/device/point</code> as its publish mode says (every read, once per
          interval, or when it changes), its metadata (name, unit, Brick class) to{" "}
          <code className="font-mono">…/$meta</code>, and the gateway&apos;s health to{" "}
          <code className="font-mono">…/$gateway/{status.id}/health</code>.
        </CardDescription>
      </CardHeader>
      {open ? (
        <CardContent>
          <MessageTable now={status.now} prefix={prefix} />
        </CardContent>
      ) : null}
    </Card>
  )
}

const Commands = ({ status }: { readonly status: GatewayStatus }) => (
  <Card>
    <CardHeader>
      <CardTitle>Recent commands</CardTitle>
      <CardDescription>Commands arrive over MQTT on …/point/$set; this page only shows them.</CardDescription>
    </CardHeader>
    <CardContent>
      {status.commands.length === 0 ? (
        <p className="text-sm text-muted-foreground">No commands since the gateway started.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Point</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {status.commands.map((command) => (
              <TableRow key={`${command.at}-${command.device}-${command.point}`}>
                <TableCell className="text-muted-foreground">{clockTime(command.at, status.now)}</TableCell>
                <TableCell className="font-mono">
                  {command.device}/{command.point}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      command.status === "written"
                        ? "success"
                        : command.status === "rejected"
                          ? "warning"
                          : "destructive"
                    }
                  >
                    {command.status}
                    {command.reason === undefined ? "" : `: ${command.reason}`}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </CardContent>
  </Card>
)

/** The page's own freshness, once for everything on it: live while the gateway answers every two seconds. */
const LiveBadge = ({ load }: { readonly load: Load }) => {
  switch (load._tag) {
    case "loading":
      return null
    case "unreachable":
      return <Badge variant="destructive">gateway unreachable</Badge>
    case "ok":
      return (
        <Badge variant="outline" title={`The page asks the gateway every ${POLL_MS / 1000} s`}>
          <span aria-hidden="true" className="size-2 rounded-full bg-success motion-safe:animate-pulse" />
          Live
        </Badge>
      )
  }
}

const StatusPage = () => {
  const [load, setLoad] = useState<Load>({ _tag: "loading" })
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // The next request only once this one has settled: a slow gateway never gets them piled up.
    const poll = () =>
      Effect.runPromise(Effect.result(fetchStatus)).then((result) => {
        if (cancelled) return
        setLoad((previous) =>
          result._tag === "Success"
            ? { _tag: "ok", status: result.success }
            : {
                _tag: "unreachable",
                ...(previous._tag === "ok"
                  ? { last: previous.status }
                  : previous._tag === "unreachable" && previous.last !== undefined
                    ? { last: previous.last }
                    : {})
              }
        )
        timer = setTimeout(() => void poll(), POLL_MS)
      })
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  const status = load._tag === "ok" ? load.status : load._tag === "unreachable" ? load.last : undefined
  const opened = status?.devices.find((device) => device.id === openId)
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">OT Gateway</h1>
          {status === undefined ? null : (
            <p className="text-sm text-muted-foreground">
              {status.site} / {status.building} · gateway {status.id} · up {since(status.since, status.now)}
            </p>
          )}
        </div>
        <LiveBadge load={load} />
      </header>
      {status === undefined ? (
        <p className="text-muted-foreground">{load._tag === "loading" ? "Loading…" : "The gateway does not answer."}</p>
      ) : (
        <>
          <Overview status={status} stale={load._tag !== "ok"} />
          {status.host === undefined ? null : <Host host={status.host} />}
          <section className="grid gap-4 lg:grid-cols-2">
            {status.devices.map((device) => (
              <Device
                device={device}
                key={device.id}
                now={status.now}
                onOpen={() => withTransition(() => setOpenId(device.id))}
                open={device.id === openId}
              />
            ))}
          </section>
          {opened === undefined ? null : (
            <DeviceDialog
              device={opened}
              header={<DeviceHeading device={opened} now={status.now} />}
              morph={canMorph()}
              onClose={() => withTransition(() => setOpenId(undefined))}
              transitionName={transitionName(opened)}
            />
          )}
          <Messages status={status} />
          <Commands status={status} />
        </>
      )}
    </main>
  )
}

export default StatusPage
