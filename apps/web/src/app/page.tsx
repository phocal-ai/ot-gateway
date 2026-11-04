"use client"

/**
 * The status page: the gateway, its broker and buffer, every device with its
 * health and latest values, and the recent commands. Polls `/api/status`
 * every two seconds; read-only.
 */
import type { DeviceStatus, GatewayStatus, HostStatus } from "@ot-gateway/api"
import { Effect } from "effect"
import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ago, fetchStatus, formatBytes, formatValue, unitLabel } from "@/lib/status"

const POLL_MS = 2000

type Load =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ok"; readonly status: GatewayStatus }
  | { readonly _tag: "unreachable"; readonly last?: GatewayStatus }

const deviceBadge = (device: DeviceStatus) => {
  switch (device.status) {
    case "ok":
      return <Badge variant="success">ok</Badge>
    case "starting":
      return <Badge variant="secondary">starting</Badge>
    case "failing":
      return <Badge variant="destructive">{device.reason ?? "failing"}</Badge>
  }
}

const protocolName = { "modbus-tcp": "Modbus TCP", "bacnet-ip": "BACnet/IP", simulator: "Simulated" } as const

const Device = ({ device, now }: { readonly device: DeviceStatus; readonly now: number }) => (
  <Card>
    <CardHeader>
      <div className="flex items-center justify-between gap-2">
        <CardTitle className="font-mono">{device.id}</CardTitle>
        {deviceBadge(device)}
      </div>
      <CardDescription>
        {protocolName[device.protocol]} · last read {ago(device.lastSuccess, now)}
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Point</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">Updated</TableHead>
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
                {formatValue(point.value)} <span className="text-muted-foreground">{unitLabel(point.unit)}</span>
              </TableCell>
              <TableCell className="text-right text-muted-foreground">{ago(point.ts, now)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent>
  </Card>
)

const Overview = ({ status, stale }: { readonly status: GatewayStatus; readonly stale: boolean }) => {
  const failing = status.devices.filter((device) => device.status === "failing").length
  const ok = status.devices.filter((device) => device.status === "ok").length
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card>
        <CardHeader>
          <CardDescription>Broker</CardDescription>
          <CardTitle className="flex items-center gap-2">
            {status.broker.connected ? (
              <Badge variant="success">connected</Badge>
            ) : (
              <Badge variant="destructive">disconnected</Badge>
            )}
          </CardTitle>
          <CardDescription className="truncate font-mono text-xs">{status.broker.url}</CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Devices</CardDescription>
          <CardTitle className="text-2xl tabular-nums">
            {ok}/{status.devices.length} ok
          </CardTitle>
          <CardDescription>
            {failing > 0
              ? `${failing} failing`
              : ok === status.devices.length
                ? "every device answers"
                : `${status.devices.length - ok} starting`}
          </CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Buffer</CardDescription>
          <CardTitle className="text-2xl tabular-nums">
            {status.buffer === undefined ? "off" : `${status.buffer.rows.toLocaleString()} waiting`}
          </CardTitle>
          <CardDescription>
            {stale ? "page is not reaching the gateway" : `up since ${new Date(status.since).toLocaleString()}`}
          </CardDescription>
        </CardHeader>
      </Card>
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
  const sinceBoot = host.throttled?.sinceBoot ?? []
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Host</CardTitle>
          <div className="flex flex-wrap gap-2">
            {conditions.map((condition) => (
              <Badge key={condition} variant="destructive">
                {condition.replaceAll("_", " ")}
              </Badge>
            ))}
            {conditions.length === 0 && sinceBoot.length > 0 ? (
              <Badge variant="warning">since boot: {sinceBoot.map((c) => c.replaceAll("_", " ")).join(", ")}</Badge>
            ) : null}
          </div>
        </div>
        <CardDescription>
          gateway {host.version} · Node {host.node}
          {host.throttled !== undefined && !host.throttled.watched.includes("throttled")
            ? " · power: under-voltage only (this kernel shows no throttling; check vcgencmd get_throttled)"
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
                <TableCell className="text-muted-foreground">{ago(command.at, status.now)}</TableCell>
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

const StatusPage = () => {
  const [load, setLoad] = useState<Load>({ _tag: "loading" })
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
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">OT Gateway</h1>
          {status === undefined ? null : (
            <p className="text-sm text-muted-foreground">
              {status.site} / {status.building} · gateway {status.id}
            </p>
          )}
        </div>
        {load._tag === "unreachable" ? <Badge variant="destructive">gateway unreachable</Badge> : null}
      </header>
      {status === undefined ? (
        <p className="text-muted-foreground">{load._tag === "loading" ? "Loading…" : "The gateway does not answer."}</p>
      ) : (
        <>
          <Overview status={status} stale={load._tag !== "ok"} />
          {status.host === undefined ? null : <Host host={status.host} />}
          <section className="grid gap-4 lg:grid-cols-2">
            {status.devices.map((device) => (
              <Device key={device.id} device={device} now={status.now} />
            ))}
          </section>
          <Commands status={status} />
        </>
      )}
    </main>
  )
}

export default StatusPage
