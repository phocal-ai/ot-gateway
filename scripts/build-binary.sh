#!/usr/bin/env bash
# The `ot-gateway` binary: the gateway, its status page and its CLI in one file,
# with Node inside, so a machine needs nothing else to run it.
#
#   scripts/build-binary.sh                          # for this machine
#   scripts/build-binary.sh linux-arm64 linux-x64    # for others (darwin-arm64 only on a Mac)
#
# Out come dist/binary/ot-gateway-<target>.tar.gz (one file, `ot-gateway`) and
# dist/binary/SHA256SUMS, the names packaging/get.sh downloads from a release.
# OT_GATEWAY_VERSION sets what `ot-gateway --version` says (default: git describe).
#
# How: esbuild bundles apps/gateway/src/main.ts into one ES module, and Node's
# single executable applications (`node --build-sea`, Node 26.9 or newer, the
# same version as the Node inside) put it into the official Node binary for each
# target, downloaded from nodejs.org and checked against its SHASUMS256.txt. The
# bundle, the VERSION file, the example config and the built status page go into
# the binary's read-only virtual file system in the repository's layout, so the
# paths the gateway computes from `import.meta.url` (Version.ts, Demo.ts,
# Status.ts) find them there unchanged. No code cache or snapshot: those only
# load on the platform that built them, and this cross-builds.
#
# On Linux the binary needs glibc and libatomic1, as Node does (Raspberry Pi OS
# and Debian/Ubuntu desktop and server installs have both).
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
out="$repo/dist/binary"
stage="$out/stage"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/ot-gateway/node"

host_target() {
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) echo "unsupported OS: $(uname -s)" >&2; return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "unsupported CPU: $(uname -m)" >&2; return 1 ;;
  esac
  echo "$os-$arch"
}

targets=("$@")
[[ ${#targets[@]} -eq 0 ]] && targets=("$(host_target)")
for target in "${targets[@]}"; do
  case "$target" in
    linux-arm64 | linux-x64) ;;
    darwin-arm64) [[ "$(uname -s)" == Darwin ]] || { echo "darwin-arm64 needs a Mac to sign it" >&2; exit 1; } ;;
    *) echo "unknown target $target (linux-arm64, linux-x64 or darwin-arm64)" >&2; exit 1 ;;
  esac
done

node_version=$(node --version)
IFS=. read -r major minor _ <<<"${node_version#v}"
if ((major < 26 || (major == 26 && minor < 9))); then
  echo "needs Node 26.9 or newer for --build-sea with a virtual file system; this is $node_version" >&2
  exit 1
fi

version=${OT_GATEWAY_VERSION:-$(git -C "$repo" describe --tags --always --dirty 2>/dev/null || echo dev)}
echo "ot-gateway $version, Node $node_version, for ${targets[*]}"

rm -rf "$out"
mkdir -p "$stage/apps/gateway/src" "$stage/examples" "$cache"

# The status page (a static export, cached by Turborepo) and the bundle.
pnpm -C "$repo" exec turbo run build --filter=@ot-gateway/web --output-logs=errors-only
pnpm -C "$repo/apps/gateway" exec esbuild src/main.ts --bundle --platform=node --format=esm \
  --target="node$major" --log-level=warning --outfile="$stage/apps/gateway/src/main.mjs" \
  --banner:js="import { createRequire as __otGatewayRequire } from 'node:module'; const require = __otGatewayRequire(import.meta.url);"
