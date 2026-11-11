"use client"

/**
 * The Settings tab: the gateway's running config, read-only (`/api/config`), every default filled in. The page
 * cannot change it: the config file can, checked with `ot-gateway check` and read again when the gateway restarts.
 * Points are on the Points tab; here each device has its address, interval and point count.
 */
import type { ConfigView } from "@ot-gateway/api"
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatNumber } from "@/lib/format"
import { deviceAddress, deviceColumns, duration, formatSetting, sectionTitle, settingLabel } from "@/lib/settings"
import { fetchConfig, protocolName, settle } from "@/lib/status"

/** Try again after this long when the config did not come. */
const RETRY_MS = 5000

type ConfigLoad =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ok"; readonly config: ConfigView }
  | { readonly _tag: "failed"; readonly message: string }

/** The config, asked for until it comes once. */
const useConfig = () => {
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
  }, [])
  return load
}

/** Blocks a config can leave out, and what that means. */
const offWhenMissing: ReadonlyArray<readonly [string, string]> = [
  ["buffer", "Off: values read while the broker is away are lost."],
  ["history", "Off: the point panel shows no history."]
]

const SettingsPage = () => {
  const load = useConfig()
  if (load._tag !== "ok")
    return (
      <p className="text-muted-foreground">
        {load._tag === "failed" ? `The gateway does not answer: ${load.message}` : "Loading…"}
      </p>
    )
  const { sections, devices } = load.config
  const present = new Set(sections.map((section) => section.key))
  return (
    <>
      <p className="max-w-3xl text-sm text-muted-foreground">
        The settings the gateway runs with, read-only. To change one, edit the config file (
        <code className="font-mono">ot-gateway.json</code>), check it with{" "}
        <code className="font-mono">ot-gateway check ot-gateway.json</code> and restart the gateway.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {sections.map((section) => (
          <Card key={section.key}>
            <CardHeader>
              <CardTitle>{sectionTitle(section.key)}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
                {section.entries.map((entry) => (
                  <div className="contents" key={entry.key}>
                    <dt className="text-muted-foreground" title={entry.key}>
                      {settingLabel(entry.key)}
                    </dt>
                    <dd className="min-w-0 text-right break-words">{formatSetting(entry.key, entry.value)}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        ))}
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
