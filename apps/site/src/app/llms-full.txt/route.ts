import { docsLlms } from "@/lib/source.ts"

export const dynamic = "force-static"

export const GET = async () =>
  new Response(await docsLlms.full(), { headers: { "Content-Type": "text/markdown; charset=utf-8" } })
