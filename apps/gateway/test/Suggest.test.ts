import { describe, expect, it } from "@effect/vitest"
import { closestMatch } from "../src/Suggest.ts"

const commands = ["demo", "init", "run", "check", "discover", "import", "points", "watch", "status"]

describe("closestMatch", () => {
  it("names the command a typo meant", () => {
    expect(closestMatch("chek", commands)).toBe("check")
    expect(closestMatch("stauts", commands)).toBe("status")
    expect(closestMatch("Inti", commands)).toBe("init")
    expect(closestMatch("discovr", commands)).toBe("discover")
  })

  it("names nothing for a word far from every command", () => {
    expect(closestMatch("gateway", commands)).toBeUndefined()
    expect(closestMatch("xyz", commands)).toBeUndefined()
  })
})
