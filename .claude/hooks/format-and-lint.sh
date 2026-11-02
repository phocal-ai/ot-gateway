#!/bin/bash
# PostToolUse (Write|Edit): format the edited file with oxfmt, then lint it
# with oxlint and hand any findings back to Claude, so they are fixed while the
# file is still in view instead of at `pnpm check` time.
set -euo pipefail
INPUT=$(cat)

FILE_PATH=$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")
[ -n "$FILE_PATH" ] && [ -f "$FILE_PATH" ] || exit 0

case "$FILE_PATH" in
  *.ts | *.tsx | *.js | *.mjs | *.json | *.md | *.yml | *.yaml) ;;
  *) exit 0 ;;
esac

# Run from the file's own checkout so its configs and ignore patterns
# (repos/**, generated dashboards) apply. Files outside a plenum checkout with
# installed tools (memory files, other repos) are left alone.
ROOT=$(git -C "$(dirname "$FILE_PATH")" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$ROOT" ] && [ -x "$ROOT/node_modules/.bin/oxfmt" ] && [ -f "$ROOT/.oxfmtrc.json" ] || exit 0
cd "$ROOT"

node_modules/.bin/oxfmt --write --no-error-on-unmatched-pattern "$FILE_PATH" >/dev/null 2>&1 || true

case "$FILE_PATH" in
  *.ts | *.tsx | *.js | *.mjs) ;;
  *) exit 0 ;;
esac
[ -x node_modules/.bin/oxlint ] || exit 0

if ! LINT_OUTPUT=$(node_modules/.bin/oxlint --type-aware --disable-nested-config --deny-warnings "$FILE_PATH" 2>&1); then
  jq -n --arg reason "oxlint findings in $FILE_PATH (fix them now):

$LINT_OUTPUT" '{ decision: "block", reason: $reason }'
fi
exit 0
