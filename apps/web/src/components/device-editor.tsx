"use client"
/**
 * Adding or editing one Modbus TCP or BACnet/IP device on the Settings tab. The form reads the config file as it is
 * on disk (with its ETag) and changes only this device; the gateway checks every change while typing (issues under
 * their field), Test reads the device or one point with the settings as typed, before anything is saved (one read
 * over a connection of its own), and Save writes the file and applies it without a restart, as the Gateway and
 * Broker cards do. Remove takes the device out of the file, after a confirmation.
 */
import type { ConfigIssue, EditStatus, PointTest, ReadTest } from "@ot-gateway/api"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input, NativeSelect } from "@/components/ui/input"
import {
  alarmChoices,
  byteOrders,
  canWrite,
  type DeviceDraft,
  deviceDraft,
  deviceIssues,
  dataTypes,
  deviceIndex,
  devicesOf,
  type EditableProtocol,
  isBoolean,
  isDeviceChanged,
  newDevice,
  newPoint,
  objectTypes,
  type PointDraft,
  pointSource,
  publishModes,
  readsBits,
  slugify,
  tables,
  takesLimits,
  type Touched,
  touching,
  unitChoices,
  visibleIssues,
  withDevice,
  withoutDevice
} from "@/lib/device-editor"
import { hourMinute, savedMessage } from "@/lib/editor"
import { checkConfig, fetchConfigFile, readToken, type SaveOutcome, saveConfig, storeToken } from "@/lib/editor-api"
import { whatToCheck } from "@ot-gateway/api"
import { type Outcome, testRead } from "@/lib/setup-api"
import { formatValue, protocolName, settle, unitLabel } from "@/lib/status"

/** Check this long after the last key stroke. */
const CHECK_DELAY_MS = 400

type Form =
  | { readonly _tag: "loading" }
  | { readonly _tag: "unreadable"; readonly message: string }
  | {
      readonly _tag: "ready"
      readonly text: string
      readonly etag: string
      /** Where the device is (or will be) in the file's devices. */
      readonly index: number
      readonly isNew: boolean
      readonly draft: DeviceDraft
    }

type Saving =
  | { readonly _tag: "idle" }
  | { readonly _tag: "saving"; readonly removing: boolean }
  | { readonly _tag: "done"; readonly outcome: SaveOutcome }

/** A test as the page shows it: running, or what came back (for the device, or for one point by its key). */
type TestState = { readonly _tag: "running" } | { readonly _tag: "done"; readonly outcome: Outcome<ReadTest> }

const fieldClass = "grid min-w-0 gap-1.5"
const labelClass = "text-sm font-medium"

const deviceField = (field: string) => `device-${field}`

const Messages = ({
  id,
  messages,
  hint
}: {
  readonly id: string
  readonly messages?: ReadonlyArray<string> | undefined
  readonly hint?: string | undefined
}) => (
  <div id={id} className="text-xs">
    {(messages ?? []).map((message) => (
      <p className="text-destructive" key={message}>
        {message}
      </p>
    ))}
    {(messages ?? []).length === 0 && hint !== undefined ? <p className="text-muted-foreground">{hint}</p> : null}
  </div>
)

interface FieldProps {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly issues?: ReadonlyArray<string> | undefined
  readonly hint?: string | undefined
  readonly placeholder?: string | undefined
  readonly optional?: boolean
  readonly numeric?: boolean
  readonly list?: string
  readonly disabled: boolean
}

const TextField = (props: FieldProps) => (
  <div className={fieldClass}>
    <label className={labelClass} htmlFor={props.id}>
      {props.label}
      {props.optional === true ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
    </label>
    <Input
      id={props.id}
      value={props.value}
      placeholder={props.placeholder}
      inputMode={props.numeric === true ? "decimal" : undefined}
      list={props.list}
      autoComplete="off"
      spellCheck={false}
      aria-invalid={(props.issues ?? []).length > 0}
      aria-describedby={`${props.id}-help`}
      onChange={(event) => props.onChange(event.target.value)}
      disabled={props.disabled}
    />
    <Messages id={`${props.id}-help`} messages={props.issues} hint={props.hint} />
  </div>
)

const SelectField = ({
  id,
  label,
  value,
  onChange,
  choices,
  issues,
  disabled
}: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly choices: ReadonlyArray<{ readonly value: string; readonly label: string }>
  readonly issues?: ReadonlyArray<string> | undefined
  readonly disabled: boolean
}) => (
  <div className={fieldClass}>
    <label className={labelClass} htmlFor={id}>
      {label}
    </label>
    <NativeSelect
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      aria-describedby={`${id}-help`}
    >
      {choices.some((choice) => choice.value === value) ? null : <option value={value}>{value}</option>}
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </NativeSelect>
    <Messages id={`${id}-help`} messages={issues} />
  </div>
)

