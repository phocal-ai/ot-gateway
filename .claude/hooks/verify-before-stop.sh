#!/bin/bash
# Stop: run the same gate as CI (`pnpm check`) before Claude reports a change
# as done. Turbo caches typecheck and test, so an unchanged tree costs ~1s.
set -euo pipefail
INPUT=$(cat)

# Re-prompted once already: let Claude stop and report the failure itself.
[ "$(jq -r '.stop_hook_active // false' <<<"$INPUT")" = "true" ] && exit 0

cd "$(jq -r '.cwd' <<<"$INPUT")"
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$ROOT" ] && [ -d "$ROOT/node_modules" ] || exit 0
cd "$ROOT"

# Nothing changed against the last commit and nothing untracked: the tree
# already passed (or CI will say otherwise); skip.
if [ -z "$(git status --porcelain --untracked-files=normal)" ]; then
  exit 0
fi

if ! CHECK_OUTPUT=$(pnpm check 2>&1); then
  # Keep the reason short enough to read; the tail holds the failing step.
  jq -n --arg reason "pnpm check failed. Fix it before finishing, or say why it cannot pass:

$(tail -n 60 <<<"$CHECK_OUTPUT")" '{ decision: "block", reason: $reason }'
fi
exit 0
