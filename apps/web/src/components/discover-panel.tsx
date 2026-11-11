"use client"
/**
 * Finding BACnet devices from the page, for a site without an object list: the gateway asks who is there (Who-Is,
 * broadcast or to one address), lists the devices that answer with their names, reads the objects of the one
 * picked (names, units, values now), and the objects ticked become the points of a new device in the normal form,
 * where they are tested and saved. Inputs and values start ticked, outputs not; nothing is made writable.
 */
import type { DiscoveredDevices, DiscoveredObjects, FoundBacnetDevice } from "@ot-gateway/api"
import { MAX_DISCOVERED_OBJECTS } from "@ot-gateway/api"
import { Effect } from "effect"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { type DeviceDraft, discoveredDevice, objectKey, pickedByDefault } from "@/lib/device-editor"
import { formatNumber } from "@/lib/format"
import { discoverDevices, discoverObjects, type Outcome } from "@/lib/setup-api"
import { formatValue, unitLabel } from "@/lib/status"

type Step =
  | { readonly _tag: "ask" }
  | { readonly _tag: "searching" }
  | { readonly _tag: "found"; readonly outcome: Outcome<DiscoveredDevices> }
  | { readonly _tag: "reading"; readonly device: FoundBacnetDevice; readonly address: string }
  | {
      readonly _tag: "objects"
      readonly outcome: Outcome<DiscoveredObjects>
      readonly found: Outcome<DiscoveredDevices>
    }

const Problem = ({ outcome }: { readonly outcome: Exclude<Outcome<unknown>, { readonly _tag: "ok" }> }) => (
  <p className="text-sm break-words text-destructive" role="alert">
    {outcome._tag === "busy" ? `Try again in a moment: ${outcome.message}` : outcome.message}
  </p>
)

/** One device that answered: its name and where, and why it cannot be picked when two addresses claim it. */
const DeviceRow = ({
  device,
  onPick,
  disabled
}: {
  readonly device: FoundBacnetDevice
  readonly onPick: (address: string) => void
  readonly disabled: boolean
}) => (
  <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
    <div className="min-w-0">
      <p className="truncate text-sm font-medium">{device.name ?? `Device ${device.instance}`}</p>
      <p className="text-xs break-words text-muted-foreground">
        Device {device.instance}
        {device.address === undefined ? "" : ` at ${device.address}`}
        {device.configured === undefined ? "" : ` · in the config as ${device.configured}`}
      </p>
      {device.conflicts.length > 0 ? (
        <p className="text-xs break-words text-destructive">
          More addresses answered for this instance ({device.conflicts.join(", ")}): two devices may share it. Take its
          address from the commissioning sheet or the device and search at that address.
        </p>
      ) : device.address === undefined ? (
        <p className="text-xs text-muted-foreground">Behind a BACnet router: add it with Add BACnet device.</p>
      ) : null}
    </div>
    {device.address === undefined ? null : (
      <Button size="sm" variant="outline" onClick={() => onPick(device.address ?? "")} disabled={disabled}>
        Pick
      </Button>
    )}
  </li>
)

/** The objects of the device picked, to tick. */
const ObjectList = ({
  found,
  picked,
  onToggle
}: {
  readonly found: DiscoveredObjects
  readonly picked: ReadonlySet<string>
  readonly onToggle: (key: string) => void
}) => (
  <ul className="grid gap-1">
    {found.objects.map((object) => {
      const key = objectKey(object)
      const inputId = `object-${key.replace(/[^a-z0-9]/gi, "-")}`
      return (
        <li key={key} className="flex items-start gap-3 rounded-md border px-3 py-2">
          <input
            id={inputId}
            type="checkbox"
            className="mt-1 size-4 shrink-0"
            checked={picked.has(key)}
            onChange={() => onToggle(key)}
          />
          <label htmlFor={inputId} className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="min-w-0 text-sm font-medium break-words">{object.name}</span>
              <span className="text-sm tabular-nums">
                {formatValue(object.value)}
                {object.value === undefined || object.unit === undefined ? "" : ` ${unitLabel(object.unit)}`}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              {object.objectType} {object.instance}
              {object.configured ? " · read already" : ""}
            </span>
          </label>
        </li>
      )
    })}
  </ul>
)

