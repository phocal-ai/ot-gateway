"use client"
/**
 * The Gateway and Broker cards' edit mode on the Settings tab. Edit reads the config file as it is on disk (with
 * its ETag), the form changes only that card's settings, every change is checked by the gateway while typing (the
 * same check as `ot-gateway check`, issues under their field), and Save writes the file and applies it without a
 * restart. A save the gateway cannot start is rolled back there and the page says why; a file that changed in the
 * meantime is never overwritten: the page offers to load it again.
 */
import type { BrokerTest, ConfigIssue, EditStatus } from "@ot-gateway/api"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input, NativeSelect } from "@/components/ui/input"
import {
  type EditCard,
  editFields,
  type EditValues,
  hourMinute,
  isChanged,
  issuesByField,
  savedMessage,
  valuesFrom,
  withValues
} from "@/lib/editor"
import { checkConfig, fetchConfigFile, readToken, type SaveOutcome, saveConfig, storeToken } from "@/lib/editor-api"
import { type Outcome, testBroker } from "@/lib/setup-api"
import { settle } from "@/lib/status"

/** Check this long after the last key stroke. */
const CHECK_DELAY_MS = 400

type Form =
  | { readonly _tag: "loading" }
  | { readonly _tag: "unreadable"; readonly message: string }
  | { readonly _tag: "ready"; readonly text: string; readonly etag: string; readonly values: EditValues }

/** The broker's test as the form shows it: connecting while `outcome` is undefined. */
const BrokerResult = ({ outcome }: { readonly outcome: Outcome<BrokerTest> | undefined }) => {
  if (outcome === undefined) return <p className="text-sm text-muted-foreground">Connecting…</p>
  if (outcome._tag !== "ok")
    return (
      <p className="text-sm break-words text-destructive" role="status">
        {outcome._tag === "busy" ? `Try again in a moment: ${outcome.message}` : `Not tested: ${outcome.message}`}
      </p>
    )
  const result = outcome.value
  return (
    <div className="grid gap-1 text-sm" role="status">
      {result.ok ? (
        <p className="text-success">
          Connected to {result.broker}
          {result.protocolVersion === undefined ? "" : ` with MQTT ${result.protocolVersion}`}
          {result.roundTripMs === undefined ? "" : `; a test message came back in ${Math.round(result.roundTripMs)} ms`}
          .
        </p>
      ) : (
        <p className="break-words text-destructive">
          No connection: {result.error ?? `no answer from ${result.broker}`}
        </p>
      )}
      {result.warnings.map((warning) => (
        <p className="text-xs text-muted-foreground" key={warning}>
          {warning}
        </p>
      ))}
    </div>
  )
}

type Saving =
  | { readonly _tag: "idle" }
  | { readonly _tag: "saving" }
  | { readonly _tag: "done"; readonly outcome: SaveOutcome }

