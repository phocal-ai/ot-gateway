#!/usr/bin/env bash
# The `ot-gateway` npm package: the CLI and the gateway bundled into one ES
# module, with the built status page, so `npx ot-gateway` works without a
# checkout.
#
#   scripts/build-package.sh             # dist/npm, and dist/ot-gateway-<version>.tgz
#
# OT_GATEWAY_VERSION sets the version (a release tag such as v0.8.0, or
# 0.8.0; default: 0.0.0-dev). A plain release (X.Y.Z, no prerelease suffix)
# must match the tag packaging/compose.yaml pins (OT_GATEWAY_TAG), which `init`
# writes next to ot-gateway.json: the script refuses to build otherwise, so a
# release whose pins pull request was missed cannot ship a compose file that
# runs the previous image. The package has no dependencies: esbuild bundles
# Effect and our packages, and Node runs it directly (Node does not strip
# TypeScript types under node_modules, so the sources cannot ship as they are).
#
# The package keeps the repository's layout (apps/gateway/src/main.mjs next to
# apps/web/out, examples/gateway.json, packaging/compose.yaml, profiles/ and VERSION), so the paths the gateway
# computes from `import.meta.url` (Version.ts, Demo.ts, Status.ts, Folder.ts, Profile.ts) find those
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

if [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  pinned=$(sed -n 's/^ *image: .*OT_GATEWAY_TAG:-\([^}]*\)}.*/\1/p' "$repo/packaging/compose.yaml")
  [[ $pinned == "v$version" ]] || {
    echo "packaging/compose.yaml pins ${pinned:-no tag}, not v$version: move the release pins first (CONTRIBUTING.md)" >&2
    exit 1
  }
fi

rm -rf "$out" "$repo"/dist/ot-gateway-*.tgz
mkdir -p "$out/apps/gateway/src" "$out/apps/web" "$out/examples" "$out/packaging" "$out/profiles"

# The status page (a static export, cached by Turborepo) and the bundle (scripts/bundle.sh, which the image runs too).
pnpm -C "$repo" exec turbo run build --filter=@ot-gateway/web --output-logs=errors-only
"$repo/scripts/bundle.sh" "$out/apps/gateway/src/main.mjs"
cp -R "$repo/apps/web/out" "$out/apps/web/out"
cp "$repo/examples/gateway.json" "$out/examples/"
# What `init` writes next to ot-gateway.json (Folder.ts).
cp "$repo/packaging/compose.yaml" "$out/packaging/"
# The device profile library that points lists name (Profile.ts).
cp "$repo"/profiles/*.json "$out/profiles/"
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
  "files": ["apps", "examples", "packaging", "profiles", "VERSION"],
  "engines": { "node": ">=22.18" }
}
EOF

(cd "$out" && pnpm pack --pack-destination "$repo/dist" >/dev/null)
echo "ot-gateway $version: dist/npm, $(cd "$repo/dist" && echo ot-gateway-*.tgz) ($(du -h "$repo"/dist/ot-gateway-*.tgz | cut -f1))"
