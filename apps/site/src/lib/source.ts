import { createGetUrl, llms, loader } from "fumadocs-core/source"
import { docs } from "fumadocs-mdx:collections/server"

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource()
})

export type DocsPage = NonNullable<ReturnType<typeof source.getPage>>

/** Markdown renderings of the docs, for `llms.txt`, `llms-full.txt` and the `.md` URLs. */
export const docsLlms = llms(source, {
  renderPage: async (page) =>
    [`# ${page.data.title} (${page.url})`, page.data.description, (await page.data.getText("processed")).trim()]
      .filter(Boolean)
      .join("\n\n")
})

const getMarkdownUrl = createGetUrl("/llms.mdx/docs")

/** Where the Markdown of a docs page is written; vercel.json also serves it at the page's URL plus `.md`. */
export const pageMarkdownUrl = (page: Pick<DocsPage, "slugs">): string => getMarkdownUrl([...page.slugs, "content.md"])
