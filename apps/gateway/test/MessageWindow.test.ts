/** Messages per topic per minute: what a window counts, what it forgets after an hour, and its bounds. */
import { describe, expect, it } from "@effect/vitest"
import { makeMessageMinutes } from "../src/MessageWindow.ts"

const minute = (count: number) => count * 60_000

describe("message minutes", () => {
  it("counts published and delivered per topic over the last minutes, the current one included", () => {
    const minutes = makeMessageMinutes(60)
    minutes.published("a", minute(0))
    minutes.delivered("a", minute(0) + 1)
    minutes.published("a", minute(3))
    minutes.published("b", minute(3) + 59_000)
    // A delivery for a topic it has no ring for adds nothing.
    minutes.delivered("c", minute(3))
    expect(minutes.window(1, minute(3) + 59_999)).toEqual({
      fromMs: minute(3),
      counts: new Map([
        ["a", { published: 1, delivered: 0 }],
        ["b", { published: 1, delivered: 0 }]
      ])
    })
    expect(minutes.window(4, minute(3)).counts.get("a")).toEqual({ published: 2, delivered: 1 })
  })

  it("forgets what is older than its length, and leaves a topic out of a window it sent nothing in", () => {
    const minutes = makeMessageMinutes(60)
    minutes.published("a", minute(0))
    minutes.published("b", minute(30))
    const later = minutes.window(60, minute(65))
    expect(later.fromMs).toBe(minute(6))
    expect([...later.counts.keys()]).toEqual(["b"])
    // Asked for more than it keeps: its length.
    expect(minutes.window(1_000, minute(65)).fromMs).toBe(minute(6))
    expect(minutes.window(10, minute(100)).counts.size).toBe(0)
  })

  it("clears every passed minute's slot, also after a long quiet stretch, and forgets a removed topic", () => {
    const minutes = makeMessageMinutes(5)
    for (let index = 0; index < 5; index++) minutes.published("a", minute(index))
    minutes.published("a", minute(12))
    expect(minutes.window(5, minute(12)).counts.get("a")).toEqual({ published: 1, delivered: 0 })
    minutes.remove("a")
    expect(minutes.window(5, minute(12)).counts.size).toBe(0)
  })

  it("stops a count at what a minute's slot holds", () => {
    const minutes = makeMessageMinutes(2)
    for (let index = 0; index < 70_000; index++) minutes.published("a", minute(1))
    expect(minutes.window(1, minute(1)).counts.get("a")).toEqual({ published: 65_535, delivered: 0 })
  })
})
