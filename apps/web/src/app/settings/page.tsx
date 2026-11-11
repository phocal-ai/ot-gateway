"use client"

/**
 * The Settings tab: the gateway's running config (`/api/config`), every default filled in. When the gateway lets
 * this page edit (`/api/config/edit`), the Gateway, Broker and BACnet/IP cards have an Edit button
 * (components/settings-editor.tsx), and the Devices card adds a Modbus TCP or BACnet/IP device, edits or removes one
 * (components/device-editor.tsx), finds BACnet devices and picks their objects (components/discover-panel.tsx), or
 * adds the devices of an uploaded points list or EDE file (components/import-panel.tsx). Every save writes the config
 * file and the gateway applies it without a restart; the saved note stays until it is dismissed or the next edit
 * starts, so nothing moves under the pointer, and while the setup guide runs, it links back to it.
 * When it does not let the page edit, the page says why and what to change.
 *
 * Links open a panel: `?add=modbus-tcp` or `?add=bacnet-ip` (a new device), `?edit=<device id>`, `?find=1`,
 * `?upload=1`, `?broker=1` opens the Broker card's form and `?bacnet=1` the BACnet/IP card's. A panel or form opened
 * this way, or from another panel, is scrolled into view with its first field focused.
 */
import type { ConfigView, EditStatus } from "@ot-gateway/api"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { DeviceEditor } from "@/components/device-editor"
import { DiscoverPanel } from "@/components/discover-panel"
import { ImportPanel } from "@/components/import-panel"
import { EditForm } from "@/components/settings-editor"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { type DeviceDraft, type EditableProtocol, isEditableProtocol } from "@/lib/device-editor"
import { type EditCard, isEditCard } from "@/lib/editor"
import { guideStarted } from "@/lib/first-run"
import { fetchEditStatus } from "@/lib/editor-api"
import { formatNumber } from "@/lib/format"
import { deviceAddress, deviceColumns, duration, formatSetting, sectionTitle, settingLabel } from "@/lib/settings"
import { fetchConfig, protocolName, settle } from "@/lib/status"

/** Try again after this long when the config did not come. */
const RETRY_MS = 5000

/** How long a panel opened by a link may take to show its first field (the form reads the config file first). */
const REVEAL_WAIT_MS = 3000

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
const editable = (key: string): EditCard | undefined => (isEditCard(key) ? key : undefined)

/** The element a card or the Devices panel is shown in, to scroll to. */
const cardElementId = (key: string) => `settings-${key}`

/** The first field a person types into, in `element`. */
const firstField = (element: HTMLElement) =>
  element.querySelector<HTMLElement>(
    "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])"
  )

/**
 * Scroll the element with `id` into view now, and focus its first field once it shows (a form reads the config
 * file before it has fields). Done once per call to `reveal`.
 */
