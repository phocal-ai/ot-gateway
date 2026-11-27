#!/usr/bin/env bash
# Vercel's Ignored Build Step for the site (vercel.json `ignoreCommand`): exit 0 skips the
# deployment, exit 1 builds it. Vercel used to build every push to every branch, while most pull
# requests change only the gateway, so a busy day ran into the plan's daily deployment limit.
#
# - main (production, a release) always builds.
# - dev builds when anything the site reads changed: its own code and build setup, and the
#   Markdown it turns into docs pages (docs/, README.md, see scripts/content.ts). Its deployment is
#   the preview of the next release's docs.
# - Any other branch builds a preview only when the site's code or build setup changed. Most pull
#   requests also touch docs/, so a preview for those would still be nearly every push; CI builds
#   the site on every pull request instead ("Build the docs site" in .github/workflows/ci.yml).
#
# Compared with the commit Vercel last deployed for the branch (VERCEL_GIT_PREVIOUS_SHA), else the
# tip of dev (a branch's first deployment), else the parent commit. When unsure, it builds.
#
# Try it: VERCEL_GIT_COMMIT_REF=my-branch VERCEL_GIT_REPO_OWNER=phocal-ai \
#   VERCEL_GIT_REPO_SLUG=ot-gateway apps/site/scripts/ignore-build.sh; echo $?
set -uo pipefail

# The site's code and what the install and the compiler read at the repository's root.
paths=(
  apps/site
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  tsconfig.base.json
  .nvmrc
)
branch="${VERCEL_GIT_COMMIT_REF:-}"
[ "$branch" = "dev" ] && paths+=(docs README.md)

build() {
  echo "ignore-build: building ($1)"
  exit 1
}

skip() {
  echo "ignore-build: skipped, none of ${paths[*]} changed since ${1}"
  exit 0
}

[ "${VERCEL_ENV:-}" = "production" ] && build "production"

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || build "not a git checkout"

has_commit() { [ -n "$1" ] && git cat-file -e "${1}^{commit}" 2>/dev/null; }

changed() {
  ! git diff --quiet "$1" HEAD -- "${paths[@]}"
}

base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if ! has_commit "$base"; then
  base=""
  # A branch's first deployment: compare its tree with dev's. Vercel clones shallow, so fetch
  # dev's tip alone; a site change that landed on dev meanwhile also builds, which is harmless.
  if [ -n "$branch" ] && [ "$branch" != "dev" ] && [ -n "${VERCEL_GIT_REPO_OWNER:-}" ] && [ -n "${VERCEL_GIT_REPO_SLUG:-}" ]; then
    url="https://github.com/${VERCEL_GIT_REPO_OWNER}/${VERCEL_GIT_REPO_SLUG}.git"
    if timeout 60 git fetch --quiet --depth=1 --no-tags "$url" dev 2>/dev/null; then
      base="$(git rev-parse FETCH_HEAD)"
    fi
  fi
  if [ -z "$base" ] && has_commit HEAD^; then base="$(git rev-parse HEAD^)"; fi
fi
[ -n "$base" ] || build "no commit to compare with"

if changed "$base"; then
  git diff --name-only "$base" HEAD -- "${paths[@]}" | head -20 | sed 's/^/  /'
  build "these changed since ${base:0:12}"
fi
skip "${base:0:12}"
