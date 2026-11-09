/**
 * Which rows of a long list are drawn: those in the window, and a few on each side.
 */
import { describe, expect, it } from "@effect/vitest"
import { visibleRange } from "../src/lib/virtual.ts"

const view = { height: 800, rowHeight: 50, count: 10_000, overscan: 5 }

describe("visibleRange", () => {
  it("draws the rows in the window and the overscan, wherever it is scrolled", () => {
    // The list starts 300 px below the window's top: rows 0 to 10 are in view.
    expect(visibleRange({ ...view, top: -300 })).toEqual({ start: 0, end: 15 })
    // Scrolled to row 1,000.
    expect(visibleRange({ ...view, top: 50_000 })).toEqual({ start: 995, end: 1021 })
  })

  it("stays inside the list at its end, past it, and for an empty list", () => {
    expect(visibleRange({ ...view, top: 499_500 })).toEqual({ start: 9985, end: 10_000 })
    expect(visibleRange({ ...view, top: 900_000 })).toEqual({ start: 10_000, end: 10_000 })
    expect(visibleRange({ ...view, top: -3_000 })).toEqual({ start: 0, end: 0 })
    expect(visibleRange({ ...view, count: 0, top: 0 })).toEqual({ start: 0, end: 0 })
  })
})
