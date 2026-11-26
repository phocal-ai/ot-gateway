"use client"
/**
 * Adding the devices of a points list (CSV) or a BACnet EDE file from the browser: pick or drop the file, the gateway
 * checks it as `ot-gateway import --dry-run` does and says, device by device, what it would add or what keeps a device
 * out (with the line), and Add writes the config file and applies it without a restart. Nothing is added before Add.
 *
 * Without a terminal: the panel offers the template to download and says what each column means, from the gateway's
 * one description of the format (`/api/points/format`). A device whose id is taken on this gateway, or whose host is
 * wrong, gets another id, host or address here, without editing the file; the list is checked again with them.
 */
import type { EditStatus, ImportCheck, ImportDevice, PointsListFormat } from "@ot-gateway/api"
import { MAX_IMPORT_BYTES } from "@ot-gateway/api"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { hourMinute } from "@/lib/editor"
import { fetchConfigFile, readToken, storeToken } from "@/lib/editor-api"
import { formatNumber } from "@/lib/format"
import {
  columnNotes,
  type DeviceChange,
  type DeviceChanges,
  emptyChange,
  pageError,
  renamesOf,
  scopeLabel,
  templateHref,
  whereLabel
} from "@/lib/import"
import { applyImport, checkImport, fetchPointsListFormat, type Outcome } from "@/lib/setup-api"
import { protocolName, settle } from "@/lib/status"

interface Picked {
  readonly name: string
  readonly text: string
}

type State =
  | { readonly _tag: "empty" }
  | { readonly _tag: "reading"; readonly name: string }
  | { readonly _tag: "checked"; readonly file: Picked; readonly outcome: Outcome<ImportCheck> }
  | { readonly _tag: "adding"; readonly file: Picked; readonly check: ImportCheck }
  | { readonly _tag: "problem"; readonly message: string }

const plural = (count: number, word: string) => `${formatNumber(count)} ${word}${count === 1 ? "" : "s"}`

const lineList = (lines: ReadonlyArray<number>) => {
  if (lines.length === 0) return ""
  const first = lines[0]
  const last = lines.at(-1)
  return lines.length === 1 ? `line ${first}` : `lines ${first}–${last}`
}

/** The id and host (or address) a device of the list gets instead of the file's, checked again with Check again. */
const ChangeForm = ({
  device,
  change,
  onChange,
  onCheck,
  onClose,
  disabled
}: {
  readonly device: ImportDevice
  readonly change: DeviceChange
  readonly onChange: (change: DeviceChange) => void
  readonly onCheck: () => void
  readonly onClose: () => void
  readonly disabled: boolean
}) => {
  const key = `import-${device.lines[0] ?? 0}`
  return (
    <div className="mt-1 grid gap-2 sm:grid-cols-2">
      <div className="grid min-w-0 gap-1">
        <label className="text-xs font-medium" htmlFor={`${key}-id`}>
          Id on this gateway
        </label>
        <Input
          id={`${key}-id`}
          value={change.id}
          placeholder={device.id === "" ? "meter-2" : `${device.id}-2`}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange({ ...change, id: event.target.value })}
          disabled={disabled}
        />
      </div>
      <div className="grid min-w-0 gap-1">
        <label className="text-xs font-medium" htmlFor={`${key}-where`}>
          {whereLabel(device.protocol)} <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <Input
          id={`${key}-where`}
          value={change.where}
          placeholder={device.protocol === "bacnet-ip" ? "192.168.1.40" : "192.168.1.30"}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange({ ...change, where: event.target.value })}
          disabled={disabled}
        />
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-2">
        For every row of {device.name}; the file stays as it is. Empty fields keep what the file says.
      </p>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button size="sm" variant="outline" onClick={onCheck} disabled={disabled}>
          Check again
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={disabled}>
          Close
        </Button>
      </div>
    </div>
  )
}

