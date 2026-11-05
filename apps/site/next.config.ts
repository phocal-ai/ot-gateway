/**
 * The project and docs site is a static export: `pnpm --filter @ot-gateway/site build`
 * writes apps/site/out, which Vercel serves (vercel.json adds the `.md` URLs).
 */
import { createMDX } from "fumadocs-mdx/next"
import type { NextConfig } from "next"

const config: NextConfig = {
  output: "export",
  // Types are checked by the repo's `pnpm typecheck` (TypeScript 7).
  typescript: { ignoreBuildErrors: true },
  images: { unoptimized: true },
  poweredByHeader: false,
  experimental: {
    // Next's own TypeScript step needs the TypeScript CLI under TypeScript 7.
    useTypeScriptCli: true
  }
}

export default createMDX()(config)