const useReveal = () => {
  const [target, setTarget] = useState<{ readonly id: string; readonly at: number } | undefined>(undefined)
  useEffect(() => {
    if (target === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let scrolled = false
    const started = Date.now()
    const attempt = () => {
      const element = document.getElementById(target.id)
      if (element !== null && !scrolled) {
        element.scrollIntoView({ block: "start" })
        scrolled = true
      }
      const field = element === null ? null : firstField(element)
      if (field !== null) return field.focus({ preventScroll: true })
      if (Date.now() - started < REVEAL_WAIT_MS) timer = setTimeout(attempt, 50)
    }
    timer = setTimeout(attempt, 0)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [target])
  return (id: string) => setTarget({ id, at: Date.now() })
}

/** What the Devices card shows above its list. */
type DevicePanel =
  | {
      readonly _tag: "device"
      readonly id: string | undefined
      readonly protocol: EditableProtocol
      /** A discovered device's fields, for a new one. */
      readonly initial?: DeviceDraft
    }
  | { readonly _tag: "discover" }
  | { readonly _tag: "upload" }

/** The panel a link asks for (`?add=modbus-tcp`, `?edit=meter`, `?upload=1`). */
const panelFromLink = (search: string): DevicePanel | undefined => {
  const params = new URLSearchParams(search)
  const add = params.get("add")
  if (isEditableProtocol(add)) return { _tag: "device", id: undefined, protocol: add }
  const editId = params.get("edit")
  if (editId !== null && editId !== "") return { _tag: "device", id: editId, protocol: "modbus-tcp" }
  if (params.get("upload") !== null) return { _tag: "upload" }
  if (params.get("find") !== null) return { _tag: "discover" }
  return undefined
}

/** A save's result on its card: shown until it is dismissed or the next edit starts. */
interface Saved {
  readonly card: string
  readonly message: string
}

const SavedNote = ({
  saved,
  card,
  onDismiss
}: {
  readonly saved: Saved | undefined
  readonly card: string
  readonly onDismiss: () => void
}) =>
  saved?.card === card ? (
    <div
      role="status"
      className="mb-3 flex items-start gap-2 rounded-md border border-success/40 py-2 pr-1 pl-3 text-sm"
    >
      <p className="min-w-0 flex-1 break-words">
        {saved.message}
        {/* Someone setting the gateway up came from the Status tab's guide: lead them back to its next step. */}
        {guideStarted() ? (
          <>
            {" "}
            <Link className="underline underline-offset-4" href="/">
              Back to the setup guide
            </Link>
          </>
        ) : null}
      </p>
      <Button size="sm" variant="ghost" className="-my-1 h-7 shrink-0 px-2 text-xs" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  ) : null

/** What the BACnet/IP card says while no device uses BACnet, so the gateway opens no BACnet port yet. */
const BACNET_UNUSED =
  "No BACnet device yet: the gateway opens its BACnet/IP port with the first one. Find BACnet devices uses these settings: port 47808 and a broadcast to 255.255.255.255 unless changed here."

const SettingsPage = () => {
  const [reload, setReload] = useState(0)
  const load = useConfig(reload)
  const edit = useEditStatus(reload)
  const [editing, setEditing] = useState<EditCard | undefined>(undefined)
  const [panel, setPanel] = useState<DevicePanel | undefined>(undefined)
  const [saved, setSaved] = useState<Saved | undefined>(undefined)
  const reveal = useReveal()

  // A link's panel, once the page knows it may edit and shows the Devices card.
  const linked = useRef(false)
  useEffect(() => {
    if (linked.current || edit?.enabled !== true || load._tag !== "ok") return
    linked.current = true
    const params = new URLSearchParams(window.location.search)
    const card = params.get("broker") !== null ? "mqtt" : params.get("bacnet") !== null ? "bacnet" : undefined
    if (card !== undefined) {
      setEditing(card)
      window.history.replaceState(null, "", window.location.pathname)
      reveal(cardElementId(card))
      return
    }
    const fromLink = panelFromLink(window.location.search)
    if (fromLink === undefined) return
    setPanel(fromLink)
    window.history.replaceState(null, "", window.location.pathname)
    reveal(cardElementId("devices"))
    // `reveal` is a new function each render; the link is read once.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [edit, load._tag])

  if (load._tag !== "ok")
    return (
      <p className="text-muted-foreground">
        {load._tag === "failed" ? `The gateway does not answer: ${load.message}` : "Loading…"}
      </p>
    )
  const { sections, devices } = load.config
  const present = new Set(sections.map((section) => section.key))
  const canEdit = edit?.enabled === true
  const open = editing !== undefined || panel !== undefined
  const done = (card: string) => (message: string | undefined) => {
    setEditing(undefined)
    setPanel(undefined)
    if (message === undefined) return
    setSaved({ card, message })
    setReload((count) => count + 1)
  }
  const openPanel = (next: DevicePanel) => {
    setSaved(undefined)
    setPanel(next)
    reveal(cardElementId("devices"))
  }
  const openCard = (card: EditCard) => {
    setSaved(undefined)
    setPanel(undefined)
    setEditing(card)
    reveal(cardElementId(card))
  }
  const dismissSaved = () => setSaved(undefined)
  /** The BACnet/IP settings show as a card of their own only while a BACnet device uses them; editing, always. */
  const bacnetCard = canEdit && !present.has("bacnet")
  return (
    <>
      <div className="grid max-w-3xl gap-2 text-sm">
        {canEdit ? (
          <>
            <p>Change the settings here; they apply at once.</p>
            <p className="text-xs break-words text-muted-foreground">
              Saved to <code className="font-mono">{edit.path}</code>, the previous version kept as{" "}
              <code className="font-mono">.bak</code>.
            </p>
          </>
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
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {[...sections, ...(bacnetCard ? [{ key: "bacnet", entries: undefined }] : [])].map((section) => {
          const card = editable(section.key)
          return (
            <Card className="scroll-mt-4" id={cardElementId(section.key)} key={section.key}>
              <CardHeader className="flex items-center justify-between gap-2">
                <CardTitle>{sectionTitle(section.key)}</CardTitle>
                {card !== undefined && canEdit && !open ? (
                  <Button size="sm" variant="outline" className="-my-2" onClick={() => openCard(card)}>
                    Edit
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent>
                <SavedNote saved={saved} card={section.key} onDismiss={dismissSaved} />
                {card !== undefined && editing === card && edit !== undefined ? (
                  <EditForm card={card} edit={edit} onDone={done(card)} />
                ) : section.entries === undefined ? (
                  <p className="text-sm text-muted-foreground">{BACNET_UNUSED}</p>
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
      <Card className="scroll-mt-4 gap-0 py-0" id={cardElementId("devices")}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4">
          <h2 className="leading-none font-semibold">Devices</h2>
          {canEdit && !open ? (
            <div className="flex flex-wrap gap-2 sm:-my-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => openPanel({ _tag: "device", id: undefined, protocol: "modbus-tcp" })}
              >
                Add Modbus device
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openPanel({ _tag: "device", id: undefined, protocol: "bacnet-ip" })}
              >
                Add BACnet device
              </Button>
              <Button size="sm" variant="outline" onClick={() => openPanel({ _tag: "discover" })}>
                Find BACnet devices
              </Button>
              <Button size="sm" variant="outline" onClick={() => openPanel({ _tag: "upload" })}>
                Upload a points list
              </Button>
            </div>
          ) : null}
        </div>
        {saved?.card === "devices" ? (
          <div className="px-5 pt-4">
            <SavedNote saved={saved} card="devices" onDismiss={dismissSaved} />
          </div>
        ) : null}
        {panel !== undefined && edit !== undefined ? (
          <div className="border-b px-5 py-4">
            {panel._tag === "upload" ? (
              <ImportPanel edit={edit} onDone={done("devices")} />
            ) : panel._tag === "discover" ? (
              <DiscoverPanel
                onPicked={(initial) => {
                  setPanel({ _tag: "device", id: undefined, protocol: "bacnet-ip", initial })
                  reveal(cardElementId("devices"))
                }}
                onCancel={() => setPanel(undefined)}
                onBacnetSettings={() => openCard("bacnet")}
              />
            ) : (
              <DeviceEditor
                key={panel.id ?? `new-${panel.protocol}-${panel.initial?.deviceInstance ?? ""}`}
                edit={edit}
                deviceId={panel.id}
                protocol={panel.protocol}
                initial={panel.initial}
                onDone={done("devices")}
              />
            )}
          </div>
        ) : null}
        {devices.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            {canEdit
              ? "No devices yet: add one, find BACnet devices, or upload a points list."
              : "The config has no devices."}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">Device</TableHead>
                <TableHead className="hidden sm:table-cell">Address</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Read every</TableHead>
                <TableHead className="text-right">Points</TableHead>
                <TableHead className="hidden lg:table-cell">Other settings</TableHead>
                {canEdit ? (
                  <TableHead className="pr-2 text-right sm:pr-5">
                    <span className="sr-only">Edit</span>
                  </TableHead>
                ) : null}
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
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">
                      {typeof interval === "number" ? duration(interval) : "–"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(device.pointCount)}</TableCell>
                    <TableCell
                      className="hidden max-w-md truncate text-xs text-muted-foreground lg:table-cell"
                      title={others}
                    >
                      {others}
                    </TableCell>
                    {canEdit ? (
                      <TableCell className="pr-2 text-right sm:pr-5">
                        {isEditableProtocol(device.protocol) ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={open}
                            aria-label={`Edit ${device.id}`}
                            onClick={() => openPanel({ _tag: "device", id: device.id, protocol: "modbus-tcp" })}
                          >
                            Edit
                          </Button>
                        ) : null}
                      </TableCell>
                    ) : null}
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
