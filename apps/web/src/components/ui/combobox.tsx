"use client"
/**
 * A select with a search field, in the style of shadcn/ui's Popover + Command, without their dependencies: a
 * button opens a popover with a search input over a list. The list scrolls inside a bounded height (never more
 * than half the screen), so a site with hundreds of devices stays usable.
 *
 * Keyboard: ↑/↓ (Home/End) move through the matches, Enter picks one, Esc closes and returns to the button, Tab
 * closes. The input is an ARIA combobox and the list a listbox, with the active option as `aria-activedescendant`.
 */
import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { matchesWords } from "@/lib/points"
import { cn } from "@/lib/utils"

/** Line icons drawn like the rest of shadcn/ui's (24-unit box, 2-unit round strokes), inline: no icon package. */
const icon = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round"
} as const

/** Options drawn at once: a site with thousands of devices narrows the list by typing, not by scrolling. */
const MAX_SHOWN = 100

export interface ComboboxOption {
  readonly value: string
  readonly label: string
  /** A second, quieter line of text on the right: a count, a type. Searched too. */
  readonly detail?: string
  /** Something before the label: a status dot, an icon. */
  readonly leading?: ReactNode
  /** Words that find the option without being shown. */
  readonly keywords?: string
}

export const Combobox = ({
  options,
  value,
  onChange,
  label,
  searchPlaceholder,
  emptyText,
  className
}: {
  readonly options: ReadonlyArray<ComboboxOption>
  readonly value: string
  readonly onChange: (value: string) => void
  /** The accessible name of the button and the list. */
  readonly label: string
  readonly searchPlaceholder: string
  readonly emptyText: string
  readonly className?: string
}) => {
  const id = useId()
  const listId = `${id}-list`
  const optionId = (index: number) => `${id}-option-${index}`
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)

  const selected = options.find((option) => option.value === value)
  const matching = useMemo(
    () =>
      options.filter((option) =>
        matchesWords(`${option.label} ${option.detail ?? ""} ${option.keywords ?? ""}`, query)
      ),
    [options, query]
  )
  const shown = matching.slice(0, MAX_SHOWN)

  const openList = () => {
    setQuery("")
    // The picked option, when it is among the drawn ones.
    const index = selected === undefined ? -1 : options.indexOf(selected)
    setActive(index >= 0 && index < MAX_SHOWN ? index : 0)
    setOpen(true)
  }
  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }
  const pick = (option: ComboboxOption | undefined) => {
    if (option === undefined) return
    onChange(option.value)
    close(true)
  }

  // Focus the search field as the popover appears, in the same frame.
  useLayoutEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  // Keep the active option in view while the keyboard moves through a long list.
  useLayoutEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [open, active])

  // A press anywhere outside closes it.
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close(false)
    }
    document.addEventListener("pointerdown", outside)
    return () => document.removeEventListener("pointerdown", outside)
  }, [open])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const last = shown.length - 1
    const move = (index: number) => {
      event.preventDefault()
      setActive(Math.min(Math.max(index, 0), Math.max(last, 0)))
    }
    switch (event.key) {
      case "ArrowDown":
        return move(active + 1)
      case "ArrowUp":
        return move(active - 1)
      case "Home":
        return move(0)
      case "End":
        return move(last)
      case "PageDown":
        return move(active + 8)
      case "PageUp":
        return move(active - 8)
      case "Enter":
        event.preventDefault()
        return pick(shown[active])
      case "Escape":
        event.preventDefault()
        event.stopPropagation()
        return close(true)
      case "Tab":
        return close(false)
    }
  }

  return (
    <div className={cn("relative", className)} ref={root}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${label}: ${selected?.label ?? ""}`}
        className="flex h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-sm hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || open) return
          event.preventDefault()
          openList()
        }}
        ref={trigger}
        type="button"
      >
        {selected?.leading}
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label}</span>
        <svg aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" {...icon}>
          <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
        </svg>
      </button>
      {open ? (
        <div className="absolute top-[calc(100%+4px)] right-0 z-50 flex w-[min(20rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-lg motion-safe:animate-[popover-in_120ms_ease-out]">
          <div className="flex items-center gap-2 border-b px-3">
            <svg aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" {...icon}>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              aria-activedescendant={shown[active] === undefined ? undefined : optionId(active)}
              aria-autocomplete="list"
              aria-controls={listId}
              aria-expanded="true"
              aria-label={searchPlaceholder}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              ref={input}
              role="combobox"
              value={query}
            />
          </div>
          <ul
            aria-label={label}
            className="max-h-[min(18rem,50dvh)] overflow-y-auto overscroll-contain p-1"
            id={listId}
            ref={list}
            role="listbox"
          >
            {shown.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-muted-foreground">{emptyText}</li>
            ) : (
              shown.map((option, index) => (
                <li
                  aria-selected={option.value === value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm select-none",
                    index === active && "bg-muted"
                  )}
                  data-index={index}
                  id={optionId(index)}
                  key={option.value}
                  // Keep focus in the search field: a click must not blur it before it picks.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(option)}
                  onPointerMove={() => setActive(index)}
                  role="option"
                >
                  {option.leading}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.detail === undefined ? null : (
                    <span className="shrink-0 text-xs text-muted-foreground">{option.detail}</span>
                  )}
                  <svg
                    aria-hidden="true"
                    className={cn("size-4 shrink-0", option.value !== value && "invisible")}
                    {...icon}
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </li>
              ))
            )}
            {matching.length > shown.length ? (
              <li className="px-2 py-2 text-center text-xs text-muted-foreground" role="presentation">
                {(matching.length - shown.length).toLocaleString()} more: type to narrow
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
