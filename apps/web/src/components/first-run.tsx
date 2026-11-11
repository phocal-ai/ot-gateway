"use client"
/**
 * The guided first run, which leads the Status tab while the config has no devices (lib/first-run.ts): 1, the
 * broker, shown connected or with "Test the connection"; 2, devices, added in this page (a Modbus device, BACnet
 * devices found on the network, or a points list or EDE file); 3, the first values, shown as they arrive, then done.
 * After the first save it stays above the overview until it is closed. An AI agent and the command line are the
 * other ways, kept short below. When the page may not edit, step 2 says why.
 */
import type { BrokerTest, EditStatus, GatewayStatus, PointInfo, PointReading } from "@ot-gateway/api"
import { Effect } from "effect"
import Link from "next/link"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { useCatalog } from "@/components/catalog"
import { useValues } from "@/components/live"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { fetchConfigFile, fetchEditStatus } from "@/lib/editor-api"
import { firstRunView, firstValuePoints, rememberGuide } from "@/lib/first-run"
import { pointKey } from "@/lib/points"
import { type Outcome, testBroker } from "@/lib/setup-api"
import { formatValue, settle, unitLabel } from "@/lib/status"

const Command = ({ children }: { readonly children: string }) => (
  <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">{children}</pre>
)

const action =
  "inline-flex h-8 items-center rounded-md border bg-background px-3 text-sm font-medium text-foreground shadow-xs hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"

/** One step: its number (a check once done), its title, and what to do while it is the next one. */
const Step = ({
  number,
  title,
  done,
  current,
  children
}: {
  readonly number: number
  readonly title: string
  readonly done: boolean
  readonly current: boolean
  readonly children: ReactNode
}) => (
  <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 gap-y-1">
    <span
      aria-hidden
      className={`flex size-7 items-center justify-center rounded-full border text-sm font-medium ${
        done ? "border-success bg-success/10 text-success" : current ? "border-foreground" : "text-muted-foreground"
      }`}
    >
      {done ? "✓" : number}
    </span>
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 pt-0.5">
      <h3 className={`font-medium ${current || done ? "text-foreground" : "text-muted-foreground"}`}>
        {title}
        <span className="sr-only">{done ? " (done)" : current ? " (next)" : ""}</span>
      </h3>
      {children}
    </div>
  </li>
)

