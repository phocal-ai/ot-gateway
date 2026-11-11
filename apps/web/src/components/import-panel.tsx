"use client"
/**
 * Adding the devices of a points list (CSV, the columns `ot-gateway points schema` describes) or a BACnet EDE file
 * from the browser: pick or drop the file, the gateway checks it as `ot-gateway import --dry-run` does and says, device
 * by device, what it would add or what keeps a device out (with the line), and Add writes the config file and
 * applies it without a restart. Nothing is added before Add.
 */
import type { EditStatus, ImportCheck } from "@ot-gateway/api"
import { MAX_IMPORT_BYTES } from "@ot-gateway/api"
import { Effect } from "effect"
import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { hourMinute } from "@/lib/editor"
import { fetchConfigFile, readToken, storeToken } from "@/lib/editor-api"
import { formatNumber } from "@/lib/format"
import { applyImport, checkImport, type Outcome } from "@/lib/setup-api"
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

/** The check's answer, device by device. */
const CheckList = ({ check }: { readonly check: ImportCheck }) => (
  <div className="grid gap-2 text-sm">
    {check.error === undefined ? null : <p className="break-words text-destructive">{check.error}</p>}
    {check.devices.length === 0 ? null : (
      <ul className="grid gap-1.5">
        {check.devices.map((device) => (
          <li key={`${device.name}-${device.lines[0] ?? 0}`} className="grid gap-0.5 rounded-md border px-3 py-2">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span aria-hidden className={device.error === undefined ? "text-success" : "text-destructive"}>
                {device.error === undefined ? "✓" : "✗"}
              </span>
              <span className="font-medium break-all">{device.name}</span>
              <span className="text-xs text-muted-foreground">
                {[
                  device.protocol === undefined ? undefined : (protocolName[device.protocol] ?? device.protocol),
                  device.address,
                  plural(device.points, "point"),
                  lineList(device.lines)
                ]
                  .filter((part) => part !== undefined && part !== "")
                  .join(" · ")}
              </span>
            </p>
            {device.error === undefined ? null : (
              <p className="text-xs break-words text-destructive">
                <span className="sr-only">Not added: </span>
                {device.error}
              </p>
            )}
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
  const input = useRef<HTMLInputElement>(null)

  const pick = (file: File | undefined) => {
    setAddFailed(undefined)
    if (file === undefined) return
    if (file.size > MAX_IMPORT_BYTES)
      return setState({
        _tag: "problem",
        message: `${file.name} is ${formatNumber(Math.round(file.size / 1024))} KiB; a points list may be at most ${formatNumber(MAX_IMPORT_BYTES / 1024)} KiB.`
      })
    setState({ _tag: "reading", name: file.name })
    if (edit.auth === "token") storeToken(token)
    void file
      .text()
      .then((text) => Effect.runPromise(checkImport(text, file.name)).then((outcome) => ({ text, outcome })))
      .then(
        ({ text, outcome }) => setState({ _tag: "checked", file: { name: file.name, text }, outcome }),
        () => setState({ _tag: "problem", message: `${file.name} could not be read in this browser.` })
      )
  }

  const add = (file: Picked, check: ImportCheck) => {
    if (edit.auth === "token") storeToken(token)
    setAddFailed(undefined)
    setState({ _tag: "adding", file, check })
    void settle(fetchConfigFile)
      .then((current) =>
        current._tag === "Failure"
          ? ({ _tag: "failed", message: current.failure.message } as const)
          : Effect.runPromise(applyImport(file.text, file.name, current.success.etag))
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
              ? "The config file changed meanwhile; check the file again, then add."
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
  const adding = state._tag === "adding"
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
        <p className="text-xs text-muted-foreground">
          <code className="font-mono">ot-gateway points template</code> prints a list to fill in;{" "}
          <code className="font-mono">ot-gateway points schema</code> describes its columns. Nothing is added before you
          choose Add.
        </p>
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
          <CheckList check={checked.check} />
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
            {adding
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
