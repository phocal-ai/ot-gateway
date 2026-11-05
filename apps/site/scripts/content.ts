/**
 * Writes the site's docs pages (apps/site/content/docs, git-ignored) from the
 * repository's Markdown. Runs before `next build`, `next dev` and typecheck.
 *
 * Links that leave the site point at the commit Vercel builds
 * (VERCEL_GIT_COMMIT_SHA), or at `dev` for a local build.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { generatePage, meta, pages } from "../src/content/docs.ts"

const site = join(dirname(fileURLToPath(import.meta.url)), "..")
const root = join(site, "..", "..")
const out = join(site, "content", "docs")
const ref = process.env["VERCEL_GIT_COMMIT_SHA"] ?? "dev"

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const generated = pages.map((page) => generatePage(page, readFileSync(join(root, page.source), "utf8"), { ref }))
for (const file of [...generated, meta()]) writeFileSync(join(out, file.file), file.text)
console.log(`content: ${pages.length} docs pages from the repository, links at ${ref}`)
