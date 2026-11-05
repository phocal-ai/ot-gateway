#!/usr/bin/env bash
# Checks the agent's change before a routine commits it (.github/workflows/deps.yml,
# triage.yml). It runs in the writing job, on the staged diff, after `git apply`.
#
#   routine-diff-check.sh
#
# Refuses (exit 1, with the reason) when the staged change:
# - is empty;
# - touches .github/, .claude/, repos/, packaging/install.sh, .gitattributes or
#   .gitmodules: workflows, agent settings, the reference subtrees, the root
#   installer and git's own behaviour stay human-reviewed changes (the deps job pulls
#   repos/effect itself, before it applies the patch, so that pull is not in here);
# - adds a symlink or a submodule;
# - changes more than 400 files or 20 MB.
# scripts/test-routines.sh tests it.
set -euo pipefail

refuse() {
  echo "routine-diff-check: $*" >&2
  exit 1
}

names=$(git diff --cached --name-only --no-renames)
[ -n "$names" ] || refuse "the change is empty"

while IFS= read -r path; do
  case $path in
    .github/* | .claude/* | repos/* | packaging/install.sh | .gitattributes | */.gitattributes | .gitmodules)
      refuse "the change touches $path, which a routine may not change"
      ;;
  esac
done <<<"$names"

# Modes on the new side: 120000 is a symlink, 160000 a submodule.
if git diff --cached --raw --no-renames | awk '{ print $2 }' | grep -qE '^(120000|160000)$'; then
  refuse "the change adds a symlink or a submodule"
fi

count=$(wc -l <<<"$names")
[ "$count" -le 400 ] || refuse "the change touches $count files (at most 400)"

bytes=$(git diff --cached --binary | wc -c)
[ "$bytes" -le 20000000 ] || refuse "the change is $bytes bytes (at most 20 MB)"
echo "routine-diff-check: $count file(s), $bytes bytes"
