# @ot-gateway/site

The project and docs site: a landing page and the docs, built with [Fumadocs](https://fumadocs.dev) on Next.js as a static export. It runs no server.

The docs pages are not written here. `scripts/content.ts` generates them into `content/docs/` (git-ignored) from the repository's `docs/*.md` and the README's quick-start sections. It also rewrites links: a link to another docs page goes to its site URL, and a link to any other repository file goes to GitHub. To change a page, edit the Markdown in `docs/` or the README; `src/content/docs.ts` lists the pages, their order and descriptions. `test/docs.test.ts` fails when a listed file or README section is missing, or a relative link is left unrewritten.

```bash
pnpm --filter @ot-gateway/site dev     # http://localhost:3001, regenerates the docs on start
pnpm --filter @ot-gateway/site build   # writes out/
python3 -m http.server 3001 -d apps/site/out   # preview the export (add .html to docs URLs; Vercel serves clean URLs)
```

Each docs page also exists as Markdown. The build writes it to `/llms.mdx/docs/<page>/content.md`, and `vercel.json` serves it at the page's URL plus `.md`. `/llms.txt` indexes the pages and `/llms-full.txt` holds all of them in one file. Search uses a static index that the browser downloads from `/api/search`.

## Vercel

The Vercel project uses root directory `apps/site` and the Next.js preset; Vercel detects pnpm and installs the workspace. Links to GitHub point at the commit being built (`VERCEL_GIT_COMMIT_SHA`), or at `dev` in a local build.
