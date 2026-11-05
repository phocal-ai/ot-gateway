#!/usr/bin/env bash
# PreToolUse hook (Bash) for the scheduled routines that change code: the weekly
# dependency update (deps) and the CI failure triage (triage), set in
# .github/workflows/deps.yml and triage.yml.
#
#   routine-bash-guard.sh deps|triage   < hook input
#
# The agent may run:
# - read-only git: `git diff`, `git status`, `git log`, `git show` with plain words
#   (no --output, which writes a file)
# - code from the checkout only through .github/scripts/routine-run.sh, which runs it
#   as the unprivileged sandbox user with an empty environment, and only these
#   commands after it:
#     both:   pnpm install | check | format | lint | lint:fix | typecheck | test,
#             pnpm --filter @ot-gateway/<pkg> test | typecheck | build | exec vitest ...
#     deps:   pnpm outdated | view | update | up | add (with -w or --filter)
#     triage: SIM_SEEDS=… SIM_HOURS=… pnpm --filter @ot-gateway/gateway sim,
#             SOAK_<NAME>=<number> … scripts/soak.sh <n>m|<n>s
# Everything else is denied, including the read-only commands Claude Code runs
# without asking (cat, ls, echo, grep, find): files are read with the file tools.
# Arguments are plain words or single-quoted strings. scripts/test-routines.sh tests it.
set -euo pipefail

deny() {
  jq -n --arg reason "$1" \
    '{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason } }'
  exit 0
}

routine=${1:-}
case $routine in
  deps | triage) ;;
  *)
    echo "routine-bash-guard: the first argument is deps or triage" >&2
    exit 2
    ;;
esac

# Exit 2 blocks the call, so unreadable input fails closed.
command=$(jq -r '.tool_input.command // ""') || {
  echo "routine-bash-guard: could not read the hook input" >&2
  exit 2
}

[ "${#command}" -le 2000 ] || deny "Keep the command under 2,000 characters."

# A word is any mix of safe characters and single-quoted strings, and does not start
# with ~ (no $, `, ", ;, &, |, <, >, (, ), globs, # or line breaks). ^ and ~ inside a
# word are for version ranges such as effect@^4.1.3.
word="([A-Za-z0-9_.,:/=@%+^-]|'[^']*')([A-Za-z0-9_.,:/=@%+^~-]|'[^']*')*"
words="( +$word)*"
run='\.github/scripts/routine-run\.sh +'
pkg='@ot-gateway/[a-z][a-z0-9-]*'

patterns=(
  "^git +(diff|status|log|show)$words *\$"
  "^${run}pnpm +install( +--(frozen-lockfile|no-frozen-lockfile|lockfile-only|offline|prefer-offline))* *\$"
  "^${run}pnpm +(check|format|lint|lint:fix|typecheck|test)$words *\$"
  "^${run}pnpm +--filter +$pkg +(test|typecheck|build)$words *\$"
  "^${run}pnpm +--filter +$pkg +exec +vitest$words *\$"
)
case $routine in
  deps)
    patterns+=(
      "^${run}pnpm +(outdated|view|update|up)$words *\$"
      "^${run}pnpm +(-w|--filter +$pkg) +add$words *\$"
    )
    ;;
  triage)
    patterns+=(
      "^${run}(SIM_SEEDS=[0-9,]+ +|SIM_HOURS=[0-9]+ +)*pnpm +--filter +@ot-gateway/gateway +sim *\$"
      "^${run}(SOAK_[A-Z_]+=[0-9]+ +)*scripts/soak\\.sh +[0-9]+[ms] *\$"
    )
    ;;
esac

# git can write a file with --output; nothing else in the list writes outside the checkout.
if [[ $command =~ ^git ]] && [[ $command =~ (^|[[:space:]])--output ]]; then
  deny "git --output writes a file; read the diff instead."
fi

for pattern in "${patterns[@]}"; do
  [[ $command =~ $pattern ]] && exit 0
done
deny "Not allowed in the $routine routine. Run code through .github/scripts/routine-run.sh with one of the commands in .github/prompts/$routine.md, and read files with the Read, Grep and Glob tools."
