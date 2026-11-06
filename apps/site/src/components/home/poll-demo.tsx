"use client"
/**
 * One poll, clicked through step by step: the gateway sends a BACnet ReadProperty to the device, the device answers with the
 * present value, and the gateway publishes it on MQTT. The bytes are real BACnet/IP (BVLC, NPDU and APDU as in
 * packages/bacnet, ASHRAE 135 clause 15.5 and Annex J); the message is the sample-mode payload from the README.
 */
import { ArrowRight, Fan, Play, RotateCcw } from "lucide-react"
import type * as React from "react"
import { useState } from "react"

/** 0: idle, 1: request sent, 2: device answered, 3: message published. */
type Stage = 0 | 1 | 2 | 3

const hex = (bytes: ReadonlyArray<number>) => bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ")

const float32Bytes = (value: number): ReadonlyArray<number> => {
  const view = new DataView(new ArrayBuffer(4))
  view.setFloat32(0, value)
  return [view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)]
}

/** Object identifier of analog-input 1: type 0 in the top 10 bits, instance 1 in the rest. */
const objectId = [0x00, 0x00, 0x00, 0x01]

/** BVLC Original-Unicast-NPDU, NPDU expecting a reply, confirmed ReadProperty of present-value (85). */
const requestBytes = (invokeId: number) => [
  0x81,
  0x0a,
  0x00,
  0x11,
  0x01,
  0x04,
  0x00,
  0x05,
  invokeId,
  0x0c,
  0x0c,
  ...objectId,
  0x19,
  0x55
]

/** The ComplexACK with the same invoke ID: object, property, then the value as an application-tagged REAL. */
const responseBytes = (invokeId: number, value: number) => [
  0x81,
  0x0a,
  0x00,
  0x17,
  0x01,
  0x00,
  0x30,
  invokeId,
  0x0c,
  0x0c,
  ...objectId,
  0x19,
  0x55,
  0x3e,
  0x44,
  ...float32Bytes(value),
  0x3f
]

const Panel = ({
  title,
  active,
  current = false,
  children
}: {
  readonly title: string
  readonly active: boolean
  /** The panel the current step happens in, outlined. */
  readonly current?: boolean
  readonly children: React.ReactNode
}) => (
  <div
    className={`bg-fd-card rounded-xl border p-4 text-xs transition-[opacity,border-color,box-shadow] duration-500 ${active ? "opacity-100" : "opacity-40"} ${current ? "border-[var(--series-1)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--series-1)_15%,transparent)]" : ""}`}
  >
    <p className="text-fd-muted-foreground mb-3 font-medium tracking-wide uppercase">{title}</p>
    {children}
  </div>
)

const Field = ({ label, children }: { readonly label: string; readonly children: React.ReactNode }) => (
  <div className="contents">
    <dt className="text-fd-muted-foreground">{label}</dt>
    <dd className="font-mono">{children}</dd>
  </div>
)

const Bytes = ({ children }: { readonly children: string }) => (
  <pre className="bg-fd-background text-fd-muted-foreground mt-2 rounded-md border p-2 font-mono break-all whitespace-pre-wrap">
    {children}
  </pre>
)

/** The link between two panels; on a step that crosses it, a packet travels it once in that direction. */
const Arrow = ({
  active,
  direction,
  run
}: {
  readonly active: boolean
  readonly direction: "left" | "right" | undefined
  /** Changes on every step, so the packet replays even when the direction stays the same. */
  readonly run: string
}) => (
  <div className="flex items-center justify-center py-1 md:py-0">
    <div className="relative flex items-center md:w-12">
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 top-1/2 h-px transition-colors duration-500 max-md:hidden ${active ? "bg-[var(--series-1)]/40" : "bg-fd-border"}`}
      />
      {direction === undefined ? null : (
        <span
          aria-hidden="true"
          className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--series-1)] max-md:hidden ${direction === "right" ? "packet-right" : "packet-left"}`}
          key={run}
        />
      )}
      <ArrowRight
        aria-hidden="true"
        className={`relative mx-auto size-5 transition-[color,transform] duration-500 md:hidden ${active ? "text-[var(--series-1)]" : "text-fd-border"} rotate-90`}
      />
    </div>
  </div>
)

/** The three steps of a poll; the button names the next one, so the user clicks through them. */
const steps = [
  {
    stage: 1,
    label: "Request",
    action: "Send the request",
    text: "The gateway asks the device for its present value."
  },
  { stage: 2, label: "Answer", action: "Let the device answer", text: "The device answers with the value, as a REAL." },
  {
    stage: 3,
    label: "Publish",
    action: "Publish to MQTT",
    text: "The gateway adds the name and unit from the config and publishes. Anything subscribed has it now."
  }
] as const

const nextOf: Record<Stage, Stage> = { 0: 1, 1: 2, 2: 3, 3: 0 }

const idleText = "Click through one poll of the supply air temperature, from the device to your broker."

