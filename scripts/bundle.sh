#!/usr/bin/env bash
# The CLI and the gateway as one ES module, Effect and our packages included:
#
#   scripts/bundle.sh <outfile>      # usually <somewhere>/apps/gateway/src/main.mjs
#
# The npm package (build-package.sh) and the container image (Dockerfile) both
# run this bundle. Node starts it about three times faster than the ~550
# TypeScript and Effect modules it is made of (3.3 s against 1.0 s for
# `--version` on a Raspberry Pi 4), and a running gateway has a third less heap,
# because it reads one file and strips no types.
#
# Put it at apps/gateway/src/ next to the repository's layout: the paths the
# gateway computes from import.meta.url (Version.ts, Demo.ts, Status.ts,
# Folder.ts, Profile.ts) are relative to that folder. The target is the oldest
# Node the package supports; main.ts's shebang (with --max-semi-space-size)
# stays at the top.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
out=${1:?usage: scripts/bundle.sh <outfile>}
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
pnpm -C "$repo/apps/gateway" exec esbuild src/main.ts --bundle --platform=node --format=esm \
  --target=node22.18 --log-level=warning --outfile="$out" \
  --banner:js="import { createRequire as __otGatewayRequire } from 'node:module'; const require = __otGatewayRequire(import.meta.url);"
chmod 755 "$out"
