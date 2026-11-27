"use client"
/**
 * "Explore with an AI agent": a prompt per tab that sends any agent to the page's Markdown, with a copy button,
 * so a reader can get the page explained and keep asking in their own agent's chat. The prompts are in
 * `src/content/explore.ts`.
 */
import { Check, Copy } from "lucide-react"
import type * as React from "react"
import { useId, useState } from "react"
import { useCopy } from "@/components/home/copy-command.tsx"
import type { ExplorePrompt as Prompt } from "@/content/explore.ts"

export const ExplorePrompt = ({ prompts }: { readonly prompts: ReadonlyArray<Prompt> }) => {
  const titleId = useId()
  const [selected, setSelected] = useState(0)
  const id = useId()
  const current = prompts[selected] ?? prompts[0]
  const { copied, copy } = useCopy(current?.prompt ?? "")
  if (current === undefined) return null

  /** The arrow keys, Home and End move between the tabs, as in the WAI-ARIA tabs pattern. */
  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = prompts.length - 1
    const next =
      event.key === "ArrowRight"
        ? selected === last
          ? 0
          : selected + 1
        : event.key === "ArrowLeft"
          ? selected === 0
            ? last
            : selected - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : undefined
    if (next === undefined) return
    event.preventDefault()
    setSelected(next)
    document.getElementById(`${id}-tab-${next}`)?.focus()
  }

  return (
    <aside aria-labelledby={titleId} className="not-prose my-6">
      <p className="font-semibold" id={titleId}>
        Explore with an AI agent
      </p>
      <p className="text-fd-muted-foreground mt-1 mb-3 text-sm">
        Not reading all of it? Copy a prompt, paste it into your AI agent and keep asking there.
      </p>
      <div className="bg-fd-card overflow-hidden rounded-xl border">
        <div className="flex items-center border-b pr-2">
          <div aria-label="Prompts" className="flex min-w-0 flex-1 overflow-x-auto" role="tablist">
            {prompts.map((prompt, index) => (
              <button
                aria-controls={`${id}-panel`}
                aria-selected={index === selected}
                className={`border-r px-4 py-2.5 text-sm font-medium whitespace-nowrap ${
                  index === selected
                    ? "bg-fd-background text-fd-foreground"
                    : "text-fd-muted-foreground hover:text-fd-foreground"
                }`}
                id={`${id}-tab-${index}`}
                key={prompt.label}
                onClick={() => setSelected(index)}
                onKeyDown={onKeyDown}
                role="tab"
                tabIndex={index === selected ? 0 : -1}
                type="button"
              >
                {prompt.label}
              </button>
            ))}
          </div>
          <button
            aria-label={copied ? "Copied" : `Copy the ${current.label} prompt`}
            className="text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent inline-flex shrink-0 items-center rounded p-1.5"
            onClick={copy}
            title="Copy prompt"
            type="button"
          >
            {copied ? (
              <Check aria-hidden="true" className="size-4 text-[var(--status-good)]" />
            ) : (
              <Copy aria-hidden="true" className="size-4" />
            )}
          </button>
        </div>
        <p
          aria-labelledby={`${id}-tab-${selected}`}
          className="bg-fd-background p-4 font-mono text-[0.8125rem] leading-relaxed break-words whitespace-pre-wrap"
          id={`${id}-panel`}
          role="tabpanel"
        >
          {current.prompt}
        </p>
        <p className="text-fd-muted-foreground border-t px-4 py-2.5 text-xs">
          Paste into any AI agent that can read a web page.
        </p>
      </div>
    </aside>
  )
}
