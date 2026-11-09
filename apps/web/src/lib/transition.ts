/**
 * View transitions where the browser has them and the user allows motion; a plain state change everywhere else.
 */
import { flushSync } from "react-dom"

/** Whether the browser animates a change as a view transition: it has them and the user allows motion. */
export const canMorph = () =>
  typeof document.startViewTransition === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * Runs `update` inside a view transition, committed synchronously so the new snapshot shows it. `before` runs
 * while the old state is still on screen (to name the element that morphs), `updated` right after the DOM changed
 * and before the new snapshot (to move focus without a visible jump), `after` once the transition is done.
 */
export const withTransition = (
  update: () => void,
  hooks: { readonly before?: () => void; readonly updated?: () => void; readonly after?: () => void } = {}
) => {
  if (!canMorph()) {
    flushSync(update)
    hooks.updated?.()
    hooks.after?.()
    return
  }
  hooks.before?.()
  const transition = document.startViewTransition(() => {
    flushSync(update)
    hooks.updated?.()
  })
  void transition.finished.finally(() => hooks.after?.())
}
