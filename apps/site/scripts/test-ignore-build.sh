#!/usr/bin/env bash
# Tests the site's Ignored Build Step (ignore-build.sh) against a throwaway repository and a
# shallow clone of it, the way Vercel checks out a push. No network.
#
#   apps/site/scripts/test-ignore-build.sh
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/ignore-build.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0
git_() { git -c user.name=test -c user.email=test@example.com -c init.defaultBranch=dev -c advice.detachedHead=false "$@"; }

# The "GitHub" repository: dev with a few commits, then branches off it.
origin="$work/origin"
git_ init --quiet "$origin"
commit() { # commit <file> [message]: changes a file in origin and commits it
  mkdir -p "$origin/$(dirname "$1")"
  echo "$RANDOM" >>"$origin/$1"
  git_ -C "$origin" add -A
  git_ -C "$origin" commit --quiet -m "${2:-$1}"
  git_ -C "$origin" rev-parse HEAD
}
commit apps/site/page.tsx >/dev/null
commit docs/operations.md >/dev/null
commit packages/core/src/Point.ts >/dev/null
old=$(git_ -C "$origin" rev-parse HEAD)
for i in $(seq 1 12); do commit "packages/core/src/f$i.ts" >/dev/null; done
docs=$(commit docs/operations.md)
gateway=$(commit apps/gateway/src/Cli.ts)

# check <name> <want: build|skip> <ref to check out> [VAR=value...]: runs the step on a shallow
# clone of origin at that ref, as Vercel does.
check() {
  local name="$1" want="$2" ref="$3" clone got
  shift 3
  clone="$work/clone-$RANDOM"
  git_ clone --quiet --depth=10 --no-single-branch "file://$origin" "$clone" 2>/dev/null
  git_ -C "$clone" checkout --quiet "$ref"
  if (cd "$clone/apps/site" 2>/dev/null || cd "$clone" && env OT_GATEWAY_IGNORE_BUILD_REMOTE="file://$origin" "$@" bash "$script" >"$work/out" 2>&1); then got=skip; else got=build; fi
  if [ "$got" = "$want" ]; then
    echo "ok: $name"
  else
    echo "FAIL: $name: wanted $want, got $got" >&2
    sed 's/^/  /' "$work/out" >&2
    failures=$((failures + 1))
  fi
  rm -rf "$clone"
}

check "production always builds" build dev VERCEL_ENV=production VERCEL_GIT_COMMIT_REF=main VERCEL_GIT_PREVIOUS_SHA="$gateway"
check "dev: nothing new since the last deployment" skip dev VERCEL_GIT_COMMIT_REF=dev VERCEL_GIT_PREVIOUS_SHA="$gateway"
check "dev: a docs change before the last commit" build dev VERCEL_GIT_COMMIT_REF=dev VERCEL_GIT_PREVIOUS_SHA="$(git -C "$origin" rev-parse "$docs^")"
check "dev: a last deployment beyond the shallow clone is fetched" skip "$docs^" VERCEL_GIT_COMMIT_REF=dev VERCEL_GIT_PREVIOUS_SHA="$old"
check "dev: a site change beyond the shallow clone" build dev VERCEL_GIT_COMMIT_REF=dev VERCEL_GIT_PREVIOUS_SHA="$(git -C "$origin" rev-list --max-parents=0 HEAD)"
check "dev: never deployed builds" build dev VERCEL_GIT_COMMIT_REF=dev
check "dev: an unknown last deployment builds" build dev VERCEL_GIT_COMMIT_REF=dev VERCEL_GIT_PREVIOUS_SHA=0000000000000000000000000000000000000000

# Branches off dev's tip.
git_ -C "$origin" checkout --quiet -b fix/docs-only
commit docs/troubleshooting.md >/dev/null
commit apps/gateway/src/Codes.ts >/dev/null
commit pnpm-lock.yaml >/dev/null
git_ -C "$origin" checkout --quiet -b feat/site dev
commit apps/site/home.tsx >/dev/null
commit apps/gateway/src/Status.ts >/dev/null
git_ -C "$origin" checkout --quiet dev

check "branch: gateway, docs and lockfile only" skip fix/docs-only VERCEL_GIT_COMMIT_REF=fix/docs-only
check "branch: a site change before the last commit" build feat/site VERCEL_GIT_COMMIT_REF=feat/site
check "branch: no site change since its last deployment" skip feat/site VERCEL_GIT_COMMIT_REF=feat/site VERCEL_GIT_PREVIOUS_SHA="$(git -C "$origin" rev-parse feat/site^)"
check "branch: dev cannot be fetched builds" build fix/docs-only VERCEL_GIT_COMMIT_REF=fix/docs-only OT_GATEWAY_IGNORE_BUILD_REMOTE="file://$work/missing"

# Not a git checkout.
mkdir -p "$work/plain"
if (cd "$work/plain" && GIT_CEILING_DIRECTORIES="$work" bash "$script" >"$work/out" 2>&1); then
  echo "FAIL: outside a git checkout: skipped" >&2
  failures=$((failures + 1))
elif grep -q "not a git checkout" "$work/out"; then
  echo "ok: outside a git checkout builds"
else
  echo "FAIL: outside a git checkout: $(cat "$work/out")" >&2
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures failed" >&2
  exit 1
fi
echo "all passed"