/** What to check, for a failed read. */
const Hint = ({
  protocol,
  reason,
  error
}: {
  readonly protocol: EditableProtocol
  readonly reason: string
  readonly error: string
}) => {
  const hint = whatToCheck(protocol, reason, error)
  return (
    <div className="text-xs text-muted-foreground">
      <p>{hint.meaning}</p>
      <ul className="list-disc pl-5">
        {hint.checks.map((check) => (
          <li key={check}>{check}</li>
        ))}
      </ul>
    </div>
  )
}

/** One point's read: its value and unit, or why not and what to check. */
const PointResult = ({ protocol, result }: { readonly protocol: EditableProtocol; readonly result: PointTest }) =>
  result.error === undefined ? (
    <p className="text-sm" role="status">
      <span className="font-medium tabular-nums">
        {formatValue(result.value)}
        {result.unit === undefined ? "" : ` ${unitLabel(result.unit)}`}
      </span>
      {result.raw === undefined ? null : (
        <span className="text-muted-foreground"> (the device sent {formatValue(result.raw)})</span>
      )}
    </p>
  ) : (
    <div className="grid gap-1" role="status">
      <p className="text-sm break-words text-destructive">Not read: {result.error.message}</p>
      <Hint protocol={protocol} reason={result.error.reason} error={result.error.message} />
    </div>
  )

/** What a test that did not read says. */
const TestProblem = ({ outcome }: { readonly outcome: Exclude<Outcome<ReadTest>, { readonly _tag: "ok" }> }) => (
  <p className="text-sm break-words text-destructive" role="status">
    {outcome._tag === "busy" ? `Try again in a moment: ${outcome.message}` : `Not tested: ${outcome.message}`}
  </p>
)

/** The device's test: how many points were read and how long it took, or why not, with the note and the hints. */
const DeviceResult = ({ protocol, test }: { readonly protocol: EditableProtocol; readonly test: TestState }) => {
  if (test._tag === "running") return <p className="text-sm text-muted-foreground">Reading the device…</p>
  const outcome = test.outcome
  if (outcome._tag !== "ok") return <TestProblem outcome={outcome} />
  const result = outcome.value
  const read = result.points.filter((point) => point.error === undefined).length
  return (
    <div className="grid gap-1 text-sm" role="status">
      {result.error === undefined ? (
        <p className={result.ok ? "text-success" : undefined}>
          {result.ok ? "It answers: " : "It answers, but not for every point: "}
          read {read} of {result.points.length} point{result.points.length === 1 ? "" : "s"} from {result.target} in{" "}
          {Math.round(result.durationMs)} ms.
        </p>
      ) : (
        <>
          <p className="break-words text-destructive">
            No answer from {result.target}: {result.error.message}
          </p>
          <Hint protocol={protocol} reason={result.error.reason} error={result.error.message} />
        </>
      )}
      {result.note === undefined ? null : <p className="text-muted-foreground">{result.note}</p>}
    </div>
  )
}

