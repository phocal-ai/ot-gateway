#!/usr/bin/env bash
# Tells whether the agent's staged change is limited to manifests and the lockfile
# (.github/workflows/deps.yml). The deps job merges its update on its own only then;
# any other file waits for a person. It runs after routine-diff-check.sh.
#
#   routine-manifests-only.sh
#
# Prints `true` when every staged path is package.json (at any depth),
# pnpm-lock.yaml or pnpm-workspace.yaml, otherwise `false`, with the other paths on
# stderr. Exits 0 in both cases, 1 when the staged change is empty. Paths under
# repos/ never count as manifests.
# scripts/test-routines.sh tests it.
set -euo pipefail

names=$(git diff --cached --name-only --no-renames)
if [ -z "$names" ]; then
  echo "routine-manifests-only: the change is empty" >&2
  exit 1
fi

answer=true
while IFS= read -r path; do
  case $path in
    repos/*) ;;
    package.json | */package.json | pnpm-lock.yaml | pnpm-workspace.yaml) continue ;;
  esac
  echo "routine-manifests-only: $path is not a manifest" >&2
  answer=false
done <<<"$names"
echo "$answer"