/** The check's answer, device by device, each with a form to give it another id or host. */
const CheckList = ({
  check,
  changes,
  open,
  onOpen,
  onChange,
  onCheck,
  disabled
}: {
  readonly check: ImportCheck
  readonly changes: DeviceChanges
  /** The device whose change form is open, by its name in the list. */
  readonly open: string | undefined
  readonly onOpen: (name: string | undefined) => void
  readonly onChange: (name: string, change: DeviceChange) => void
  readonly onCheck: () => void
  readonly disabled: boolean
}) => (
  <div className="grid gap-2 text-sm">
    {check.error === undefined ? null : <p className="break-words text-destructive">{check.error}</p>}
    {check.devices.length === 0 ? null : (
      <ul className="grid gap-1.5">
        {check.devices.map((device) => (
          <li key={`${device.name}-${device.lines[0] ?? 0}`} className="grid gap-0.5 rounded-md border px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span aria-hidden className={device.error === undefined ? "text-success" : "text-destructive"}>
                  {device.error === undefined ? "✓" : "✗"}
                </span>
                <span className="font-medium break-all">{device.name}</span>
                <span className="text-xs text-muted-foreground">
                  {[
                    device.id === "" ? undefined : `id ${device.id}`,
                    device.protocol === undefined ? undefined : (protocolName[device.protocol] ?? device.protocol),
                    device.address,
                    plural(device.points, "point"),
                    lineList(device.lines)
                  ]
                    .filter((part) => part !== undefined && part !== "")
                    .join(" · ")}
                </span>
              </p>
              {open === device.name ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="-my-1 h-7 px-2 text-xs"
                  onClick={() => onOpen(device.name)}
                  disabled={disabled}
                  aria-label={`Change id or host of ${device.name}`}
                >
                  Change id or host
                </Button>
              )}
            </div>
            {device.error === undefined ? null : (
              <p className="text-xs break-words whitespace-pre-line text-destructive">
                <span className="sr-only">Not added: </span>
                {pageError(device.error)}
              </p>
            )}
            {open === device.name ? (
              <ChangeForm
                device={device}
                change={changes[device.name] ?? emptyChange}
                onChange={(change) => onChange(device.name, change)}
                onCheck={onCheck}
                onClose={() => onOpen(undefined)}
                disabled={disabled}
              />
            ) : null}
          </li>
        ))}
      </ul>
    )}
    {check.format === "ede" ? (
      <p className="text-xs text-muted-foreground">
        An EDE file: the gateway translated it into a points list, and the line numbers are that list&apos;s.
      </p>
    ) : null}
    {check.notes.map((note) => (
      <p key={note} className="text-xs break-words text-muted-foreground">
        {note}
      </p>
    ))}
  </div>
)