const PointFields = ({
  protocol,
  deviceId,
  point,
  position,
  issues,
  onChange,
  disabled
}: {
  readonly protocol: EditableProtocol
  readonly deviceId: string
  readonly point: PointDraft
  readonly position: number
  readonly issues: Readonly<Record<string, ReadonlyArray<string>>>
  /** The point as changed, and the field that changed (for the issues to show). */
  readonly onChange: (point: PointDraft, field: string) => void
  readonly disabled: boolean
}) => {
  const id = (field: string) => `point-${point.key}-${field}`
  const set = (field: keyof PointDraft) => (value: string) => onChange({ ...point, [field]: value }, field)
  const bits = protocol === "modbus-tcp" && readsBits(point)
  const wide = !bits && !["int16", "uint16", "bool", ""].includes(point.dataType)
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField
        id={id("name")}
        label="Name"
        value={point.name}
        placeholder={position === 0 ? "Active power" : undefined}
        issues={issues["name"]}
        onChange={(name) => onChange({ ...point, name, id: point.autoId ? slugify(name) : point.id }, "name")}
        disabled={disabled}
      />
      <TextField
        id={id("id")}
        label="Id"
        value={point.id}
        hint="The last part of its topic."
        issues={issues["id"]}
        onChange={(value) => onChange({ ...point, id: value, autoId: false }, "id")}
        disabled={disabled}
      />
      {protocol === "modbus-tcp" ? (
        <>
          <SelectField
            id={id("table")}
            label="Table"
            value={point.table}
            choices={tables}
            issues={issues["table"]}
            onChange={set("table")}
            disabled={disabled}
          />
          <TextField
            id={id("register")}
            label="Address"
            value={point.register}
            numeric
            hint="Counted from 0: 40101 in a register map is often 100."
            issues={issues["register"]}
            onChange={set("register")}
            disabled={disabled}
          />
          {bits ? null : (
            <SelectField
              id={id("dataType")}
              label="Data type"
              value={point.dataType}
              choices={dataTypes.filter((type) => type !== "bool").map((type) => ({ value: type, label: type }))}
              issues={issues["dataType"]}
              onChange={set("dataType")}
              disabled={disabled}
            />
          )}
        </>
      ) : (
        <>
          <SelectField
            id={id("objectType")}
            label="Object type"
            value={point.objectType}
            choices={objectTypes.map((type) => ({ value: type, label: type }))}
            issues={issues["objectType"]}
            onChange={set("objectType")}
            disabled={disabled}
          />
          <TextField
            id={id("instance")}
            label="Instance"
            value={point.instance}
            numeric
            issues={issues["instance"]}
            onChange={set("instance")}
            disabled={disabled}
          />
        </>
      )}
      {bits ? null : (
        <TextField
          id={id("unit")}
          label="Unit"
          value={point.unit}
          optional
          list="unit-choices"
          placeholder="kW"
          hint="kW, °C, %, or a QUDT name such as unit:KiloW."
          issues={issues["unit"]}
          onChange={set("unit")}
          disabled={disabled}
        />
      )}
      {isBoolean(protocol, point) ? (
        <SelectField
          id={id("alarmWhen")}
          label="Alarm"
          value={point.alarmWhen}
          choices={alarmChoices}
          issues={issues["alarmWhen"]}
          onChange={set("alarmWhen")}
          disabled={disabled}
        />
      ) : null}
      <details className="sm:col-span-2" open={issues["scale"] !== undefined || issues["publish"] !== undefined}>
        <summary className="cursor-pointer text-sm text-muted-foreground">
          {protocol === "modbus-tcp" && !bits ? "Scaling, word order and sending" : "Sending"}
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {protocol === "modbus-tcp" && !bits ? (
            <>
              <TextField
                id={id("scale")}
                label="Multiply by"
                value={point.scale}
                optional
                numeric
                placeholder="1"
                hint="0.1 when the device sends tenths."
                issues={issues["scale"]}
                onChange={set("scale")}
                disabled={disabled}
              />
              <TextField
                id={id("offset")}
                label="Then add"
                value={point.offset}
                optional
                numeric
                placeholder="0"
                onChange={set("offset")}
                disabled={disabled}
              />
              {wide ? (
                <SelectField
                  id={id("byteOrder")}
                  label="Word order"
                  value={point.byteOrder}
                  choices={byteOrders}
                  issues={issues["byteOrder"]}
                  onChange={set("byteOrder")}
                  disabled={disabled}
                />
              ) : null}
            </>
          ) : null}
          <SelectField
            id={id("publish")}
            label="Send"
            value={point.publish}
            choices={publishModes}
            issues={issues["publish"]}
            onChange={set("publish")}
            disabled={disabled}
          />
          {point.publish === "change" ? (
            <TextField
              id={id("deadband")}
              label="Smallest change"
              value={point.deadband}
              optional
              numeric
              hint="Left empty, any change is sent."
              issues={issues["deadband"]}
              onChange={set("deadband")}
              disabled={disabled}
            />
          ) : point.publish === "sample" || point.publish === "aggregate" ? (
            <TextField
              id={id("publishSeconds")}
              label="Every (seconds)"
              value={point.publishSeconds}
              optional={point.publish === "sample"}
              numeric
              placeholder="60"
              hint="A divisor of a day: 60, 300, 900."
              onChange={set("publishSeconds")}
              disabled={disabled}
            />
          ) : null}
        </div>
      </details>
      {canWrite(protocol, point) || point.writable ? (
        <Commands
          protocol={protocol}
          deviceId={deviceId}
          point={point}
          issues={issues}
          onChange={onChange}
          disabled={disabled}
        />
      ) : null}
    </div>
  )
}

