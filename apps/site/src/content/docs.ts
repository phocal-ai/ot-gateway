/**
 * Turns the repository's Markdown (`docs/*.md` and the README) into the
 * site's docs pages, so the repo stays the one source: the site never holds a
 * copy that can drift from what `ConfigDocs.test.ts` checks.
 *
 * Pure functions only; `scripts/content.ts` reads and writes the files.
 */

/** A docs page and the repository file it is generated from. */
export interface PageSource {
  /** Repository path of the Markdown file, e.g. `docs/operations.md`. */
  readonly source: string
  /** URL segment under `/docs`; empty for the docs index. */
  readonly slug: string
  /** Overrides the title taken from the file's H1. */
  readonly title?: string
  readonly description: string
  /** For the README: only these H2 sections become the page, in this order. */
  readonly sections?: ReadonlyArray<string>
  /** Starts a sidebar group with this label: the docs go from a first look to reference. */
  readonly group?: string
}

export const repository = "https://github.com/phocal-ai/ot-gateway"

/** The docs pages, in sidebar order. */
export const pages: ReadonlyArray<PageSource> = [
  {
    source: "README.md",
    slug: "",
    title: "Getting started",
    description: "See it work in a minute, look around, then set it up for your own building.",
    sections: ["Quick start", "Set it up with AI", "Running it for real"],
    group: "Start here"
  },
  {
    source: "docs/how-it-works.md",
    slug: "how-it-works",
    description: "What the gateway does, with one example building: from a meter and two air handlers to your software."
  },
  {
    source: "docs/first-building.md",
    slug: "first-building",
    description: "From your list of points to values arriving on your broker, in five steps."
  },
  {
    source: "docs/operations.md",
    slug: "operations",
    description:
      "Install, change, upgrade, back up and watch a gateway on any Linux machine with Docker, or with systemd.",
    group: "Run it"
  },
  {
    source: "docs/raspberry-pi-install.md",
    slug: "raspberry-pi-install",
    title: "Install on a Raspberry Pi",
    description: "From a blank SD card to a gateway publishing to MQTT."
  },
  {
    source: "docs/troubleshooting.md",
    slug: "troubleshooting",
    description: "From a symptom on the status page or in the log to its cause and fix."
  },
  {
    source: "docs/configuration.md",
    slug: "configuration",
    description: "Every key of the gateway's JSON config, with its default.",
    group: "Reference"
  },
  {
    source: "docs/raspberry-pi-testing.md",
    slug: "raspberry-pi-testing",
    description:
      "How to test a gateway on a Pi before it goes into a building, and what has to be true to call it ready.",
    group: "Background"
  },
  {
    source: "docs/VISION.md",
    slug: "vision",
    title: "Vision",
    description: "Why OT Gateway exists, who it is for, its design principles and the path to v1.0."
  }
]

/** A generated page: its path under the content directory and its file text. */
export interface GeneratedPage {
  readonly file: string
  readonly text: string
}

/** Where links that leave the site point: a branch, tag or commit of the repository. */
export interface LinkContext {
  readonly ref: string
}

const posixJoin = (from: string, relative: string): string => {
  const parts = from.split("/").slice(0, -1)
  for (const part of relative.split("/")) {
    if (part === "..") parts.pop()
    else if (part !== "." && part !== "") parts.push(part)
  }
  return parts.join("/")
}

const pageUrl = (page: PageSource): string => (page.slug === "" ? "/docs" : `/docs/${page.slug}`)

/** GitHub's heading anchor for a heading text, as `github-slugger` makes it. */
export const headingAnchor = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-")

/**
 * Where a link in `from` should point on the site.
 *
 * - An anchor on the same page stays, unless the page is a part of the README
 *   and the heading is not in it; then it goes to the README on GitHub.
 * - A link to a file that is a docs page becomes that page's URL.
 * - Any other repository path goes to GitHub at `context.ref`.
 * - Absolute URLs and `mailto:` are left alone.
 */
export const rewriteLink = (
  target: string,
  from: PageSource,
  context: LinkContext,
  anchorsOnPage: ReadonlySet<string>
): string => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return target
  if (target.startsWith("#")) {
    if (from.sections === undefined || anchorsOnPage.has(target.slice(1))) return target
    return `${repository}/blob/${context.ref}/${from.source}${target}`
  }
  const hashAt = target.indexOf("#")
  const path = hashAt === -1 ? target : target.slice(0, hashAt)
  const hash = hashAt === -1 ? "" : target.slice(hashAt)
  const resolved = posixJoin(from.source, path)
  const page = pages.find((candidate) => candidate.source === resolved && candidate.sections === undefined)
  if (page !== undefined) return `${pageUrl(page)}${hash}`
  return `${repository}/blob/${context.ref}/${resolved}${hash}`
}

