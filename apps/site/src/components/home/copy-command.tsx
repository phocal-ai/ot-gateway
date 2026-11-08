"use client"
/** Copying for the home page: a shell command or prompt shown with a copy button, or a prompt cut to one row. */
import { Check, ChevronDown, Copy } from "lucide-react"
import { useEffect, useState } from "react"

/** Copies `text` and reports `copied` for two seconds. */
const useCopy = (text: string) => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false)
    )
  }
  return { copied, copy }
}

/**
 * A prompt to paste into an AI assistant, in one row: its start, cut off, so a reader sees what it is, with buttons
 * to show all of it and to copy it.
 */
export const CopyPrompt = ({ prompt }: { readonly prompt: string }) => {
  const { copied, copy } = useCopy(prompt)
  const [expanded, setExpanded] = useState(false)
  const iconButton =
    "text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium"
  return (
    <div
      className={`bg-fd-card flex min-w-0 flex-1 gap-2 rounded-md border py-1.5 pr-1.5 pl-3 sm:max-w-lg ${expanded ? "items-start" : "items-center"}`}
    >
      <p
        className={`min-w-0 flex-1 text-xs ${expanded ? "py-1 leading-relaxed whitespace-pre-wrap" : "truncate"}`}
        title={expanded ? undefined : prompt}
      >
        {prompt}
      </p>
      <button
        aria-expanded={expanded}
        aria-label={expanded ? "Show less of the prompt" : "Show the whole prompt"}
        className={iconButton}
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <ChevronDown aria-hidden="true" className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      <button className={iconButton} onClick={copy} type="button">
        {copied ? (
          <>
            <Check aria-hidden="true" className="size-3.5 text-[var(--status-good)]" /> Copied
          </>
        ) : (
          <>
            <Copy aria-hidden="true" className="size-3.5" /> Copy prompt
          </>
        )}
      </button>
    </div>
  )
}

export const CopyCommand = ({
  command,
  multiline = false
}: {
  readonly command: string
  /** Wrap the text and leave out the shell prompt: for a prompt to paste into an AI assistant. */
  readonly multiline?: boolean
}) => {
  const { copied, copy } = useCopy(command)

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
