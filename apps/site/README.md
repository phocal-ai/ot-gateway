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

The site is the Vercel project `ot-gateway` (team `wimluks-projects`), live at https://ot-gateway.vercel.app. Its settings live in this directory, not in the dashboard:

- `vercel.json` sets the Next.js framework. Without it, a project created from the CLI uses the static builder, which serves every page but `/`. It also rewrites `/` to the exported `index` page and serves the `.md` twins.
- `package.json` pins `engines.node` to `24.x`, the version in `.nvmrc`. Vercel otherwise resolves the root's `>=22.18` to a Node version it does not support.

Deploy from a checkout of the branch to publish, in this directory. The build runs locally and only `.vercel/output` is uploaded:

```bash
vercel link --yes --project ot-gateway --scope wimluks-projects   # once per checkout
VERCEL_GIT_COMMIT_SHA=$(git rev-parse HEAD) vercel build --prod --yes
vercel deploy --prebuilt --prod --yes
```

Links to GitHub point at the commit being built (`VERCEL_GIT_COMMIT_SHA`), or at `dev` in a local build.
