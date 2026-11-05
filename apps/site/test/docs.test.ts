import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { generatePage, headingAnchor, meta, pages, repository, rewriteLink, sectionsOf } from "../src/content/docs.ts"
import type { PageSource } from "../src/content/docs.ts"

const root = join(import.meta.dirname, "..", "..", "..")
const context = { ref: "dev" }
const operations: PageSource = { source: "docs/operations.md", slug: "operations", description: "Ops." }
const readme: PageSource = {
  source: "README.md",
  slug: "",
  title: "Getting started",
  description: "Start.",
  sections: ["Quick start"]
}

describe("rewriteLink", () => {
  it("points a link to another docs page at its site URL, keeping the anchor", () => {
    expect(rewriteLink("troubleshooting.md", operations, context, new Set())).toBe("/docs/troubleshooting")
    expect(rewriteLink("operations.md#the-machine", operations, context, new Set())).toBe(
      "/docs/operations#the-machine"
    )
    expect(rewriteLink("docs/configuration.md", readme, context, new Set())).toBe("/docs/configuration")
    expect(rewriteLink("docs/VISION.md", readme, context, new Set())).toBe("/docs/vision")
  })

  it("points any other repository path at GitHub, at the given ref", () => {
    expect(rewriteLink("../packaging/compose.yaml", operations, context, new Set())).toBe(
      `${repository}/blob/dev/packaging/compose.yaml`
    )
    expect(rewriteLink("packages/core", readme, { ref: "abc123" }, new Set())).toBe(
      `${repository}/blob/abc123/packages/core`
    )
  })

  it("sends a README anchor that is not on the page to the README on GitHub", () => {
    expect(rewriteLink("#roadmap", readme, context, new Set(["quick-start"]))).toBe(
      `${repository}/blob/dev/README.md#roadmap`
    )
    expect(rewriteLink("#quick-start", readme, context, new Set(["quick-start"]))).toBe("#quick-start")
    expect(rewriteLink("#mqtt", operations, context, new Set())).toBe("#mqtt")
  })

  it("leaves absolute URLs alone", () => {
    expect(rewriteLink("https://effect.website", operations, context, new Set())).toBe("https://effect.website")
    expect(rewriteLink("mailto:a@example.com", operations, context, new Set())).toBe("mailto:a@example.com")
  })
})

describe("generatePage", () => {
  it("moves the H1 into frontmatter and rewrites links outside code", () => {
    const markdown = [
      "# Running a gateway",
      "",
      "See [configuration.md](configuration.md) and [`compose.yaml`](../packaging/compose.yaml).",
      "",
      "Inline `[x](configuration.md)` stays.",
      "",
      "```md",
      "[y](configuration.md)",
      "```"
    ].join("\n")
    const page = generatePage(operations, markdown, context)
    expect(page.file).toBe("operations.md")
    expect(page.text).toContain('title: "Running a gateway"')
    expect(page.text).toContain('description: "Ops."')
    expect(page.text).not.toContain("# Running a gateway")
    expect(page.text).toContain("[configuration.md](/docs/configuration)")
    expect(page.text).toContain(`[\`compose.yaml\`](${repository}/blob/dev/packaging/compose.yaml)`)
    expect(page.text).toContain("Inline `[x](configuration.md)` stays.")
    expect(page.text).toContain("[y](configuration.md)\n```")
  })

  it("builds a README page from the named sections only", () => {
    const markdown =
      "# OT Gateway\n\nIntro.\n\n## Quick start\n\nRun it. See [roadmap](#roadmap).\n\n```bash\n## not a heading\n```\n\n## Roadmap\n\nLater."
    const page = generatePage(readme, markdown, context)
    expect(page.file).toBe("index.md")
    expect(page.text).toContain("## Quick start")
    expect(page.text).toContain("## not a heading")
    expect(page.text).not.toContain("Intro.")
    expect(page.text).not.toContain("Later.")
    expect(page.text).toContain(`[roadmap](${repository}/blob/dev/README.md#roadmap)`)
  })

  it("turns a GitHub alert into a labelled quote", () => {
    const page = generatePage(operations, "# T\n\n> [!NOTE]\n> It is early.", context)
    expect(page.text).toContain("> **Note:** It is early.")
  })

  it("fails on a README section that no longer exists", () => {
    expect(() => generatePage({ ...readme, sections: ["Gone"] }, "# T\n\n## Here\n", context)).toThrow(/Gone/)
  })
})

describe("the repository's docs", () => {
  it("every page's source exists, and every README section it names is there", () => {
    for (const page of pages) {
      const file = join(root, page.source)
      expect([page.source, existsSync(file)]).toEqual([page.source, true])
      const markdown = readFileSync(file, "utf8")
      expect(() => generatePage(page, markdown, context)).not.toThrow()
    }
  })

  it("every docs/*.md link resolves to a docs page", () => {
    for (const page of pages) {
      const text = generatePage(page, readFileSync(join(root, page.source), "utf8"), context).text
      const relative = [...text.matchAll(/\]\(([^)\s]+)\)/g)]
        .map((match) => match[1] ?? "")
        .filter((target) => !/^(https?:|mailto:|#|\/docs)/.test(target))
      expect({ source: page.source, relative }).toEqual({ source: page.source, relative: [] })
    }
  })

  it("lists every page in meta.json, in order, each group behind its separator", () => {
    const listed: ReadonlyArray<string> = JSON.parse(meta().text).pages
    expect(listed.filter((entry) => !entry.startsWith("---"))).toEqual([
      "index",
      ...pages.slice(1).map((page) => page.slug)
    ])
    expect(listed.slice(0, 4)).toEqual(["---Start here---", "index", "how-it-works", "first-building"])
    expect(listed).toContain("---Reference---")
  })

  it("makes heading anchors the way GitHub does", () => {
    expect(headingAnchor("Set it up with AI")).toBe("set-it-up-with-ai")
    expect(headingAnchor("Moving from Plenum")).toBe("moving-from-plenum")
    expect(sectionsOf("## A\n\nx\n\n## B\n\ny").get("B")).toBe("## B\n\ny")
  })
})
