"use client"

/**
 * The Settings tab: the gateway's running config (`/api/config`), every default filled in. The Gateway and Broker
 * cards have an Edit button when the gateway lets this page edit (`/api/config/edit`): the form saves the config
 * file and the gateway applies it without a restart (components/settings-editor.tsx). When it does not, the page
 * says why and what to change. Everything else is changed in the config file, checked with `ot-gateway check` and
 * read again when the gateway restarts. Points are on the Points tab; here each device has its address, interval
 * and point count.
 */
import type { ConfigView, EditStatus } from "@ot-gateway/api"
import { useEffect, useState } from "react"
import { EditForm } from "@/components/settings-editor"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { EditCard } from "@/lib/editor"
import { fetchEditStatus } from "@/lib/editor-api"
import { formatNumber } from "@/lib/format"
import { deviceAddress, deviceColumns, duration, formatSetting, sectionTitle, settingLabel } from "@/lib/settings"
import { fetchConfig, protocolName, settle } from "@/lib/status"

/** Try again after this long when the config did not come. */
const RETRY_MS = 5000

type ConfigLoad =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ok"; readonly config: ConfigView }
  | { readonly _tag: "failed"; readonly message: string }

/** The config, asked for until it comes once, and again after each `reload` (a save). */
const useConfig = (reload: number) => {
  const [load, setLoad] = useState<ConfigLoad>({ _tag: "loading" })
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = () =>
      settle(fetchConfig).then((result) => {
        if (cancelled) return
        if (result._tag === "Success") return setLoad({ _tag: "ok", config: result.success })
        setLoad({ _tag: "failed", message: result.failure.message })
        timer = setTimeout(() => void ask(), RETRY_MS)
      })
    void ask()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [reload])
  return load
}

/** Whether this page may edit, asked for once and after each save; undefined until it comes (or if it never does). */
const useEditStatus = (reload: number) => {
  const [edit, setEdit] = useState<EditStatus | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void settle(fetchEditStatus).then((result) => {
      if (!cancelled && result._tag === "Success") setEdit(result.success)
    })
    return () => {
      cancelled = true
    }
  }, [reload])
  return edit
}

/** Blocks a config can leave out, and what that means. */
const offWhenMissing: ReadonlyArray<readonly [string, string]> = [
  ["buffer", "Off: values read while the broker is away are lost."],
  ["history", "Off: the point panel shows no history."]
]

/** The cards with an Edit button. */
const editable = (key: string): EditCard | undefined => (key === "gateway" || key === "mqtt" ? key : undefined)

const SettingsPage = () => {
  const [reload, setReload] = useState(0)
  const load = useConfig(reload)
  const edit = useEditStatus(reload)
  const [editing, setEditing] = useState<EditCard | undefined>(undefined)
  const [saved, setSaved] = useState<string | undefined>(undefined)
  if (load._tag !== "ok")
    return (
      <p className="text-muted-foreground">
        {load._tag === "failed" ? `The gateway does not answer: ${load.message}` : "Loading…"}
      </p>
    )
  const { sections, devices } = load.config
  const present = new Set(sections.map((section) => section.key))
  const closeForm = (message: string | undefined) => {
    setEditing(undefined)
    if (message === undefined) return
    setSaved(message)
    setReload((count) => count + 1)
  }
  return (
    <>
      <div className="grid max-w-3xl gap-2 text-sm">
        {edit?.enabled === true ? (
          <p className="text-muted-foreground">
            The settings the gateway runs with. Edit changes the gateway and broker settings in{" "}
            <code className="font-mono break-all">{edit.path}</code> and applies them at once, keeping the previous file
            as <code className="font-mono">.bak</code>. Devices and everything else are changed in that file, then the
            gateway is restarted.
          </p>
        ) : (
          <p className="text-muted-foreground">
            The settings the gateway runs with. To change one, edit the config file (
            <code className="font-mono">ot-gateway.json</code>), check it with{" "}
            <code className="font-mono">ot-gateway check ot-gateway.json</code> and restart the gateway.
          </p>
        )}
        {edit !== undefined && !edit.enabled ? (
          <div className="rounded-md border px-3 py-2">
            <p>Editing on this page is off: {edit.reason}</p>
            {edit.fix === undefined ? null : <p className="mt-1 text-muted-foreground">{edit.fix}</p>}
          </div>
        ) : null}
        {saved === undefined ? null : (
          <p role="status" className="rounded-md border border-success/40 px-3 py-2">
            {saved}
          </p>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {sections.map((section) => {
          const card = editable(section.key)
          const canEdit = card !== undefined && edit?.enabled === true && editing === undefined
          return (
            <Card key={section.key}>
              <CardHeader className="flex items-center justify-between gap-2">
                <CardTitle>{sectionTitle(section.key)}</CardTitle>
                {canEdit ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="-my-2"
                    onClick={() => {
                      setSaved(undefined)
                      setEditing(card)
                    }}
                  >
                    Edit
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent>
                {card !== undefined && editing === card && edit !== undefined ? (
                  <EditForm card={card} edit={edit} onDone={closeForm} />
                ) : (
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
                    {section.entries.map((entry) => (
                      <div className="contents" key={entry.key}>
                        <dt className="text-muted-foreground" title={entry.key}>
                          {settingLabel(entry.key)}
                        </dt>
                        <dd className="min-w-0 text-right break-words">{formatSetting(entry.key, entry.value)}</dd>
                      </div>
                    ))}
                    {section.key === "mqtt" && edit?.password !== undefined ? (
                      <div className="contents">
                        <dt className="text-muted-foreground">Password</dt>
                        <dd className="min-w-0 text-right break-words">
                          {edit.password.set ? "set" : "not set"} ({edit.password.variable})
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                )}
              </CardContent>
            </Card>
          )
        })}
        {offWhenMissing
          .filter(([key]) => !present.has(key))
          .map(([key, text]) => (
            <Card key={key}>
              <CardHeader>
                <CardTitle>{sectionTitle(key)}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{text}</p>
              </CardContent>
            </Card>
          ))}
      </div>
      <Card className="gap-0 py-0">
        <div className="border-b px-5 py-4">
          <h2 className="leading-none font-semibold">Devices</h2>
        </div>
        {devices.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">The config has no devices.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">Device</TableHead>
                <TableHead className="hidden sm:table-cell">Address</TableHead>
                <TableHead className="text-right">Read every</TableHead>
                <TableHead className="text-right">Points</TableHead>
                <TableHead className="hidden pr-5 lg:table-cell">Other settings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map((device) => {
                const interval = device.entries.find((entry) => entry.key === "pollIntervalMs")?.value
                const others = device.entries
                  .filter((entry) => !deviceColumns.has(entry.key))
                  .map((entry) => `${settingLabel(entry.key)}: ${formatSetting(entry.key, entry.value)}`)
                  .join(" · ")
                return (
                  <TableRow key={device.id}>
                    <TableCell className="max-w-56 pl-5">
                      <p className="truncate font-mono">{device.id}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {protocolName[device.protocol] ?? device.protocol}
                        <span className="sm:hidden"> · {deviceAddress(device.protocol, device.entries)}</span>
                      </p>
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs sm:table-cell">
                      {deviceAddress(device.protocol, device.entries)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {typeof interval === "number" ? duration(interval) : "–"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(device.pointCount)}</TableCell>
                    <TableCell
                      className="hidden max-w-md truncate pr-5 text-xs text-muted-foreground lg:table-cell"
                      title={others}
                    >
                      {others}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  )
}

export default SettingsPage
