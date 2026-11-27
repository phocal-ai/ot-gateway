#!/usr/bin/env bash
# Vercel's Ignored Build Step for the site (vercel.json `ignoreCommand`): exit 0 skips the
# deployment, exit 1 builds it. Vercel used to build every push to every branch, while most pull
# requests change only the gateway, so a busy day ran into the plan's daily deployment limit.
#
# - main (production, a release) always builds.
# - dev builds when anything the site reads changed: its own code and build setup, the lockfile,
#   and the Markdown it turns into docs pages (docs/, README.md, see scripts/content.ts). Its
#   deployment is the preview of the next release's docs.
# - Any other branch (vercel.json's git.deploymentEnabled leaves only site/** deploying) builds a
#   preview only when the site's code or build setup changed. Most pull requests also touch docs/,
#   and dependency bumps the lockfile, so a preview for those would still be nearly every push; CI
#   builds the site on every pull request instead ("Build the docs site" in
#   .github/workflows/ci.yml).
#
# Compared with the commit Vercel last deployed for the branch (VERCEL_GIT_PREVIOUS_SHA), fetched
# when the shallow clone lacks it; on a branch without one, with the tip of dev. When there is
# nothing to compare with, it builds. Tested by test-ignore-build.sh.
#
# Try it: VERCEL_GIT_COMMIT_REF=my-branch VERCEL_GIT_REPO_OWNER=phocal-ai \
#   VERCEL_GIT_REPO_SLUG=ot-gateway apps/site/scripts/ignore-build.sh; echo $?
set -uo pipefail

# The site's code and what the install and the compiler read at the repository's root.
paths=(
  apps/site
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .nvmrc
)
branch="${VERCEL_GIT_COMMIT_REF:-}"
[ "$branch" = "dev" ] && paths+=(pnpm-lock.yaml docs README.md)

build() {
  echo "ignore-build: building ($1)"
  exit 1
}

[ "${VERCEL_ENV:-}" = "production" ] && build "production"

top="$(git rev-parse --show-toplevel 2>/dev/null)" && cd "$top" || build "not a git checkout"

# The repository to fetch from (OT_GATEWAY_IGNORE_BUILD_REMOTE in the test).
remote="${OT_GATEWAY_IGNORE_BUILD_REMOTE:-}"
if [ -z "$remote" ] && [ -n "${VERCEL_GIT_REPO_OWNER:-}" ] && [ -n "${VERCEL_GIT_REPO_SLUG:-}" ]; then
  remote="https://github.com/${VERCEL_GIT_REPO_OWNER}/${VERCEL_GIT_REPO_SLUG}.git"
fi

has_commit() { [ -n "$1" ] && git cat-file -e "${1}^{commit}" 2>/dev/null; }

# Fetches one commit or branch tip alone (Vercel clones shallow); the diff needs only its tree.
fetch() { [ -n "$remote" ] && timeout 60 git fetch --quiet --depth=1 --no-tags "$remote" "$1" 2>/dev/null; }

base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -n "$base" ] && ! has_commit "$base"; then
  fetch "$base"
  has_commit "$base" || base=""
fi
# A branch's first deployment: compare its tree with dev's. A site change that landed on dev
# since the branch started also builds, which is harmless.
if [ -z "$base" ] && [ -n "$branch" ] && [ "$branch" != "dev" ] && fetch dev; then
  base="$(git rev-parse FETCH_HEAD)"
fi
[ -n "$base" ] || build "no commit to compare with"

if ! git diff --quiet "$base" HEAD -- "${paths[@]}"; then
  git diff --name-only "$base" HEAD -- "${paths[@]}" | head -20 | sed 's/^/  /'
  build "these changed since ${base:0:12}"
fi
echo "ignore-build: skipped, none of ${paths[*]} changed since ${base:0:12}"
exit 0
