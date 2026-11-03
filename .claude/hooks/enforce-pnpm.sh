#!/bin/bash
# PreToolUse (Bash): this is a pnpm workspace; npm/yarn would write a second
# lockfile and skip the `prepare` patch of tsc.
set -euo pipefail
COMMAND=$(jq -r '.tool_input.command // empty')

if grep -qE '(^|[;&|(`[:space:]])(npm|yarn)[[:space:]]+(install|i|add|ci|run|exec|test|start|remove|uninstall)\b' <<<"$COMMAND"; then
  jq -n '{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Use pnpm (this is a pnpm workspace): pnpm install, pnpm add, pnpm <script>, pnpm exec." } }'
fi
exit 0
