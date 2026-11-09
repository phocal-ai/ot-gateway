"use client"
/**
 * Rows drawn only where the window shows them: a building can have tens of thousands of points, and a row each is
 * a DOM of hundreds of thousands of nodes that every status poll redraws. The list scrolls with the page (no inner
 * scroll box), rows have one height, and what is above and below the drawn rows is an empty row of the right height.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

export interface RowRange {
  /** The first row drawn, and one past the last. */
  readonly start: number
  readonly end: number
}

/**
 * The rows to draw: those in view plus `overscan` on each side, so a scroll shows drawn rows before the next frame
 * catches up. `top` is where the window's top edge is, measured from the first row's top (negative while the list
 * starts below it).
 */
export const visibleRange = (view: {
  readonly top: number
  readonly height: number
  readonly rowHeight: number
  readonly count: number
  readonly overscan: number
}): RowRange => {
  const start = Math.min(view.count, Math.max(0, Math.floor(view.top / view.rowHeight) - view.overscan))
  const end = Math.min(view.count, Math.max(0, Math.ceil((view.top + view.height) / view.rowHeight) + view.overscan))
  return { start, end: Math.max(start, end) }
}

/** Rows drawn beyond the window on each side. */
const OVERSCAN = 8

/**
 * The window's rows of a list of `count`. Attach `body` to the element whose top is the first row's top (the
 * `tbody`), and mark each drawn row with `data-row`: its height is measured from the first one drawn. `reveal`
 * scrolls a row into view, drawn or not.
 */
export const useWindowRows = (count: number, estimatedRowHeight: number) => {
  const body = useRef<HTMLTableSectionElement>(null)
  const rowHeight = useRef(estimatedRowHeight)
  const [range, setRange] = useState<RowRange>(() => ({ start: 0, end: Math.min(count, 30) }))
  const [height, setHeight] = useState(estimatedRowHeight)

  const measure = useCallback(() => {
    const element = body.current
    if (element === null) return
    const drawn = element.querySelector<HTMLElement>("[data-row]")?.getBoundingClientRect().height
    if (drawn !== undefined && drawn > 0 && Math.abs(drawn - rowHeight.current) > 0.5) {
      rowHeight.current = drawn
      setHeight(drawn)
    }
    const next = visibleRange({
      top: -element.getBoundingClientRect().top,
      height: window.innerHeight,
      rowHeight: rowHeight.current,
      count,
      overscan: OVERSCAN
    })
    setRange((current) => (current.start === next.start && current.end === next.end ? current : next))
  }, [count])

  // A new list (another filter) is measured before it is painted.
  useLayoutEffect(measure, [measure])

  // Scrolls and resizes, at most once a frame.
  useEffect(() => {
    let frame = 0
    const schedule = () => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    window.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
    }
  }, [measure])

  /** Scrolls row `index` to the middle of the window if it is not in view, and draws it at once. */
  const reveal = useCallback(
    (index: number) => {
      const element = body.current
      if (element === null) return
      const top = element.getBoundingClientRect().top + index * rowHeight.current
      if (top < 0 || top + rowHeight.current > window.innerHeight) {
        window.scrollBy({ top: top - window.innerHeight / 2 + rowHeight.current / 2 })
      }
      measure()
    },
    [measure]
  )

  return { body, range, rowHeight: height, reveal }
}
