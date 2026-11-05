import { pageSchema } from "fumadocs-core/source/schema"
import { defineConfig, defineDocs } from "fumadocs-mdx/config"
import { z } from "zod"

/** The docs pages are generated from the repository's Markdown by scripts/content.ts. */
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema.extend({
      /** The page's source file on GitHub. */
      source: z.string()
    }),
    postprocess: {
      // Keeps the processed Markdown, so every page is also served as `.md` and folded into `llms-full.txt`.
      includeProcessedMarkdown: true
    }
  }
})

export default defineConfig({})
