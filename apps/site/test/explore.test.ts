import { describe, expect, it } from "vitest"
import { explorePrompts, markdownTwin } from "../src/content/explore.ts"

describe("explorePrompts", () => {
  const url = markdownTwin("https://ot-gateway.vercel.app", "/docs/operations")

  it("points the agent at the page's Markdown twin, the URL vercel.json serves", () => {
    expect(url).toBe("https://ot-gateway.vercel.app/docs/operations.md")
    expect(markdownTwin("https://ot-gateway.vercel.app", "/docs")).toBe("https://ot-gateway.vercel.app/docs.md")
    for (const { prompt } of explorePrompts("Running a gateway", url)) {
      expect(prompt).toMatch(/^Read https:\/\/ot-gateway\.vercel\.app\/docs\/operations\.md[.,]/)
      expect(prompt).toContain("\u201cRunning a gateway\u201d")
      expect(prompt).toContain("say so when it doesn't cover something")
    }
  })

  it("has a TL;DR tab and a tab for the reader's own site", () => {
    expect(explorePrompts("Running a gateway", url).map((prompt) => prompt.label)).toEqual(["TL;DR", "Your site"])
  })
})