/**
 * Whether commands may write a point: off unless set on purpose. Turning it on needs the point's limits (a numeric
 * one) and a confirmation that names the point and what it controls. The page itself never writes a value: commands
 * go through MQTT and the gateway's command guard, which checks the limits and logs each one.
 */
const Commands = ({
  protocol,
  deviceId,
  point,
  issues,
  onChange,
  disabled
}: {
  readonly protocol: EditableProtocol
  readonly deviceId: string
  readonly point: PointDraft
  readonly issues: Readonly<Record<string, ReadonlyArray<string>>>
  readonly onChange: (point: PointDraft, field: string) => void
  readonly disabled: boolean
}) => {
  const [confirming, setConfirming] = useState(false)
  const id = (field: string) => `point-${point.key}-${field}`
  const limits = takesLimits(protocol, point)
  const name = point.name.trim() || point.id.trim() || "this point"
  const path = `${deviceId.trim() || "device"}/${point.id.trim() || "point"}`
  const limitsTyped = point.limitMin.trim() !== "" && point.limitMax.trim() !== ""
  const range = `${point.limitMin.trim()} to ${point.limitMax.trim()}${point.unit.trim() === "" ? "" : ` ${point.unit.trim()}`}`
  const limitFields = (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField
        id={id("limitMin")}
        label="Lowest value a command may set"
        value={point.limitMin}
        numeric
        issues={issues["limits"]}
        onChange={(value) => onChange({ ...point, limitMin: value }, "limits")}
        disabled={disabled}
      />
      <TextField
        id={id("limitMax")}
        label="Highest value a command may set"
        value={point.limitMax}
        numeric
        hint={point.unit.trim() === "" ? "In the value's units, after scaling." : `In ${point.unit.trim()}.`}
        onChange={(value) => onChange({ ...point, limitMax: value }, "limits")}
        disabled={disabled}
      />
    </div>
  )
  return (
    <div className="grid gap-2 sm:col-span-2">
      <p className="text-sm font-medium">Commands</p>
      {point.writable ? (
        <>
          <p className="text-sm">
            Takes commands on <code className="font-mono text-xs break-all">…/{path}/$set</code>
            {limits && limitsTyped ? `, within ${range}` : ""}. The gateway checks and logs every one.
          </p>
          {limits ? limitFields : null}
          <Messages id={`${id("writable")}-help`} messages={issues["writable"]} />
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onChange({ ...point, writable: false }, "writable")}
              disabled={disabled}
            >
              Make it read-only
            </Button>
          </div>
        </>
      ) : confirming ? (
        <div className="grid gap-3 rounded-md border border-destructive/40 p-3 text-sm" role="alert">
          {limits ? limitFields : null}
          <p>
            Allow commands to change <span className="font-medium">{name}</span> ({pointSource(protocol, point)}) on the
            device? A message on <code className="font-mono text-xs break-all">…/{path}/$set</code> then sets it
            {limits ? (limitsTyped ? `, within ${range}` : ", within the limits above") : ""}, and whatever it controls
            follows. This page itself never writes a value.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                setConfirming(false)
                onChange({ ...point, writable: true }, "writable")
              }}
              disabled={disabled || (limits && !limitsTyped)}
            >
              Allow commands
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={disabled}>
              Keep it read-only
            </Button>
          </div>
          {limits && !limitsTyped ? (
            <p className="text-xs text-muted-foreground">A command may only set a value within limits: give both.</p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Read only: commands cannot change it.</span>
          <Button size="sm" variant="outline" onClick={() => setConfirming(true)} disabled={disabled}>
            Allow commands…
          </Button>
        </div>
      )}
    </div>
  )
}