export const EditForm = ({
  card,
  edit,
  onDone
}: {
  readonly card: EditCard
  readonly edit: EditStatus
  /** Closed: `saved` says it saved, so the page reads the running config again. */
  readonly onDone: (saved: string | undefined) => void
}) => {
  const [form, setForm] = useState<Form>({ _tag: "loading" })
  const [issues, setIssues] = useState<ReadonlyArray<ConfigIssue>>([])
  const [saving, setSaving] = useState<Saving>({ _tag: "idle" })
  const [token, setToken] = useState(() => readToken() ?? "")
  /** The broker test: not run, running (no outcome yet) or done. */
  const [brokerTest, setBrokerTest] = useState<{ readonly outcome: Outcome<BrokerTest> | undefined } | undefined>(
    undefined
  )
  const checkRun = useRef(0)

  const load = () => {
    setForm({ _tag: "loading" })
    setSaving({ _tag: "idle" })
    setIssues([])
    void settle(fetchConfigFile).then((result) => {
      if (result._tag === "Failure") return setForm({ _tag: "unreadable", message: result.failure.message })
      const values = valuesFrom(result.success.text, card)
      if (values === undefined)
        return setForm({
          _tag: "unreadable",
          message: `${edit.path} is not a JSON object right now; fix it in the file, or restore ${edit.path}.bak.`
        })
      setForm({ _tag: "ready", text: result.success.text, etag: result.success.etag, values })
    })
  }
  // Read the file once, when the form opens.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [])

  // Check the candidate as it is typed: the last answer wins, an older one that comes late is dropped.
  const candidate = form._tag === "ready" ? withValues(form.text, card, form.values) : undefined
  useEffect(() => {
    if (candidate === undefined) return
    const run = ++checkRun.current
    const timer = setTimeout(() => {
      void Effect.runPromise(Effect.result(checkConfig(candidate))).then((result) => {
        // No answer to a check is no news: the save checks again.
        if (run === checkRun.current && result._tag === "Success") setIssues(result.success.issues)
      })
    }, CHECK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [candidate])

  if (form._tag === "loading") return <p className="text-sm text-muted-foreground">Reading the config file…</p>
  if (form._tag === "unreadable")
    return (
      <div className="grid gap-3 text-sm">
        <p className="text-destructive">{form.message}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={load}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDone(undefined)}>
            Cancel
          </Button>
        </div>
      </div>
    )

  const { byField, elsewhere } = issuesByField(issues, card)
  const changed = isChanged(form.text, card, form.values)
  const busy = saving._tag === "saving"
  const setValue = (key: string, value: string) => setForm({ ...form, values: { ...form.values, [key]: value } })

  const save = () => {
    if (candidate === undefined) return
    if (edit.auth === "token") storeToken(token)
    setSaving({ _tag: "saving" })
    void Effect.runPromise(saveConfig(candidate, form.etag)).then((outcome) => {
      if (outcome._tag === "saved") return onDone(savedMessage(outcome.saved.applied, hourMinute(Date.now())))
      if (outcome._tag === "invalid") setIssues(outcome.issues)
      setSaving({ _tag: "done", outcome })
    })
  }

  const runBrokerTest = () => {
    if (candidate === undefined) return
    if (edit.auth === "token") storeToken(token)
    setBrokerTest({ outcome: undefined })
    void Effect.runPromise(testBroker(candidate)).then((result) => {
      if (result._tag === "invalid") setIssues(result.issues)
      setBrokerTest({ outcome: result })
    })
  }

  const outcome = saving._tag === "done" ? saving.outcome : undefined
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      {editFields[card].map((field) => {
        const id = `edit-${card}-${field.key}`
        const fieldIssues = byField[field.key] ?? []
        const value = form.values[field.key] ?? ""
        return (
          <div className="grid gap-1.5" key={field.key}>
            <label className="text-sm font-medium" htmlFor={id}>
              {field.label}
              {field.optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
            </label>
            {field.kind === "choice" ? (
              <NativeSelect
                id={id}
                value={value === "" ? "auto" : value}
                onChange={(event) => setValue(field.key, event.target.value)}
                disabled={busy}
              >
                {field.choices?.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <Input
                id={id}
                value={value}
                inputMode={field.kind === "number" ? "numeric" : undefined}
                placeholder={field.placeholder}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={fieldIssues.length > 0}
                aria-describedby={`${id}-help`}
                onChange={(event) => setValue(field.key, event.target.value)}
                disabled={busy}
              />
            )}
            <div id={`${id}-help`} className="text-xs">
              {fieldIssues.map((message) => (
                <p className="text-destructive" key={message}>
                  {message}
                </p>
              ))}
              {fieldIssues.length === 0 && field.hint !== undefined ? (
                <p className="text-muted-foreground">{field.hint}</p>
              ) : null}
            </div>
          </div>
        )
      })}
      {card === "mqtt" && edit.password !== undefined ? (
        <p className="text-xs text-muted-foreground">
          The password stays in <code className="font-mono">ot-gateway.env</code> ({edit.password.variable}, now{" "}
          {edit.password.set ? "set" : "not set"}); this page never sees it.
        </p>
      ) : null}
      {card === "mqtt" ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={runBrokerTest}
              disabled={busy || (brokerTest !== undefined && brokerTest.outcome === undefined)}
            >
              Test the connection
            </Button>
            <span className="text-xs text-muted-foreground">With the settings above; nothing is saved.</span>
          </div>
          {brokerTest === undefined ? null : <BrokerResult outcome={brokerTest.outcome} />}
        </div>
      ) : null}
      {elsewhere.length > 0 ? (
        <div className="text-xs text-destructive">
          <p>Elsewhere in the file, which this form does not change:</p>
          <ul className="list-disc pl-5">
            {elsewhere.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {edit.auth === "token" ? (
        <div className="grid gap-1.5">
          <label className="text-sm font-medium" htmlFor={`edit-${card}-token`}>
            Edit token
          </label>
          <Input
            id={`edit-${card}-token`}
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={busy}
          />
          <p className="text-xs text-muted-foreground">
            OT_GATEWAY_EDIT_TOKEN from the gateway&apos;s ot-gateway.env; kept in this tab until it closes.
          </p>
        </div>
      ) : null}
      {outcome === undefined ? null : outcome._tag === "conflict" ? (
        <div className="grid gap-2 text-sm">
          <p className="text-destructive">
            The config file changed since this form opened (another browser, or an edit by hand), so nothing was saved.
          </p>
          <div>
            <Button size="sm" variant="outline" onClick={load}>
              Load the file again
            </Button>
          </div>
        </div>
      ) : outcome._tag === "invalid" ? (
        <p className="text-sm text-destructive">Not saved: the config has problems, shown above.</p>
      ) : outcome._tag === "saved" ? null : (
        <p className="text-sm break-words text-destructive">
          {outcome._tag === "refused" ? "Refused: " : "Not applied: "}
          {outcome.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !changed || issues.length > 0}>
          {busy ? "Saving and applying…" : "Save and apply"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onDone(undefined)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
