import { site } from "@/lib/site.ts"
import { docsLlms } from "@/lib/source.ts"

export const dynamic = "force-static"

export const GET = () => {
  // The generated index opens with its own heading; the llms.txt header replaces it.
  const index = docsLlms.index().replace(/^# .*\n+/, "")
  const header = [
    `# ${site.title}`,
    `> ${site.description}`,
    "Every docs page is also served as Markdown: append `.md` to its URL. `/llms-full.txt` holds every page in one file."
  ].join("\n\n")
  return new Response(`${header}\n\n${index}`, { headers: { "Content-Type": "text/markdown; charset=utf-8" } })
}