/** The template to download and what each column means, or the commands that print them when the gateway did not say. */
const FormatHelp = ({ format }: { readonly format: Outcome<PointsListFormat> | undefined }) => {
  if (format === undefined) return null
  if (format._tag !== "ok")
    return (
      <p className="text-xs text-muted-foreground">
        <code className="font-mono">ot-gateway points template</code> prints a list to fill in;{" "}
        <code className="font-mono">ot-gateway points schema</code> describes its columns.
      </p>
    )
  const { template, rules, columns } = format.value
  const scopes = ["any", "modbus-tcp", "bacnet-ip"] as const
  return (
    <div className="grid gap-2">
      <p>
        <a
          className="text-sm underline underline-offset-4"
          href={templateHref(template)}
          download="points.csv"
          type="text/csv"
        >
          Download a template (CSV)
        </a>
        <span className="text-xs text-muted-foreground">
          {" "}
          with every column and example rows: fill it in with a spreadsheet, one row per value.
        </span>
      </p>
      <details className="text-xs">
        <summary className="cursor-pointer text-sm text-muted-foreground">What the columns mean</summary>
        <div className="mt-2 grid gap-3">
          <ul className="list-disc pl-5 text-muted-foreground">
            {rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
          {scopes.map((scope) => (
            <div key={scope} className="grid gap-1">
              <p className="font-medium">{scopeLabel[scope]}</p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                {columns
                  .filter((column) => column.scope === scope)
                  .map((column) => {
                    const notes = columnNotes(column)
                    return (
                      <div className="contents" key={column.name}>
                        <dt className="font-mono">{column.name}</dt>
                        <dd className="break-words text-muted-foreground">
                          {column.description}
                          {notes.length === 0 ? "" : ` (${notes.join("; ")})`}
                        </dd>
                      </div>
                    )
                  })}
              </dl>
            </div>
          ))}
          <p className="text-muted-foreground">
            On a command line, <code className="font-mono">ot-gateway points template</code> and{" "}
            <code className="font-mono">ot-gateway points schema</code> print the same.
          </p>
        </div>
      </details>
    </div>
  )
}

export const ImportPanel = ({
  edit,
  onDone
}: {
  readonly edit: EditStatus
  /** Closed: `added` says what was added, so the page reads the running config again. */
  readonly onDone: (added: string | undefined) => void
}) => {
  const [state, setState] = useState<State>({ _tag: "empty" })
  const [dragging, setDragging] = useState(false)
  const [addFailed, setAddFailed] = useState<string | undefined>(undefined)
  const [token, setToken] = useState(() => readToken() ?? "")
  const [changes, setChanges] = useState<DeviceChanges>({})
  const [open, setOpen] = useState<string | undefined>(undefined)
  const [format, setFormat] = useState<Outcome<PointsListFormat> | undefined>(undefined)
  const [rechecking, setRechecking] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // The template and the columns, once, when the panel opens.
  useEffect(() => {
    let cancelled = false
    void Effect.runPromise(fetchPointsListFormat).then((outcome) => {
      if (!cancelled) setFormat(outcome)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const pick = (file: File | undefined) => {
    setAddFailed(undefined)
    if (file === undefined) return
    if (file.size > MAX_IMPORT_BYTES)
      return setState({
        _tag: "problem",
        message: `${file.name} is ${formatNumber(Math.round(file.size / 1024))} KiB; a points list may be at most ${formatNumber(MAX_IMPORT_BYTES / 1024)} KiB.`
      })
    setState({ _tag: "reading", name: file.name })
    setChanges({})
    setOpen(undefined)
    if (edit.auth === "token") storeToken(token)
    void file
      .text()
      .then((text) => Effect.runPromise(checkImport(text, file.name)).then((outcome) => ({ text, outcome })))
      .then(
        ({ text, outcome }) => setState({ _tag: "checked", file: { name: file.name, text }, outcome }),
        () => setState({ _tag: "problem", message: `${file.name} could not be read in this browser.` })
      )
  }

  /** The file checked again with the changes typed so far. */
  const recheck = (file: Picked, check: ImportCheck) => {
    if (edit.auth === "token") storeToken(token)
    setAddFailed(undefined)
    setRechecking(true)
    void Effect.runPromise(checkImport(file.text, file.name, renamesOf(changes, check.devices))).then((outcome) => {
      setRechecking(false)
      // The list stays as it was when the check did not come back; the problem shows above Add.
      if (outcome._tag !== "ok") return setAddFailed(`not checked again: ${outcome.message}`)
      setState({ _tag: "checked", file, outcome })
      setOpen(undefined)
    })
  }

  const add = (file: Picked, check: ImportCheck) => {
    if (edit.auth === "token") storeToken(token)
    setAddFailed(undefined)
    setState({ _tag: "adding", file, check })
    void settle(fetchConfigFile)
      .then((current) =>
        current._tag === "Failure"
          ? ({ _tag: "failed", message: current.failure.message } as const)
          : Effect.runPromise(
              applyImport(file.text, file.name, current.success.etag, renamesOf(changes, check.devices))
            )
      )
      .then((outcome) => {
        if (outcome._tag === "ok") {
          const { devices, points, skipped } = outcome.value
          return onDone(
            `Added ${plural(devices, "device")} with ${plural(points, "point")} at ${hourMinute(Date.now())}${
              skipped === 0 ? "" : `; left out ${plural(skipped, "device")} with mistakes`
            }.`
          )
        }
        setState({ _tag: "checked", file, outcome: { _tag: "ok", value: check } })
        setAddFailed(
          outcome._tag === "invalid"
            ? [outcome.message, ...outcome.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)].join(
                "; "
              )
            : outcome._tag === "conflict"
              ? "The settings changed meanwhile; check the file again, then add."
              : outcome.message
        )
      })
  }

  // A file whose check came back: what it adds, with the Add button under it.
  const checked =
    state._tag === "adding"
      ? { file: state.file, check: state.check }
      : state._tag === "checked" && state.outcome._tag === "ok"
        ? { file: state.file, check: state.outcome.value }
        : undefined
  const adding = state._tag === "adding" || rechecking
  return (
    <div className="grid gap-3">
      <div
        className={`grid gap-2 rounded-md border border-dashed p-4 text-sm ${dragging ? "border-ring bg-muted" : ""}`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          pick(event.dataTransfer.files[0])
        }}
      >
        <p>
          A points list (CSV, one row per value) or a BACnet EDE file. Drop it here, or{" "}
          <Button size="sm" variant="outline" onClick={() => input.current?.click()} disabled={adding}>
            choose a file
          </Button>
        </p>
        <input
          ref={input}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="sr-only"
          aria-label="Points list or EDE file"
          tabIndex={-1}
          onChange={(event) => {
            pick(event.target.files?.[0])
            event.target.value = ""
          }}
        />
        <p className="text-xs text-muted-foreground">Nothing is added before you choose Add.</p>
        <FormatHelp format={format} />
      </div>
      {state._tag === "reading" ? (
        <p className="text-sm text-muted-foreground" role="status">
          Checking {state.name}…
        </p>
      ) : state._tag === "problem" ? (
        <p className="text-sm break-words text-destructive" role="alert">
          {state.message}
        </p>
      ) : state._tag === "checked" && state.outcome._tag !== "ok" ? (
        <p className="text-sm break-words text-destructive" role="alert">
          Not checked: {state.outcome.message}
        </p>
      ) : null}
      {checked === undefined ? null : (
        <section className="grid gap-3" aria-label={`What ${checked.file.name} adds`}>
          <CheckList
            check={checked.check}
            changes={changes}
            open={open}
            onOpen={setOpen}
            onChange={(name, change) => setChanges((current) => ({ ...current, [name]: change }))}
            onCheck={() => recheck(checked.file, checked.check)}
            disabled={adding}
          />
        </section>
      )}
      {edit.auth === "token" ? (
        <div className="grid gap-1.5">
          <label className="text-sm font-medium" htmlFor="import-token">
            Edit token
          </label>
          <Input
            id="import-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={adding}
          />
        </div>
      ) : null}
      {addFailed === undefined ? null : (
        <div className="flex items-start justify-between gap-2 text-sm text-destructive" role="alert">
          <p className="break-words">Not added: {addFailed}</p>
          <Button size="sm" variant="ghost" onClick={() => setAddFailed(undefined)}>
            Dismiss
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {checked === undefined ? null : (
          <Button
            size="sm"
            onClick={() => add(checked.file, checked.check)}
            disabled={adding || checked.check.adds.devices === 0}
          >
            {rechecking
              ? "Checking again…"
              : adding
                ? "Adding and applying…"
                : checked.check.adds.devices === 0
                  ? "Nothing to add"
                  : `Add ${plural(checked.check.adds.devices, "device")} with ${plural(checked.check.adds.points, "point")}`}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => onDone(undefined)} disabled={adding}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
