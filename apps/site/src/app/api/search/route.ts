import { createFromSource } from "fumadocs-core/search/server"
import { source } from "@/lib/source.ts"

// Written once at build time; the search dialog downloads it and searches in the browser.
export const dynamic = "force-static"

export const { staticGET: GET } = createFromSource(source)