export const DiscoverPanel = ({
  onPicked,
  onCancel
}: {
  /** The device to add, with the objects ticked as its points: opened in the device form. */
  readonly onPicked: (draft: DeviceDraft) => void
  readonly onCancel: () => void
}) => {
  const [address, setAddress] = useState("")
  const [step, setStep] = useState<Step>({ _tag: "ask" })
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())

  const search = () => {
    setStep({ _tag: "searching" })
    void Effect.runPromise(discoverDevices(address)).then((outcome) => setStep({ _tag: "found", outcome }))
  }
  const pick = (found: Outcome<DiscoveredDevices>, device: FoundBacnetDevice, at: string) => {
    setStep({ _tag: "reading", device, address: at })
    void Effect.runPromise(discoverObjects(device.instance, at)).then((outcome) => {
      if (outcome._tag === "ok")
        setPicked(new Set(outcome.value.objects.filter(pickedByDefault).map((object) => objectKey(object))))
      setStep({ _tag: "objects", outcome, found })
    })
  }
  const toggle = (key: string) =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const busy = step._tag === "searching" || step._tag === "reading"

  const askForm = (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        search()
      }}
    >
      <div className="grid gap-1.5">
        <label className="text-sm font-medium" htmlFor="discover-address">
          Address <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <Input
          id="discover-address"
          value={address}
          placeholder="192.168.1.40 or 192.168.1.40:47809"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setAddress(event.target.value)}
          disabled={busy}
          aria-describedby="discover-address-help"
        />
        <p id="discover-address-help" className="text-xs text-muted-foreground">
          Left empty, the gateway asks every device in its subnet. Give an address for a device on another subnet or
          port.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {step._tag === "searching" ? "Searching… (a few seconds)" : "Find devices"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  )

  if (step._tag === "objects") {
    const back = () => setStep({ _tag: "found", outcome: step.found })
    if (step.outcome._tag !== "ok")
      return (
        <div className="grid gap-3">
          <Problem outcome={step.outcome} />
          <div>
            <Button size="sm" variant="outline" onClick={back}>
              Back to the devices
            </Button>
          </div>
        </div>
      )
    const found = step.outcome.value
    return (
      <div className="grid gap-3">
        <div className="grid gap-1">
          <h3 className="font-medium break-words">{found.name || `Device ${found.instance}`}</h3>
          <p className="text-xs text-muted-foreground">
            Device {found.instance} at {found.address} · {formatNumber(found.objects.length)} objects
            {found.listed > MAX_DISCOVERED_OBJECTS
              ? ` (the first ${formatNumber(MAX_DISCOVERED_OBJECTS)} of ${formatNumber(found.listed)}: add the rest with a points list)`
              : ""}
            . Inputs and values are ticked; tick an output to read it too.
          </p>
        </div>
        {found.objects.length === 0 ? (
          <p className="text-sm text-muted-foreground">It lists no object a gateway reads.</p>
        ) : (
          <ObjectList found={found} picked={picked} onToggle={toggle} />
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onPicked(discoveredDevice(found, picked))} disabled={picked.size === 0}>
            Continue with {formatNumber(picked.size)} point{picked.size === 1 ? "" : "s"}
          </Button>
          <Button size="sm" variant="ghost" onClick={back}>
            Back to the devices
          </Button>
        </div>
      </div>
    )
  }

  const found = step._tag === "found" ? step.outcome : undefined
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h3 className="font-medium">Find BACnet devices</h3>
        <p className="text-sm text-muted-foreground">
          The gateway asks which BACnet devices are there and reads the objects of the one you pick. It only reads.
        </p>
      </div>
      {askForm}
      {step._tag === "reading" ? (
        <p className="text-sm text-muted-foreground" role="status">
          Reading the objects of {step.device.name ?? `device ${step.device.instance}`}…
        </p>
      ) : null}
      {found === undefined ? null : found._tag !== "ok" ? (
        <Problem outcome={found} />
      ) : (
        <div className="grid gap-2" role="status">
          <p className="text-sm">
            {found.value.devices.length === 0
              ? "No device answered."
              : `${formatNumber(found.value.devices.length)} device${found.value.devices.length === 1 ? "" : "s"} answered${found.value.more ? ", and more than listed" : ""}:`}
          </p>
          {found.value.note === undefined ? null : <p className="text-xs text-muted-foreground">{found.value.note}</p>}
          <ul className="grid gap-1.5">
            {found.value.devices.map((device) => (
              <DeviceRow
                key={device.instance}
                device={device}
                onPick={(at) => pick(found, device, at)}
                disabled={busy}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
