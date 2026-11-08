"use client"
/**
 * Setting up with an AI assistant, as a short session: the request in plain words, then what `/setup`
 * (`.claude/skills/setup/SKILL.md`) does with it, one line per step. Every step is one the skill really takes;
 * the lines appear one after another once the window scrolls into view.
 */
import { Check, Paperclip } from "lucide-react"
import { useEffect, useRef, useState } from "react"

const request =
  "Read the air handlers every 30 s and the energy meter every 5 s, and send 15-minute averages to broker.example.com."

const steps = [
  ["Found 2 BACnet devices on the network", "ventilation-1 at 10.0.4.21, ventilation-2 at 10.0.4.22"],
  [
    "Read the meter's registers from the datasheet",
    "active power, energy, voltage and current, with scaling and units"
  ],
  ["Wrote ot-gateway.json and checked it", "valid, every datapoint read-only"],
  ["Started the gateway", "3/3 devices answering, values arriving on site-1/building-a/#"]
] as const

/** Delay before each line, so the session plays out instead of appearing at once. */
const STEP_MS = 600

export const AiSetup = () => {
  const frame = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const element = frame.current
    if (element === null) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting !== true) return
        setPlaying(true)
        observer.disconnect()
      },
      { threshold: 0.4 }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /** The nth line of the session: held at its first frame until the window is in view. */
  const line = (index: number, className = "") => ({
    className: `reveal ${className}`,
    style: { animationDelay: `${index * STEP_MS}ms`, animationPlayState: playing ? "running" : "paused" }
  })

  return (
    <div
      className="viz bg-fd-card overflow-hidden rounded-xl border font-mono text-xs shadow-2xl shadow-black/20"
      ref={frame}
    >
      <div className="flex items-center gap-3 border-b px-3 py-2">
        <span aria-hidden="true" className="flex gap-1.5">
          <span className="bg-fd-border size-2.5 rounded-full" />
          <span className="bg-fd-border size-2.5 rounded-full" />
          <span className="bg-fd-border size-2.5 rounded-full" />
        </span>
        <span className="text-fd-muted-foreground">~/ot-gateway · your AI assistant</span>
      </div>

      <div className="space-y-4 p-4 leading-relaxed md:p-5">
        <div {...line(0)}>
          <p>
            <span className="text-[var(--series-1)]">&gt; /setup</span> {request}
          </p>
          <p className="text-fd-muted-foreground mt-1.5 flex items-center gap-1.5">
            <Paperclip aria-hidden="true" className="size-3.5" /> meter-datasheet.pdf
          </p>
        </div>

        <ol className="space-y-2.5">
          {steps.map(([title, detail], index) => (
            <li key={title} {...line(index + 1, "flex gap-2")}>
              <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-[var(--status-good)]" />
              <span>
                {title}
                <span className="text-fd-muted-foreground block">{detail}</span>
              </span>
            </li>
          ))}
        </ol>

        <p {...line(steps.length + 1)}>Done. The status page is on 127.0.0.1:8080.</p>
      </div>
    </div>
  )
}