echo "$version" >"$stage/VERSION"
cp "$repo/examples/gateway.json" "$stage/examples/"
mkdir -p "$stage/apps/web"
cp -R "$repo/apps/web/out" "$stage/apps/web/out"
# The executable's main script sits at the root of the virtual file system. It loads ot-gateway.env from
# the current folder, as `pnpm ot-gateway` does, without --env-file-if-exists's notice when there is none,
# then starts the bundle where the repository has main.ts.
cat >"$stage/sea-main.mjs" <<'EOF'
import { existsSync } from "node:fs"
if (existsSync("ot-gateway.env")) process.loadEnvFile("ot-gateway.env")
await import("./apps/gateway/src/main.mjs")
EOF

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# Node for a target, from nodejs.org, checked against the release's checksums.
fetch_node() {
  local target=$1 name="node-$node_version-$1"
  local archive="$name.tar.xz"
  [[ $target == darwin-* ]] && archive="$name.tar.gz"
  if [[ ! -x "$cache/$name/bin/node" ]]; then
    curl -fsSL -o "$cache/$archive" "https://nodejs.org/dist/$node_version/$archive"
    curl -fsSL "https://nodejs.org/dist/$node_version/SHASUMS256.txt" | grep " $archive\$" >"$cache/$archive.sha256"
    (cd "$cache" && sha256 -c "$archive.sha256" >/dev/null)
    tar -xf "$cache/$archive" -C "$cache"
    rm "$cache/$archive" "$cache/$archive.sha256"
  fi
  echo "$cache/$name/bin/node"
}

# A strip that understands the target's machine code, if there is one: Node's Linux builds carry about 30 MB
# of symbols. Without one, the binary is only bigger.
strip_tool() {
  local target=$1
  local gnu=x86_64-linux-gnu-strip
  [[ $target == linux-arm64 ]] && gnu=aarch64-linux-gnu-strip
  if command -v "$gnu" >/dev/null; then echo "$gnu"; return; fi
  if [[ "$(host_target)" == "$target" ]] && command -v strip >/dev/null; then echo strip; return; fi
  if command -v llvm-strip >/dev/null; then echo llvm-strip; return; fi
}

# The SEA configuration lists every staged file as an asset, under its path in the stage.
# shellcheck disable=SC2016 # the node -e is JavaScript, with its own template literal
assets_json() {
  (cd "$stage" && find . -type f ! -name sea-main.mjs | sed 's#^\./##' | sort) |
    node -e '
      const stage = process.argv[1]
      const files = require("node:fs").readFileSync(0, "utf8").trim().split("\n")
      process.stdout.write(JSON.stringify(Object.fromEntries(files.map((file) => [file, `${stage}/${file}`]))))
    ' "$stage"
}
assets=$(assets_json)

for target in "${targets[@]}"; do
  executable=$(fetch_node "$target")
  base="$out/$target"
  mkdir -p "$base"
  if [[ $target == linux-* ]]; then
    tool=$(strip_tool "$target")
    if [[ -n $tool ]]; then
      cp "$executable" "$base/node"
      "$tool" "$base/node"
      executable="$base/node"
    else
      echo "no strip for $target: the binary keeps Node's symbols" >&2
    fi
  fi
  cat >"$base/sea.json" <<EOF
{
  "main": "$stage/sea-main.mjs",
  "mainFormat": "module",
  "executable": "$executable",
  "output": "$base/ot-gateway",
  "disableExperimentalSEAWarning": true,
  "useVfs": true,
  "useCodeCache": false,
  "useSnapshot": false,
  "execArgv": ["--max-semi-space-size=4"],
  "execArgvExtension": "env",
  "assets": $assets
}
EOF
  node --build-sea "$base/sea.json" >/dev/null
  if [[ $target == darwin-* ]]; then codesign --sign - --force "$base/ot-gateway" 2>/dev/null; fi
  # Without macOS's extended attributes, which GNU tar warns about on the Pi.
  if [[ "$(uname -s)" == Darwin ]]; then
    COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf "$out/ot-gateway-$target.tar.gz" -C "$base" ot-gateway
  else
    tar -czf "$out/ot-gateway-$target.tar.gz" -C "$base" ot-gateway
  fi
  echo "  $target: $(du -h "$base/ot-gateway" | cut -f1) ($(du -h "$out/ot-gateway-$target.tar.gz" | cut -f1) compressed)"
done

(cd "$out" && sha256 ot-gateway-*.tar.gz >SHA256SUMS)
echo "dist/binary: $(cd "$out" && echo ot-gateway-*.tar.gz SHA256SUMS)"