export const DeviceEditor = ({
  edit,
  deviceId,
  protocol,
  initial,
  onDone
}: {
  readonly edit: EditStatus
  /** The device to edit; a new one when undefined. */
  readonly deviceId: string | undefined
  /** The protocol of a new device. */
  readonly protocol: EditableProtocol
  /** A new device's fields to start from (a discovered BACnet device), instead of an empty form. */
  readonly initial?: DeviceDraft | undefined
  /** Closed: `saved` says what was saved, so the page reads the running config again. */
  readonly onDone: (saved: string | undefined) => void
}) => {
  const [form, setForm] = useState<Form>({ _tag: "loading" })
  /** The latest check, and the candidate it was about: issues of an older candidate are not shown. */
  const [checked, setChecked] = useState<
    { readonly candidate: string; readonly issues: ReadonlyArray<ConfigIssue> } | undefined
  >(undefined)
  const [touched, setTouched] = useState<Touched>(new Set())
  const [saving, setSaving] = useState<Saving>({ _tag: "idle" })
  const [deviceTest, setDeviceTest] = useState<TestState | undefined>(undefined)
  const [pointTests, setPointTests] = useState<Readonly<Record<string, TestState>>>({})
  const [confirmRemove, setConfirmRemove] = useState(false)
  /** A new device's untouched fields stay quiet until a test or a save asks for them. */
  const [attempted, setAttempted] = useState(false)
  const [token, setToken] = useState(() => readToken() ?? "")
  const checkRun = useRef(0)

  const load = () => {
    setForm({ _tag: "loading" })
    setSaving({ _tag: "idle" })
    setChecked(undefined)
    void settle(fetchConfigFile).then((result) => {
      if (result._tag === "Failure") return setForm({ _tag: "unreadable", message: result.failure.message })
      const devices = devicesOf(result.success.text)
      if (devices === undefined)
        return setForm({
          _tag: "unreadable",
          message: `${edit.path} is not a JSON object right now; fix it in the file, or restore ${edit.path}.bak.`
        })
      const index = deviceId === undefined ? -1 : (deviceIndex(result.success.text, deviceId) ?? -1)
      if (deviceId !== undefined && index < 0)
        return setForm({ _tag: "unreadable", message: `The config file has no device ${deviceId} any more.` })
      const found = index < 0 ? undefined : devices[index]
      const draft = found === undefined ? (initial ?? newDevice(protocol)) : deviceDraft(found)
      if (draft === undefined)
        return setForm({
          _tag: "unreadable",
          message: `${deviceId} is a simulated device: edit it in the config file.`
        })
      setForm({
        _tag: "ready",
        text: result.success.text,
        etag: result.success.etag,
        index: index < 0 ? devices.length : index,
        isNew: index < 0,
        draft
      })
    })
  }
  // Read the file once, when the form opens.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [])

  const candidate = form._tag === "ready" ? withDevice(form.text, form.index, form.draft) : undefined
  useEffect(() => {
    if (candidate === undefined) return
    const run = ++checkRun.current
    const timer = setTimeout(() => {
      void Effect.runPromise(Effect.result(checkConfig(candidate))).then((result) => {
        if (run === checkRun.current && result._tag === "Success")
          setChecked({ candidate, issues: result.success.issues })
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

  const { draft } = form
  const pending = candidate !== undefined && checked?.candidate !== candidate
  const issues = checked !== undefined && checked.candidate === candidate ? checked.issues : []
  const byField = visibleIssues(deviceIssues(issues, form.index, draft), draft, touched, attempted)
  const changed = isDeviceChanged(draft)
  const busy = saving._tag === "saving"
  const testing = deviceTest?._tag === "running" || Object.values(pointTests).some((test) => test._tag === "running")
  const setDraft = (next: DeviceDraft) => setForm({ ...form, draft: next })
  const set = (field: keyof DeviceDraft) => (value: string) => {
    setTouched(touching(touched, "device", field, false))
    setDraft({ ...draft, [field]: value })
  }
  const setPoint = (position: number, point: PointDraft, field: string) => {
    setTouched(touching(touched, point.key, field, point.autoId))
    setDraft({ ...draft, points: draft.points.map((existing, index) => (index === position ? point : existing)) })
  }

  /** Read the device (every point) or one point with the form as it is, and show what came back where it belongs. */
  const runTest = (position?: number) => {
    if (candidate === undefined) return
    setAttempted(true)
    const point = position === undefined ? undefined : draft.points[position]
    const running: TestState = { _tag: "running" }
    if (point === undefined) setDeviceTest(running)
    else setPointTests((tests) => ({ ...tests, [point.key]: running }))
    void Effect.runPromise(testRead(candidate, form.index, position === undefined ? undefined : [position])).then(
      (outcome) => {
        if (outcome._tag === "invalid") setChecked({ candidate, issues: outcome.issues })
        const done: TestState = { _tag: "done", outcome }
        if (point === undefined) setDeviceTest(done)
        else setPointTests((tests) => ({ ...tests, [point.key]: done }))
        if (outcome._tag !== "ok") return
        // Every point read in this test shows its own value, a device test's too.
        const byId = new Map(outcome.value.points.map((result) => [result.id, result]))
        setPointTests((tests) => {
          const next = { ...tests }
          for (const each of draft.points) {
            const result = byId.get(each.id.trim())
            if (result !== undefined)
              next[each.key] = {
                _tag: "done",
                outcome: { _tag: "ok", value: { ...outcome.value, points: [result] } }
              }
          }
          return next
        })
      }
    )
  }

  const save = (text: string | undefined, removing: boolean) => {
    if (text === undefined) return
    if (edit.auth === "token") storeToken(token)
    setSaving({ _tag: "saving", removing })
    void Effect.runPromise(saveConfig(text, form.etag)).then((outcome) => {
      if (outcome._tag === "saved")
        return onDone(
          removing
            ? `Removed ${draft.id} at ${hourMinute(Date.now())}.`
            : savedMessage(outcome.saved.applied, hourMinute(Date.now()))
        )
      if (outcome._tag === "invalid") setChecked({ candidate: text, issues: outcome.issues })
      setSaving({ _tag: "done", outcome })
    })
  }

  const outcome = saving._tag === "done" ? saving.outcome : undefined
  const pointTestOf = (point: PointDraft) => pointTests[point.key]
  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        // Fields held back show what keeps the save; nothing is sent with issues.
        if (issues.length > 0) return setAttempted(true)
        save(candidate, false)
      }}
    >
      <datalist id="unit-choices">
        {unitChoices.map((choice) => (
          <option key={choice.value} value={choice.symbol} />
        ))}
      </datalist>
      <section className="grid gap-3" aria-labelledby="device-heading">
        <h3 id="device-heading" className="font-medium">
          {form.isNew ? `New ${protocolName[draft.protocol] ?? draft.protocol} device` : draft.id || "Device"}
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            id={deviceField("id")}
            label="Id"
            value={draft.id}
            placeholder={draft.protocol === "modbus-tcp" ? "meter-1" : "ahu-1"}
            hint="Lower-case letters, digits and dashes; part of every topic."
            issues={byField.device["id"]}
            onChange={set("id")}
            disabled={busy}
          />
          {draft.protocol === "modbus-tcp" ? (
            <>
              <TextField
                id={deviceField("host")}
                label="Host"
                value={draft.host}
                placeholder="192.168.1.30"
                issues={byField.device["host"]}
                onChange={set("host")}
                disabled={busy}
              />
              <TextField
                id={deviceField("port")}
                label="Port"
                value={draft.port}
                optional
                numeric
                placeholder="502"
                issues={byField.device["port"]}
                onChange={set("port")}
                disabled={busy}
              />
              <TextField
                id={deviceField("unitId")}
                label="Unit id"
                value={draft.unitId}
                optional
                numeric
                placeholder="1"
                hint="The slave id behind a Modbus gateway; often 1 or 255."
                issues={byField.device["unitId"]}
                onChange={set("unitId")}
                disabled={busy}
              />
            </>
          ) : (
            <>
              <TextField
                id={deviceField("deviceInstance")}
                label="Device instance"
                value={draft.deviceInstance}
                numeric
                placeholder="2001"
                issues={byField.device["deviceInstance"]}
                onChange={set("deviceInstance")}
                disabled={busy}
              />
              <TextField
                id={deviceField("address")}
                label="Address"
                value={draft.address}
                optional
                placeholder="192.168.1.40"
                hint="Left empty, the gateway finds it by broadcast in its own subnet."
                issues={byField.device["address"]}
                onChange={set("address")}
                disabled={busy}
              />
            </>
          )}
          <TextField
            id={deviceField("interval")}
            label="Read every (seconds)"
            value={draft.intervalSeconds}
            optional
            numeric
            placeholder="5"
            issues={byField.device["intervalSeconds"]}
            onChange={set("intervalSeconds")}
            disabled={busy}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => runTest()} disabled={busy || testing}>
            {deviceTest?._tag === "running" ? "Testing…" : "Test the device"}
          </Button>
          <span className="text-xs text-muted-foreground">Reads every point once; nothing is saved.</span>
        </div>
        {deviceTest === undefined ? null : <DeviceResult protocol={draft.protocol} test={deviceTest} />}
      </section>
      <section className="grid gap-3" aria-labelledby="points-heading">
        <h3 id="points-heading" className="font-medium">
          Points
        </h3>
        <Messages id="device-points-help" messages={byField.device["points"]} />
        <ol className="grid gap-3">
          {draft.points.map((point, position) => {
            const test = pointTestOf(point)
            const pointIssues = byField.points[point.key] ?? {}
            return (
              <li key={point.key} className="grid gap-3 rounded-md border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium">
                    {point.name || `Point ${position + 1}`}
                    <span className="font-normal text-muted-foreground"> · {pointSource(draft.protocol, point)}</span>
                  </p>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => runTest(position)}
                      disabled={busy || testing}
                      aria-label={`Test ${point.name || `point ${position + 1}`}`}
                    >
                      {test?._tag === "running" ? "Testing…" : "Test"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setDraft({ ...draft, points: draft.points.filter((_, index) => index !== position) })
                      }
                      disabled={busy || draft.points.length === 1}
                      aria-label={`Remove ${point.name || `point ${position + 1}`}`}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                {test === undefined ? null : test._tag === "running" ? (
                  <p className="text-sm text-muted-foreground">Reading…</p>
                ) : test.outcome._tag !== "ok" ? (
                  <TestProblem outcome={test.outcome} />
                ) : test.outcome.value.error !== undefined ? (
                  <DeviceResult protocol={draft.protocol} test={test} />
                ) : (
                  test.outcome.value.points.map((result) => (
                    <PointResult key={result.id} protocol={draft.protocol} result={result} />
                  ))
                )}
                <PointFields
                  protocol={draft.protocol}
                  deviceId={draft.id}
                  point={point}
                  position={position}
                  issues={pointIssues}
                  onChange={(next, field) => setPoint(position, next, field)}
                  disabled={busy}
                />
              </li>
            )
          })}
        </ol>
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDraft({ ...draft, points: [...draft.points, newPoint(draft.protocol)] })}
            disabled={busy}
          >
            Add a point
          </Button>
        </div>
      </section>
      {byField.other.length > 0 || byField.elsewhere.length > 0 ? (
        <div className="text-xs text-destructive">
          <p>Not in this form, so fix it in the config file:</p>
          <ul className="list-disc pl-5">
            {[...byField.other, ...byField.elsewhere].map((message) => (
              <li key={message} className="break-words">
                {message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {edit.auth === "token" ? (
        <div className="grid gap-1.5">
          <label className={labelClass} htmlFor="device-token">
            Edit token
          </label>
          <Input
            id="device-token"
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
        <div className="grid gap-2 text-sm" role="alert">
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
        <p className="text-sm text-destructive" role="alert">
          Not saved: the config has problems, shown above.
        </p>
      ) : outcome._tag === "saved" ? null : (
        <p className="text-sm break-words text-destructive" role="alert">
          {outcome._tag === "refused" ? "Refused: " : "Not applied: "}
          {outcome.message}
        </p>
      )}
      {confirmRemove ? (
        <div className="grid gap-2 rounded-md border border-destructive/40 p-3 text-sm" role="alert">
          <p>
            Remove {draft.id} and its {draft.points.length} point{draft.points.length === 1 ? "" : "s"}? The gateway
            stops reading it; the previous file is kept as a backup.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => save(withoutDevice(form.text, form.index), true)} disabled={busy}>
              {busy ? "Removing…" : "Remove the device"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)} disabled={busy}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {byField.quiet ? (
          <p className="basis-full text-xs text-muted-foreground">
            Some fields still need a value or a fix: Save shows which.
          </p>
        ) : null}
        <Button type="submit" size="sm" disabled={busy || !changed || pending || (issues.length > 0 && !byField.quiet)}>
          {busy && !(saving._tag === "saving" && saving.removing) ? "Saving and applying…" : "Save and apply"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onDone(undefined)} disabled={busy}>
          Cancel
        </Button>
        {form.isNew || confirmRemove ? null : (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive"
            onClick={() => setConfirmRemove(true)}
            disabled={busy}
          >
            Remove device
          </Button>
        )}
      </div>
    </form>
  )
}
