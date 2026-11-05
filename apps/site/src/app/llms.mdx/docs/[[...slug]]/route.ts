import { notFound } from "next/navigation"
import { docsLlms, source } from "@/lib/source.ts"

export const dynamic = "force-static"

interface Context {
  readonly params: Promise<{ readonly slug: Array<string> }>
}

export const GET = async (_request: Request, { params }: Context) => {
  const { slug } = await params
  // The last segment is the `content.md` that generateStaticParams appends, so the export writes a `.md` file.
  const page = source.getPage(slug.slice(0, -1))
  if (page === undefined) notFound()
  return new Response(await docsLlms.page(page), { headers: { "Content-Type": "text/markdown; charset=utf-8" } })
}

export const generateStaticParams = () =>
  source.generateParams().map((params) => ({ slug: [...params.slug, "content.md"] }))