/** Whether this page may edit, asked for once. */
const useEdit = () => {
  const [edit, setEdit] = useState<EditStatus | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void settle(fetchEditStatus).then((result) => {
      if (!cancelled && result._tag === "Success") setEdit(result.success)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return edit
}

/** The broker step: connected, or a test with the settings in the file and a link to change them. */
const BrokerStep = ({ status, edit }: { readonly status: GatewayStatus; readonly edit: EditStatus | undefined }) => {
  const [test, setTest] = useState<"running" | Outcome<BrokerTest> | undefined>(undefined)
  if (status.broker.connected)
    return <p className="text-sm text-muted-foreground break-words">Connected to {status.broker.url}.</p>
  const run = () => {
    setTest("running")
    void settle(fetchConfigFile).then((file) => {
      if (file._tag === "Failure") return setTest({ _tag: "failed", message: file.failure.message })
      void Effect.runPromise(testBroker(file.success.text)).then(setTest)
    })
  }
  return (
    <div className="grid gap-2 text-sm">
      <p className="break-words text-muted-foreground">
        Not connected to {status.broker.url}. Values wait in the buffer until it is.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={run} disabled={test === "running" || edit?.enabled !== true}>
          {test === "running" ? "Testing…" : "Test the connection"}
        </Button>
        {edit?.enabled === true ? (
          <Link className={action} href="/settings/?broker=1">
            Change the broker
          </Link>
        ) : null}
      </div>
      {test === undefined || test === "running" ? null : test._tag === "ok" ? (
        <p className={`break-words ${test.value.ok ? "text-success" : "text-destructive"}`} role="status">
          {test.value.ok
            ? `The broker answers (MQTT ${test.value.protocolVersion ?? "?"}${test.value.roundTripMs === undefined ? "" : `, ${Math.round(test.value.roundTripMs)} ms round trip`}). The gateway connects on its next try.`
            : `Not reached: ${test.value.error ?? "no answer"}`}
        </p>
      ) : (
        <p className="break-words text-destructive" role="status">
          {test.message}
        </p>
      )}
    </div>
  )
}

/** The values step: the first points with their values as they arrive. */
const ValuesStep = ({
  status,
  shown,
  readings
}: {
  readonly status: GatewayStatus
  readonly shown: ReadonlyArray<PointInfo>
  readonly readings: ReadonlyMap<string, PointReading>
}) => {
  if (status.devices.length === 0)
    return <p className="text-sm text-muted-foreground">Values show here as soon as a device is saved.</p>
  const failing = status.devices.filter((device) => device.status === "failing")
  return (
    <div className="grid gap-2 text-sm">
      {shown.length === 0 ? null : (
        <ul className="grid gap-1">
          {shown.map((point) => {
            const reading = readings.get(pointKey(point))
            return (
              <li key={pointKey(point)} className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">
                  {point.name}
                  <span className="text-muted-foreground"> · {point.device}</span>
                </span>
                <span className={`shrink-0 tabular-nums ${reading?.value === undefined ? "text-muted-foreground" : ""}`}>
                  {reading?.value === undefined
                    ? "waiting…"
                    : `${formatValue(reading.value)}${point.unit === undefined ? "" : ` ${unitLabel(point.unit)}`}`}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {failing.map((device) => (
        <p key={device.id} className="break-words text-destructive">
          {device.id} does not answer{device.lastError === undefined ? "" : `: ${device.lastError}`}. Open it in the
          list below for what to check.
        </p>
      ))}
    </div>
  )
}

/** The guide, three steps; `onClose` once it is done (the overview takes over). */
export const FirstRun = ({ status, onClose }: { readonly status: GatewayStatus; readonly onClose: () => void }) => {
  const edit = useEdit()
  const catalog = useCatalog(status.configSince)
  const shown = useMemo(() => (catalog._tag === "ok" ? firstValuePoints(catalog.catalog.points) : []), [catalog])
  const readings = useValues(useMemo(() => shown.map(pointKey), [shown]))
  const view = firstRunView(status, readings, shown)
  const devices = status.devices.length
  // Started: after a device is saved the guide stays until its last step is done and closed.
  useEffect(() => {
    if (devices === 0) rememberGuide(true)
  }, [devices])
  return (
    <Card className="gap-4 px-5 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="grid gap-1">
          <h2 className="font-semibold">{view.next === "done" ? "The gateway is set up" : "Set up the gateway"}</h2>
          <p className="text-sm text-muted-foreground">
            {view.next === "done"
              ? "Values arrive and go to the broker. Add more devices on the Settings tab."
              : "Three steps, all in this page. Every change is checked and applied at once."}
          </p>
        </div>
        {devices > 0 ? (
          <Button
            size="sm"
            variant={view.next === "done" ? "default" : "ghost"}
            onClick={() => {
              rememberGuide(false)
              onClose()
            }}
          >
            {view.next === "done" ? "Done" : "Close the guide"}
          </Button>
        ) : null}
      </div>
      <ol className="grid gap-5">
        <Step number={1} title="Broker" done={view.broker} current={view.next === 1}>
          <BrokerStep status={status} edit={edit} />
        </Step>
        <Step number={2} title="Devices" done={view.devices} current={view.next === 2}>
          {view.devices ? (
            <p className="text-sm text-muted-foreground">
              {devices} device{devices === 1 ? "" : "s"} in the config.{" "}
              <Link className="underline underline-offset-4 hover:text-foreground" href="/settings/">
                Add more
              </Link>
            </p>
          ) : edit !== undefined && !edit.enabled ? (
            <div className="grid gap-1 text-sm text-muted-foreground">
              <p>Editing in this page is off: {edit.reason}</p>
              {edit.fix === undefined ? null : <p>{edit.fix}</p>}
            </div>
          ) : (
            <div className="grid gap-2 text-sm text-muted-foreground">
              <p>Add the devices to read, test them, and save.</p>
              <div className="flex flex-wrap gap-2">
                <Link className={action} href="/settings/?add=modbus-tcp">
                  Add Modbus device
                </Link>
                <Link className={action} href="/settings/?find=1">
                  Find BACnet devices
                </Link>
                <Link className={action} href="/settings/?upload=1">
                  Upload a points list or EDE file
                </Link>
              </div>
            </div>
          )}
        </Step>
        <Step number={3} title="First values" done={view.next === "done"} current={view.next === 3}>
          <ValuesStep status={status} shown={shown} readings={readings} />
        </Step>
      </ol>
      {devices === 0 ? (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">Other ways: an AI agent or the command line</summary>
          <div className="mt-3 grid gap-3">
            <p>
              Ask a coding agent to set up OT Gateway with{" "}
              <code className="font-mono text-foreground">npx ot-gateway</code>. It finds BACnet devices or reads your
              EDE file or datasheets, writes the points list and imports it.
            </p>
            <div className="grid gap-1">
              <p>By hand: write a list to fill in, one row per value,</p>
              <Command>ot-gateway points template &gt; points.csv</Command>
              <p>then add it to the config and restart the gateway:</p>
              <Command>ot-gateway import points.csv</Command>
            </div>
          </div>
        </details>
      ) : null}
    </Card>
  )
}
