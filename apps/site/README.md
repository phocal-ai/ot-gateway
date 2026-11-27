# @ot-gateway/site

The project and docs site: a landing page and the docs, built with [Fumadocs](https://fumadocs.dev) on Next.js as a static export. It runs no server.

The docs pages are not written here. `scripts/content.ts` generates them into `content/docs/` (git-ignored) from the repository's `docs/*.md` and the README's quick-start sections. It also rewrites links: a link to another docs page goes to its site URL, and a link to any other repository file goes to GitHub. To change a page, edit the Markdown in `docs/` or the README; `src/content/docs.ts` lists the pages, their order and descriptions. `test/docs.test.ts` fails when a listed file or README section is missing, or a relative link is left unrewritten.

A ` ```mermaid ` block in that Markdown is a diagram, which GitHub draws. When its first line is the Mermaid comment `%% site: <name>`, the site draws the React component of that name instead (`src/components/docs/diagrams.tsx`, in the home page's design), and `test/docs.test.ts` fails for a name without one. Keep the block and its component saying the same.

```bash
pnpm --filter @ot-gateway/site dev     # http://localhost:3001, regenerates the docs on start
pnpm --filter @ot-gateway/site build   # writes out/
python3 -m http.server 3001 -d apps/site/out   # preview the export (add .html to docs URLs; Vercel serves clean URLs)
```

Each docs page also exists as Markdown. The build writes it to `/llms.mdx/docs/<page>/content.md`, and `vercel.json` serves it at the page's URL plus `.md`. `/llms.txt` indexes the pages and `/llms-full.txt` holds all of them in one file. Search uses a static index that the browser downloads from `/api/search`.

Every docs page opens with "Explore with an AI agent": prompts to copy into any agent that can read a web page (a TL;DR and one about the reader's own site), each pointing at the page's `.md` twin on the production address (also in a local build, since an agent cannot read localhost), so a reader gets the page explained and keeps asking in their own chat. The prompts are in `src/content/explore.ts`, the block in `src/components/docs/explore-prompt.tsx`.

## Vercel

The site is the Vercel project `ot-gateway` (team `wimluks-projects`), live at https://ot-gateway.vercel.app. Vercel's GitHub integration builds it:

- a push to `main` (a release) deploys production, so the public docs match the latest release;
- every pull request gets a preview deployment and a `Vercel` check.

Project settings: root directory `apps/site` and Node.js 24.x. The rest lives in this directory, so it is reviewed with the code:

- `vercel.json` sets the Next.js framework, rewrites `/` to the exported `index` page (without it, `/` is a 404 under clean URLs) and serves the `.md` twins.
- `package.json` pins `engines.node` to `24.x`, the version in `.nvmrc`. Vercel otherwise resolves the root's `>=22.18` to a Node version it does not support.

Links to GitHub point at the commit being built (`VERCEL_GIT_COMMIT_SHA`), or at `dev` in a local build.
