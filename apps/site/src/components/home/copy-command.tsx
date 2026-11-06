"use client"
/** A shell command with a button that copies it, and says so for two seconds. */
import { Check, Copy } from "lucide-react"
import { useEffect, useState } from "react"

export const CopyCommand = ({ command }: { readonly command: string }) => {
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
    <div className="bg-fd-card flex min-w-0 items-center gap-2 rounded-md border py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
        <span className="text-fd-muted-foreground select-none">$ </span>
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
