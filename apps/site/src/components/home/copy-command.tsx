"use client"
/** A shell command (or, with `multiline`, a prompt) with a button that copies it, and says so for two seconds. */
import { Check, Copy } from "lucide-react"
import { useEffect, useState } from "react"

export const CopyCommand = ({
  command,
  multiline = false
}: {
  readonly command: string
  /** Wrap the text and leave out the shell prompt: for a prompt to paste into an AI assistant. */
  readonly multiline?: boolean
}) => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = () => {
    navigator.clipboard.writeText(command).then(
      () => setCopied(true),
      () => setCopied(false)
    )
  }

  return (
    <div
      className={`bg-fd-card flex min-w-0 gap-2 rounded-md border py-1.5 pr-1.5 pl-3 ${multiline ? "items-start" : "items-center"}`}
    >
      <code
        className={`min-w-0 flex-1 font-mono text-xs ${multiline ? "py-1 leading-relaxed whitespace-pre-wrap" : "overflow-x-auto whitespace-nowrap"}`}
      >
        {multiline ? null : <span className="text-fd-muted-foreground select-none">$ </span>}
        {command}
      </code>
      <button
        className="text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium"
        onClick={copy}
        type="button"
      >
        {copied ? (
          <>
            <Check aria-hidden="true" className="size-3.5 text-[var(--status-good)]" /> Copied
          </>
        ) : (
          <>
            <Copy aria-hidden="true" className="size-3.5" /> Copy
          </>
        )}
      </button>
    </div>
  )
}
