"use client"
/**
 * A card's details in a dialog over the page. Opened by a view transition, it grows out of the card that opened
 * it and shrinks back into it (the caller names the card `detail` for the frame; see `morphFrom`), and without
 * view transitions it fades in by itself. Esc, the ✕ and a click beside it close it.
 */
import { type ReactNode, useLayoutEffect, useRef } from "react"
import { canMorph, withTransition } from "@/lib/transition"

/** The view-transition name the card and the dialog share, one at a time. */
const NAME = "detail"

export const DetailDialog = ({
  title,
  morph,
  onClose,
  children
}: {
  readonly title: string
  /** Opened by a view transition, which animates it; otherwise it animates by itself. */
  readonly morph: boolean
  readonly onClose: () => void
  readonly children: ReactNode
}) => {
  const dialog = useRef<HTMLDialogElement>(null)
  // A layout effect, so the dialog is open in the frame the view transition takes as its new state.
  useLayoutEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (!element.open) element.showModal()
    element.focus()
    return () => element.close()
  }, [])
  return (
    <dialog
      aria-label={title}
      className={`detail-dialog ${morph ? "morphing" : ""} m-auto max-h-[85dvh] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border bg-card p-0 text-card-foreground shadow-2xl outline-none`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      ref={dialog}
      style={{ viewTransitionName: NAME }}
      tabIndex={-1}
    >
      <div className="flex flex-col gap-5 p-6">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            aria-label="Close (Esc)"
            className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            title="Close (Esc)"
            type="button"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}

/**
 * Open and close a dialog from `card` with a view transition: the card carries the shared name in the old frame
 * when opening and in the new frame when closing, the dialog in the others. Focus goes back to the card's button.
 */
export const morphFrom = (card: HTMLElement | null) => ({
  morph: canMorph(),
  open: (update: () => void) =>
    withTransition(update, {
      before: () => card?.style.setProperty("view-transition-name", NAME),
      updated: () => card?.style.removeProperty("view-transition-name")
    }),
  close: (update: () => void) =>
    withTransition(update, {
      updated: () => {
        card?.style.setProperty("view-transition-name", NAME)
        ;(card?.querySelector<HTMLElement>("button") ?? card)?.focus({ preventScroll: true })
      },
      after: () => card?.style.removeProperty("view-transition-name")
    })
})

/** Label and value rows. */
export const Facts = ({ rows }: { readonly rows: ReadonlyArray<readonly [string, ReactNode] | false> }) => (
  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
    {rows.map((row) =>
      row === false ? null : (
        <div className="contents" key={row[0]}>
          <dt className="text-muted-foreground">{row[0]}</dt>
          <dd className="min-w-0 text-right tabular-nums break-words">{row[1]}</dd>
        </div>
      )
    )}
  </dl>
)