const fence = /^(```|~~~)/

/** Splits Markdown into lines, marking those inside fenced code blocks. */
const linesOf = (markdown: string): ReadonlyArray<{ readonly text: string; readonly code: boolean }> => {
  let open: string | undefined
  return markdown.split("\n").map((text) => {
    const marker = fence.exec(text.trimStart())?.[1]
    if (marker !== undefined) {
      if (open === undefined) open = marker
      else if (marker === open) open = undefined
      return { text, code: true }
    }
    return { text, code: open !== undefined }
  })
}

/** The H2 sections of a Markdown document, by heading text, each with its heading line. */
export const sectionsOf = (markdown: string): ReadonlyMap<string, string> => {
  const sections = new Map<string, Array<string>>()
  let current: Array<string> | undefined
  for (const line of linesOf(markdown)) {
    const heading = line.code ? undefined : /^## (.+)$/.exec(line.text)?.[1]
    if (heading !== undefined) {
      current = [line.text]
      sections.set(heading.trim(), current)
    } else if (line.text.startsWith("# ") && !line.code) current = undefined
    else current?.push(line.text)
  }
  return new Map([...sections].map(([heading, lines]) => [heading, lines.join("\n").trim()]))
}

const headingsOf = (markdown: string): ReadonlySet<string> =>
  new Set(
    linesOf(markdown)
      .filter((line) => !line.code)
      .map((line) => /^#{1,6} (.+)$/.exec(line.text)?.[1])
      .filter((heading) => heading !== undefined)
      .map(headingAnchor)
  )

/**
 * An inline link (its label may hold code spans) or a code span. Links are
 * tried first, so a code span that contains link syntax is consumed whole and
 * left alone.
 */
const linkOrCode = /(!?\[(?:[^\]`]|`[^`]*`)*\])\(([^)\s]+)\)|`[^`]*`/g

/** Rewrites every inline link outside code blocks and code spans. */
const rewriteLinks = (markdown: string, rewrite: (target: string) => string): string =>
  linesOf(markdown)
    .map((line) =>
      line.code
        ? line.text
        : line.text.replace(linkOrCode, (match, label: string | undefined, target: string | undefined) =>
            label === undefined || target === undefined ? match : `${label}(${rewrite(target)})`
          )
    )
    .join("\n")

/** GitHub's `> [!NOTE]` alert becomes a plain quote with a bold label, which renders everywhere. */
const plainAlerts = (markdown: string): string =>
  markdown.replace(/^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\n> /gm, (_, kind: string) => {
    const label = kind.charAt(0) + kind.slice(1).toLowerCase()
    return `> **${label}:** `
  })

const yamlString = (value: string): string => JSON.stringify(value)

/** The H1 of a Markdown document, or undefined when it has none. */
export const titleOf = (markdown: string): string | undefined => /^# (.+)$/m.exec(markdown)?.[1]?.trim()

/** Builds one page from its source file's text. */
export const generatePage = (page: PageSource, markdown: string, context: LinkContext): GeneratedPage => {
  const title = page.title ?? titleOf(markdown)
  if (title === undefined) throw new Error(`${page.source} has no H1 and no title in pages`)

  let body: string
  if (page.sections === undefined) {
    body = markdown.replace(/^# .+\n+/m, "")
  } else {
    const sections = sectionsOf(markdown)
    body = page.sections
      .map((heading) => {
        const section = sections.get(heading)
        if (section === undefined) throw new Error(`${page.source} has no section "## ${heading}"`)
        return section
      })
      .join("\n\n")
  }

  const anchors = headingsOf(body)
  body = plainAlerts(rewriteLinks(body, (target) => rewriteLink(target, page, context, anchors)))
  const sourceUrl = `${repository}/blob/${context.ref}/${page.source}`
  const frontmatter = [
    "---",
    `title: ${yamlString(title)}`,
    `description: ${yamlString(page.description)}`,
    `source: ${yamlString(sourceUrl)}`,
    "---"
  ].join("\n")
  return { file: page.slug === "" ? "index.md" : `${page.slug}.md`, text: `${frontmatter}\n\n${body.trim()}\n` }
}

/** The sidebar order, as Fumadocs reads it from `meta.json`, with a `---Label---` separator before each group. */
export const meta = (): GeneratedPage => ({
  file: "meta.json",
  text: `${JSON.stringify(
    {
      title: "Docs",
      pages: pages.flatMap((page) => [
        ...(page.group === undefined ? [] : [`---${page.group}---`]),
        page.slug === "" ? "index" : page.slug
      ])
    },
    null,
    2
  )}\n`
})
