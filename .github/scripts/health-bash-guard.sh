#!/usr/bin/env bash
# PreToolUse hook (Bash) for the scheduled Health agent, set in .github/workflows/health.yml.
#
# The agent's only shell command is one call of .github/scripts/health-gh.sh whose
# arguments are plain words or single-quoted strings ('\'' for an apostrophe). This
# hook denies every other command, including the read-only ones Claude Code runs
# without asking (cat, ls, echo, grep, find), so the agent reads files only through
# its file tools and their path rules. scripts/test-health-gh.sh tests it.
set -euo pipefail

deny() {
  jq -n --arg reason "$1" \
    '{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason } }'
  exit 0
}

# Exit 2 blocks the call, so unreadable input fails closed.
command=$(jq -r '.tool_input.command // ""') || {
  echo "health-bash-guard: could not read the hook input" >&2
  exit 2
}

# Claude Code itself prompts for commands over 10,000 characters, which this job denies.
[ "${#command}" -le 9000 ] || deny "Keep the command under 9,000 characters; shorten the body."

# A word is any mix of safe characters, single-quoted strings and \' (no $, `, ", ;, &,
# |, <, >, (, ), globs, ~ or #).
word="([A-Za-z0-9_.,:/=@%+-]|'[^']*'|\\\\')+"
pattern="^\\.github/scripts/health-gh\\.sh( +$word)* *\$"
[[ $command =~ $pattern ]] ||
  deny "Only .github/scripts/health-gh.sh may run, called once with plain words and single-quoted text (see .github/prompts/health.md)."
exit 0
