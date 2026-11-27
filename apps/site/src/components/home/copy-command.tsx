"use client"
/** Copying for the home page: a prompt cut to one row, with a copy button. The docs pages' prompts copy with `useCopy` too. */
import { Check, ChevronDown, Copy } from "lucide-react"
import { useEffect, useState } from "react"

/**
 * Copies `text` and reports `copied` for two seconds, only while `text` is still the one copied: switching to
 * another text shows it as not copied yet.
 */
export const useCopy = (text: string) => {
  const [copiedText, setCopiedText] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (copiedText === undefined) return
    const timer = setTimeout(() => setCopiedText(undefined), 2000)
    return () => clearTimeout(timer)
  }, [copiedText])

  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setCopiedText(text),
      () => setCopiedText(undefined)
    )
  }
  return { copied: copiedText === text, copy }
}

/**
 * A prompt to paste into an AI agent, in one row: its start, cut off, so a reader sees what it is, with buttons
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
