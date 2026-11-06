#!/usr/bin/env bash
# The `ot-gateway` npm package: the CLI and the gateway bundled into one ES
# module, with the built status page, so `npx ot-gateway` works without a
# checkout.
#
#   scripts/build-package.sh             # dist/npm, and dist/ot-gateway-<version>.tgz
#
# OT_GATEWAY_VERSION sets the version (a release tag such as v0.8.0, or
# 0.8.0; default: 0.0.0-dev). The package has no dependencies: esbuild bundles
# Effect and our packages, and Node runs it directly (Node does not strip
# TypeScript types under node_modules, so the sources cannot ship as they are).
#
# The package keeps the repository's layout (apps/gateway/src/main.mjs next to
# apps/web/out, examples/gateway.json, packaging/compose.yaml and VERSION), so the paths the gateway
# computes from `import.meta.url` (Version.ts, Demo.ts, Status.ts, Folder.ts) find those
# files without a change.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
out="$repo/dist/npm"

tag=${OT_GATEWAY_VERSION:-0.0.0-dev}
version=${tag#v}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "not a version: $tag" >&2
  exit 1
}

rm -rf "$out" "$repo"/dist/ot-gateway-*.tgz
mkdir -p "$out/apps/gateway/src" "$out/apps/web" "$out/examples" "$out/packaging"

# The status page (a static export, cached by Turborepo) and the bundle. The target is the oldest Node the
# package supports; main.ts's shebang (with --max-semi-space-size) stays at the top of the bundle.
pnpm -C "$repo" exec turbo run build --filter=@ot-gateway/web --output-logs=errors-only
pnpm -C "$repo/apps/gateway" exec esbuild src/main.ts --bundle --platform=node --format=esm \
  --target=node22.18 --log-level=warning --outfile="$out/apps/gateway/src/main.mjs" \
  --banner:js="import { createRequire as __otGatewayRequire } from 'node:module'; const require = __otGatewayRequire(import.meta.url);"
chmod 755 "$out/apps/gateway/src/main.mjs"
cp -R "$repo/apps/web/out" "$out/apps/web/out"
cp "$repo/examples/gateway.json" "$out/examples/"
# What `init` writes next to ot-gateway.json (Folder.ts).
cp "$repo/packaging/compose.yaml" "$out/packaging/"
# What --version, telemetry and the status page report: the tag, as the container image has it.
echo "v$version" >"$out/VERSION"
cp "$repo/LICENSE" "$out/"
cp "$repo/packaging/npm/README.md" "$out/"

cat >"$out/package.json" <<EOF
{
  "name": "ot-gateway",
  "version": "$version",
  "description": "Effect-native edge gateway for buildings: Modbus TCP and BACnet/IP in, MQTT 5 out. The CLI and the gateway in one package.",
  "license": "MIT",
  "homepage": "https://github.com/phocal-ai/ot-gateway",
  "repository": { "type": "git", "url": "git+https://github.com/phocal-ai/ot-gateway.git" },
  "bugs": "https://github.com/phocal-ai/ot-gateway/issues",
  "keywords": ["bacnet", "modbus", "mqtt", "building-automation", "gateway", "iot", "effect"],
  "type": "module",
  "bin": { "ot-gateway": "apps/gateway/src/main.mjs" },
  "files": ["apps", "examples", "packaging", "VERSION"],
  "engines": { "node": ">=22.18" }
}
EOF

(cd "$out" && pnpm pack --pack-destination "$repo/dist" >/dev/null)
echo "ot-gateway $version: dist/npm, $(cd "$repo/dist" && echo ot-gateway-*.tgz) ($(du -h "$repo"/dist/ot-gateway-*.tgz | cut -f1))"