export const PollDemo = () => {
  const [stage, setStage] = useState<Stage>(0)
  const [invokeId, setInvokeId] = useState(1)
  const [value, setValue] = useState(21.4)
  const [ts, setTs] = useState(1793873700000)

  const goTo = (next: Stage) => {
    if (next === 1 && stage !== 1) {
      setInvokeId((id) => (id % 255) + 1)
      setValue(Math.round((21 + Math.random() * 0.8) * 10) / 10)
    }
    if (next === 3) setTs(Date.now())
    setStage(next)
  }

  const nextStage = nextOf[stage]
  const nextStep = steps.find((step) => step.stage === nextStage)
  const currentStep = steps.find((step) => step.stage === stage)

  return (
    <div className="viz">
      <ol className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {steps.map((step, index) => {
          const number = step.stage
          const current = stage === number
          const done = stage > number
          return (
            <li className="flex items-center gap-2" key={step.label}>
              {index > 0 ? <span aria-hidden="true" className="bg-fd-border h-px w-6" /> : null}
              <button
                aria-current={current ? "step" : undefined}
                className={`flex items-center gap-2 rounded-full border px-3 py-1 transition-colors ${
                  current
                    ? "border-[var(--series-1)] font-medium"
                    : done
                      ? "text-fd-foreground"
                      : "text-fd-muted-foreground"
                }`}
                onClick={() => goTo(number)}
                type="button"
              >
                <span
                  className={`flex size-5 items-center justify-center rounded-full text-xs ${
                    current || done ? "bg-[var(--series-1)] text-white" : "border"
                  }`}
                >
                  {number}
                </span>
                {step.label}
              </button>
            </li>
          )
        })}
      </ol>

      <div className="mb-5 flex flex-wrap items-center gap-4">
        <button
          className="bg-fd-primary text-fd-primary-foreground inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium"
          onClick={() => goTo(nextStage)}
          type="button"
        >
          {stage === 3 ? (
            <RotateCcw aria-hidden="true" className="size-4" />
          ) : (
            <Play aria-hidden="true" className="size-4" />
          )}
          {nextStep === undefined ? "Start over" : nextStep.action}
        </button>
        <p aria-live="polite" className="text-fd-muted-foreground text-sm">
          {currentStep === undefined ? idleText : currentStep.text}
        </p>
      </div>

      <div className="grid gap-2 md:grid-cols-[1fr_auto_1.3fr_auto_1.2fr] md:gap-3">
        <Panel active current={stage === 1} title="Device">
          <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Fan aria-hidden="true" className="text-fd-muted-foreground size-4" /> ahu-1
            <span className="text-fd-muted-foreground font-normal">air handler</span>
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <Field label="address">10.0.4.21:47808</Field>
            <Field label="protocol">BACnet/IP</Field>
            <Field label="device">1001</Field>
            <Field label="object">analog-input 1</Field>
            <Field label="value">
              <span
                className={`-mx-1 rounded px-1 ${stage >= 2 ? "text-fd-foreground font-semibold" : ""} ${stage === 1 ? "value-flash" : ""}`}
                key={`${invokeId}-${stage}`}
              >
                {stage >= 1 ? `${value.toFixed(1)} °C` : "—"}
              </span>
            </Field>
          </dl>
        </Panel>

        <Arrow
          active={stage >= 1}
          direction={stage === 1 ? "left" : stage === 2 ? "right" : undefined}
          run={`${invokeId}-${stage}`}
        />

        <Panel active={stage >= 1} current={stage === 2} title="OT side · BACnet/IP">
          <p className="font-medium">
            ReadProperty <span className="text-fd-muted-foreground font-normal">gateway → 10.0.4.21</span>
          </p>
          <p className="text-fd-muted-foreground mt-1">analog-input 1, present-value</p>
          <Bytes>{hex(requestBytes(invokeId))}</Bytes>
          <div
            className={`mt-3 ${stage >= 2 ? (stage === 2 ? "reveal" : "") : "invisible"}`}
            key={`answer-${invokeId}-${stage >= 2}`}
          >
            <p className="font-medium">
              ComplexACK <span className="text-fd-muted-foreground font-normal">10.0.4.21 → gateway</span>
            </p>
            <p className="text-fd-muted-foreground mt-1">REAL {value.toFixed(1)}</p>
            <Bytes>{hex(responseBytes(invokeId, value))}</Bytes>
          </div>
        </Panel>

        <Arrow active={stage >= 3} direction={stage === 3 ? "right" : undefined} run={`${invokeId}-${stage}`} />

        <Panel active={stage >= 3} current={stage === 3} title="MQTT side">
          <p className="font-medium">
            PUBLISH <span className="text-fd-muted-foreground font-normal">gateway → broker</span>
          </p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <Field label="topic">
              <span>
                {["vienna-hq/", "main/", "ahu-1/", "supply-air-temp"].map((segment) => (
                  <span className="whitespace-nowrap" key={segment}>
                    {segment}
                    <wbr />
                  </span>
                ))}
              </span>
            </Field>
            <Field label="retain">no</Field>
          </dl>
          <pre
            className={`bg-fd-background mt-2 rounded-md border p-2 font-mono whitespace-pre-wrap ${stage === 3 ? "reveal" : ""}`}
            key={`message-${invokeId}-${stage === 3}`}
          >
            {`{\n  "value": ${stage >= 3 ? value.toFixed(1) : "…"},\n  "ts": ${ts},\n  "unit": "unit:DEG_C"\n}`}
          </pre>
          <p className="text-fd-muted-foreground mt-2">
            The name and unit come from the config; the value from the device.
          </p>
        </Panel>
      </div>
    </div>
  )
}
