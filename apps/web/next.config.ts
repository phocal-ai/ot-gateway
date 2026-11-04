/**
 * The status page is a static export: `pnpm --filter @ot-gateway/web build`
 * writes apps/web/out, which the gateway serves with its API (see
 * apps/gateway/src/Status.ts), so a Raspberry Pi never runs a Next.js server.
 */
import type { NextConfig } from "next"

const config: NextConfig = {
  output: "export",
  // `@ot-gateway/api` is TypeScript source in the workspace, like every OT Gateway package.
  transpilePackages: ["@ot-gateway/api"],
  // Types are checked by the repo's `pnpm typecheck` (TypeScript 7 with the Effect language service).
  typescript: { ignoreBuildErrors: true },
  images: { unoptimized: true },
  poweredByHeader: false
}

export default config
