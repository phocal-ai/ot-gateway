import { site } from "@/lib/site.ts"
import { docsLlms } from "@/lib/source.ts"

export const dynamic = "force-static"

export const GET = () => {
  // The generated index opens with its own heading; the llms.txt header replaces it.
  const index = docsLlms.index().replace(/^# .*\n+/, "")
  const header = [
    `# ${site.title}`,
    `> ${site.description}`,
    "Every docs page is also served as Markdown: append `.md` to its URL. `/llms-full.txt` holds every page in one file.",
    "To set up a gateway for a user, follow the setup guide: /docs/setup-guide.md (the ot-gateway MCP server serves the same guide as its `setup` prompt and `setup_guide` tool)."
  ].join("\n\n")
  return new Response(`${header}\n\n${index}`, { headers: { "Content-Type": "text/markdown; charset=utf-8" } })
}
