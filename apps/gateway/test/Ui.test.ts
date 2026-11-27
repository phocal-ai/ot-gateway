import { describe, expect, it } from "@effect/vitest"
import { pickedSummary, pickerLines, visibleRange } from "../src/Picker.ts"
import { textInputAnswer, textInputLines } from "../src/TextInput.ts"
import { colorsWanted, makeUi, plain, plainUi, wrap } from "../src/Ui.ts"

describe("one column", () => {
  it("puts a symbol in the first two columns and the text in the third, wrapped under it", () => {
    const ui = makeUi(false, 30)
    expect(ui.done("Wrote ot-gateway.json")).toBe("✔ Wrote ot-gateway.json")
    expect(ui.todo("Put the password in")).toBe("! Put the password in")
    expect(ui.failed("no broker")).toBe("✖ no broker")
    expect(ui.note("  a hint")).toBe("  a hint")
    expect(ui.note("one two three four five six seven eight").split("\n")).toEqual([
      "  one two three four five six",
      "  seven eight"
    ])
    expect(
      ui.rows([
        ["Next", "a"],
        ["All commands", "b"]
      ])
    ).toBe("  Next          a\n  All commands  b")
  })

  it("puts a row's hint after its value, or under it when the two do not fit", () => {
    const rows = [["Start it", "ot-gateway run", "or in Docker: ot-gateway up"]] as const
    expect(makeUi(false, 80).rows(rows)).toBe("  Start it  ot-gateway run  or in Docker: ot-gateway up")
    expect(makeUi(false, 40).rows(rows).split("\n")).toEqual([
      "  Start it  ot-gateway run",
      "            or in Docker: ot-gateway up"
    ])
  })

  it("colors only on a terminal without NO_COLOR, and measures text without its colors", () => {
    expect(colorsWanted(true, {})).toBe(true)
    expect(colorsWanted(true, { NO_COLOR: "1" })).toBe(false)
    expect(colorsWanted(false, {})).toBe(false)
    const colored = makeUi(true)
    expect(colored.done("x")).not.toBe("✔ x")
    expect(plain(colored.done("x"))).toBe("✔ x")
    expect(wrap(colored.dim("a b"), 3)).toEqual([colored.dim("a b")])
  })
})

describe("the point picker", () => {
  const rows = [
    { value: "a", title: "Room temperature", details: ["°C", "analog-input 1"], selected: true },
    { value: "b", title: "Heating", details: ["", "binary-input 1"], selected: false }
  ]

  it("aligns names and details, ticks what is selected and says the keys in a footer", () => {
    const lines = pickerLines(
      plainUi,
      "Which points?",
      rows,
      { index: 1, top: 0, selected: new Set([0]), error: undefined },
      {
        page: 10,
        columns: 80
      }
    )
    expect(lines).toEqual([
      "? Which points?",
      "  ◼ Room temperature  °C  analog-input 1",
      "❯ ◻ Heating               binary-input 1",
      "  ↑↓ move · space toggle · a all or none · enter confirm"
    ])
  })

  it("keeps the focused row in view and says how many are picked", () => {
    expect(visibleRange(0, 0, 40, 15)).toEqual({ start: 0, end: 15 })
    expect(visibleRange(20, 0, 40, 15)).toEqual({ start: 6, end: 21 })
    expect(visibleRange(3, 6, 40, 15)).toEqual({ start: 3, end: 18 })
    expect(visibleRange(1, 0, 2, 15)).toEqual({ start: 0, end: 2 })
    expect(pickedSummary(3, 3, "points")).toBe("all 3 points")
    expect(pickedSummary(2, 3, "points")).toBe("2 of 3 points")
  })
})

describe("a question with a placeholder", () => {
  const state = { value: "", cursor: 0, error: undefined }

  it("shows the default dim in an empty input, the cursor at its start, and Enter takes it", () => {
    const { lines, column } = textInputLines(plainUi, "Where should the gateway's files go?", ".", state)
    expect(lines).toEqual(["? Where should the gateway's files go? › ."])
    expect(column).toBe("? Where should the gateway's files go? › ".length)
    const colored = makeUi(true)
    expect(textInputLines(colored, "Site?", "my-site", state).lines[0]).toContain(colored.dim("my-site"))
    expect(textInputAnswer("", ".")).toBe(".")
  })

  it("shows what was typed instead, the cursor in it, and the error under it", () => {
    const typed = { value: "plant", cursor: 3, error: "lowercase letters" }
    const { lines, column } = textInputLines(plainUi, "Site?", "my-site", typed)
    expect(lines).toEqual(["? Site? › plant", "  › lowercase letters"])
    expect(column).toBe("? Site? › ".length + 3)
    expect(textInputAnswer("plant", "my-site")).toBe("plant")
  })
})
